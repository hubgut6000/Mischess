'use strict';

const WebSocket = require('ws');
const url = require('url');
const { verifyToken } = require('./auth');
const { query, one } = require('./db/pool');
const { games, enqueue, leaveQueue, getUserActiveGame, createDirectGame } = require('./gameManager');

const userSockets = new Map();
const socketState = new WeakMap();
const userToSocket = new Map(); // userId -> ws (for finding online users)

function addSocket(userId, ws) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(ws);
}

function removeSocket(userId, ws) {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userSockets.delete(userId);
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastToGame(game, msg) {
  for (const ws of game.sockets) send(ws, msg);
  for (const ws of game.spectators) send(ws, msg);
}

function initWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    const q = url.parse(req.url, true).query;
    let user = null;
    if (q.token) {
      const data = verifyToken(q.token);
      if (data) user = data;
    }
    if (!user) { send(ws, { type: 'error', error: 'Authentication required' }); ws.close(); return; }

    const dbUser = await one(
      `SELECT id, username, is_flagged,
              rating_bullet, rating_blitz, rating_rapid, rating_classical
       FROM users WHERE id = $1`,
      [user.id]
    );
    if (!dbUser) { send(ws, { type: 'error', error: 'User not found' }); ws.close(); return; }

    const state = {
      userId: dbUser.id,
      username: dbUser.username,
      flagged: !!dbUser.is_flagged,
      watchingGameId: null,
    };
    socketState.set(ws, state);
    userToSocket.set(dbUser.id, ws);
    addSocket(dbUser.id, ws);

    send(ws, { type: 'connected', username: dbUser.username, userId: dbUser.id });

    const active = getUserActiveGame(dbUser.id);
    if (active) {
      active.sockets.add(ws);
      state.watchingGameId = active.id;
      send(ws, { type: 'gameStart', game: active.snapshot(), yourColor: active.playerColor(dbUser.id) });
    }

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleMessage(ws, state, msg, dbUser);
    });

    ws.on('close', () => {
      removeSocket(state.userId, ws);
      // Only remove userToSocket if this is still the registered ws (handles reconnects)
      if (userToSocket.get(state.userId) === ws) userToSocket.delete(state.userId);
      leaveQueue(state.userId);
      if (state.watchingGameId) {
        const g = games.get(state.watchingGameId);
        if (g) { g.sockets.delete(ws); g.spectators.delete(ws); }
      }
    });
    ws.on('error', () => {});
  });

  // Clock tick loop - 500ms. Also checks for timeout flags.
  setInterval(() => {
    for (const game of games.values()) {
      if (game.ended) continue;
      if (game.core.history().length < 2) continue;
      const clocks = game.currentClocks();
      broadcastToGame(game, { type: 'clock', whiteTime: clocks.white, blackTime: clocks.black });
      if (clocks.white === 0 || clocks.black === 0) {
        game._tickClock();
        if (game.ended) broadcastToGame(game, { type: 'gameEnd', game: game.snapshot() });
      }
    }
  }, 500);

  console.log('[ws] websocket server initialized on /ws');
}

async function handleMessage(ws, state, msg, dbUser) {
  switch (msg.type) {
    case 'ping':
      return send(ws, { type: 'pong', t: Date.now() });

    case 'seekGame': {
      leaveQueue(state.userId);
      const it = clampInt(msg.initialTime, 60, 10800);
      const inc = clampInt(msg.increment, 0, 60);
      let r = msg.rated !== false;

      // Refresh user flagged status (may have changed mid-session)
      const fresh = await one('SELECT is_flagged, rating_bullet, rating_blitz, rating_rapid, rating_classical FROM users WHERE id = $1', [state.userId]);
      state.flagged = !!fresh.is_flagged;

      // Check for active restrictions blocking rated play
      if (r) {
        const restriction = await one(
          `SELECT reason, expires_at FROM restrictions
           WHERE user_id = $1 AND active = true AND kind = 'no_rated'
             AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY created_at DESC LIMIT 1`,
          [state.userId]
        );
        if (restriction) {
          return send(ws, {
            type: 'restricted',
            reason: restriction.reason,
            expires: restriction.expires_at,
          });
        }
      }

      const cat = (it + 40 * inc < 180) ? 'rating_bullet'
        : (it + 40 * inc < 480) ? 'rating_blitz'
        : (it + 40 * inc < 1500) ? 'rating_rapid' : 'rating_classical';
      const rating = fresh[cat];

      const result = enqueue(ws, {
        userId: state.userId, username: state.username, rating, flagged: state.flagged,
      }, it, inc, r);
      if (result.matched) {
        const game = result.game;
        game.sockets.add(result.whiteWs);
        game.sockets.add(result.blackWs);
        const ws1 = socketState.get(result.whiteWs);
        const ws2 = socketState.get(result.blackWs);
        if (ws1) ws1.watchingGameId = game.id;
        if (ws2) ws2.watchingGameId = game.id;
        send(result.whiteWs, { type: 'gameStart', game: game.snapshot(), yourColor: 'white' });
        send(result.blackWs, { type: 'gameStart', game: game.snapshot(), yourColor: 'black' });
      } else {
        send(ws, { type: 'queued', key: result.queued });
      }
      return;
    }

    case 'cancelSeek':
      leaveQueue(state.userId);
      return send(ws, { type: 'queueCancelled' });

    case 'acceptChallenge': {
      const challengeId = parseInt(msg.challengeId, 10);
      if (!challengeId) return send(ws, { type: 'error', error: 'Invalid challenge id' });

      const ch = await one(
        `SELECT * FROM challenges
         WHERE id = $1 AND to_id = $2 AND status = 'accepted'`,
        [challengeId, state.userId]
      );
      if (!ch) return send(ws, { type: 'error', error: 'Challenge not found' });

      // Find the challenger's WS connection
      const challengerWs = userToSocket.get(ch.from_id);
      if (!challengerWs || challengerWs.readyState !== 1) {
        return send(ws, { type: 'error', error: 'Challenger is offline' });
      }
      const challengerState = socketState.get(challengerWs);
      if (!challengerState) {
        return send(ws, { type: 'error', error: 'Challenger session expired' });
      }

      // Decide colors
      let whiteId, whiteWs, blackId, blackWs, whiteName, blackName;
      const color = ch.color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : ch.color;
      // 'color' is from challenger's perspective
      if (color === 'white') {
        whiteId = ch.from_id; whiteWs = challengerWs; whiteName = challengerState.username;
        blackId = ch.to_id; blackWs = ws; blackName = state.username;
      } else {
        whiteId = ch.to_id; whiteWs = ws; whiteName = state.username;
        blackId = ch.from_id; blackWs = challengerWs; blackName = challengerState.username;
      }

      // Get ratings
      const [whiteUser, blackUser] = await Promise.all([
        one('SELECT rating_bullet, rating_blitz, rating_rapid, rating_classical FROM users WHERE id = $1', [whiteId]),
        one('SELECT rating_bullet, rating_blitz, rating_rapid, rating_classical FROM users WHERE id = $1', [blackId]),
      ]);
      const it = ch.initial_time, inc = ch.increment;
      const cat = (it + 40 * inc < 180) ? 'bullet'
        : (it + 40 * inc < 480) ? 'blitz'
        : (it + 40 * inc < 1500) ? 'rapid' : 'classical';
      const whiteRating = whiteUser[`rating_${cat}`];
      const blackRating = blackUser[`rating_${cat}`];

      const game = createDirectGame({
        whiteId, whiteName, whiteRating,
        blackId, blackName, blackRating,
        initialTime: ch.initial_time, increment: ch.increment, rated: ch.rated,
      });
      game.sockets.add(whiteWs);
      game.sockets.add(blackWs);
      const ws1 = socketState.get(whiteWs);
      const ws2 = socketState.get(blackWs);
      if (ws1) ws1.watchingGameId = game.id;
      if (ws2) ws2.watchingGameId = game.id;

      await query(`UPDATE challenges SET game_id = $1, status = 'completed' WHERE id = $2`,
        [game.id, ch.id]);

      send(whiteWs, { type: 'gameStart', game: game.snapshot(), yourColor: 'white' });
      send(blackWs, { type: 'gameStart', game: game.snapshot(), yourColor: 'black' });
      return;
    }

    case 'move': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return send(ws, { type: 'error', error: 'Game not found' });
      const res = game.tryMove(state.userId, msg.move);
      if (res.error) return send(ws, { type: 'moveError', error: res.error });
      broadcastToGame(game, { type: 'move', game: game.snapshot(), lastMove: res.move });
      if (game.ended) broadcastToGame(game, { type: 'gameEnd', game: game.snapshot() });
      return;
    }

    case 'resign': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      if (game.resign(state.userId).resigned) broadcastToGame(game, { type: 'gameEnd', game: game.snapshot() });
      return;
    }

    case 'abort': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      if (game.abort(state.userId).aborted) broadcastToGame(game, { type: 'gameEnd', game: game.snapshot() });
      return;
    }

    case 'offerDraw': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      const r = game.offerDraw(state.userId);
      if (r.accepted) broadcastToGame(game, { type: 'gameEnd', game: game.snapshot() });
      else if (r.offered) broadcastToGame(game, { type: 'drawOffered', from: game.playerColor(state.userId) });
      return;
    }

    case 'declineDraw': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      if (game.declineDraw(state.userId).declined) broadcastToGame(game, { type: 'drawDeclined' });
      return;
    }

    case 'chat': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      const text = String(msg.text || '').slice(0, 200).trim();
      if (!text) return;
      broadcastToGame(game, { type: 'chat', username: state.username, text, t: Date.now() });
      return;
    }

    case 'spectate': {
      const game = games.get(msg.gameId);
      if (!game) return send(ws, { type: 'error', error: 'Game not found' });
      if (state.watchingGameId) {
        const prev = games.get(state.watchingGameId);
        if (prev) { prev.sockets.delete(ws); prev.spectators.delete(ws); }
      }
      game.spectators.add(ws);
      state.watchingGameId = game.id;
      return send(ws, { type: 'gameStart', game: game.snapshot(), yourColor: null });
    }

    case 'leaveSpectate': {
      if (state.watchingGameId) {
        const g = games.get(state.watchingGameId);
        if (g) { g.sockets.delete(ws); g.spectators.delete(ws); }
        if (g && g.playerColor(state.userId) === null) state.watchingGameId = null;
      }
      return;
    }

    case 'focusEvent': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      const color = game.playerColor(state.userId);
      if (!color) return;
      if (msg.event !== 'blur' && msg.event !== 'focus') return;
      query(
        `INSERT INTO focus_events (game_id, user_id, event_type) VALUES ($1, $2, $3)`,
        [game.id, state.userId, msg.event]
      ).catch(() => {});
      return;
    }

    case 'telemetry': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      const color = game.playerColor(state.userId);
      if (!color) return;
      const eventType = String(msg.event || '').slice(0, 40);
      if (!eventType) return;
      // Write to focus_events table with synthetic type name (reuses the table)
      query(
        `INSERT INTO focus_events (game_id, user_id, event_type) VALUES ($1, $2, $3)`,
        [game.id, state.userId, 'ac:' + eventType]
      ).catch(() => {});
      return;
    }

    default:
      send(ws, { type: 'error', error: 'Unknown message type' });
  }
}

function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

module.exports = { initWebSocket };
