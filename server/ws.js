'use strict';

const WebSocket = require('ws');
const url = require('url');
const { verifyToken } = require('./auth');
const { getDb } = require('./db');
const {
  games, enqueue, leaveQueue, getUserActiveGame,
} = require('./gameManager');

// Per-user socket set (multi-tab support)
const userSockets = new Map(); // userId -> Set<ws>
// Track which game each socket is observing
const socketState = new WeakMap(); // ws -> { userId, username, watchingGameId }

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
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToGame(game, msg) {
  for (const ws of game.sockets) send(ws, msg);
  for (const ws of game.spectators) send(ws, msg);
}

function broadcastToUser(userId, msg) {
  const set = userSockets.get(userId);
  if (!set) return;
  for (const ws of set) send(ws, msg);
}

function initWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const query = url.parse(req.url, true).query;
    let user = null;
    if (query.token) {
      const data = verifyToken(query.token);
      if (data) user = data;
    }
    if (!user) {
      send(ws, { type: 'error', error: 'Authentication required' });
      ws.close();
      return;
    }

    // Load fresh user data (ratings)
    const db = getDb();
    const dbUser = db.prepare(`
      SELECT id, username, rating_bullet, rating_blitz, rating_rapid, rating_classical
      FROM users WHERE id = ?
    `).get(user.id);
    if (!dbUser) {
      send(ws, { type: 'error', error: 'User not found' });
      ws.close();
      return;
    }

    const state = { userId: dbUser.id, username: dbUser.username, watchingGameId: null };
    socketState.set(ws, state);
    addSocket(dbUser.id, ws);

    send(ws, { type: 'connected', username: dbUser.username, userId: dbUser.id });

    // Inform client if they have an active game — reconnect support
    const activeGame = getUserActiveGame(dbUser.id);
    if (activeGame) {
      activeGame.sockets.add(ws);
      state.watchingGameId = activeGame.id;
      send(ws, { type: 'gameStart', game: activeGame.snapshot(), yourColor: activeGame.playerColor(dbUser.id) });
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleMessage(ws, state, msg);
    });

    ws.on('close', () => {
      removeSocket(state.userId, ws);
      // Remove from any queues
      leaveQueue(state.userId);
      // Remove from game sockets
      if (state.watchingGameId) {
        const g = games.get(state.watchingGameId);
        if (g) {
          g.sockets.delete(ws);
          g.spectators.delete(ws);
        }
      }
    });

    ws.on('error', () => {});
  });

  // Periodic clock tick - broadcast clocks to all active games every 500ms
  setInterval(() => {
    for (const game of games.values()) {
      if (game.ended) continue;
      if (game.chess.history().length < 2) continue;
      // Send lightweight clock update
      const clocks = game.currentClocks();
      const payload = { type: 'clock', whiteTime: clocks.white, blackTime: clocks.black };
      broadcastToGame(game, payload);

      // Check for flag
      if (clocks.white === 0 || clocks.black === 0) {
        // force tick to apply end
        game._tickClock();
        if (game.ended) {
          broadcastToGame(game, { type: 'gameEnd', game: game.snapshot() });
        }
      }
    }
  }, 500);

  console.log('[ws] websocket server initialized on /ws');
}

function handleMessage(ws, state, msg) {
  switch (msg.type) {
    case 'ping':
      return send(ws, { type: 'pong', t: Date.now() });

    case 'seekGame': {
      // Leave any existing queue
      leaveQueue(state.userId);
      const { initialTime, increment, rated } = msg;
      const it = clampInt(initialTime, 60, 10800);
      const inc = clampInt(increment, 0, 60);
      const r = rated !== false;

      const db = getDb();
      const user = db.prepare(`
        SELECT rating_bullet, rating_blitz, rating_rapid, rating_classical
        FROM users WHERE id = ?
      `).get(state.userId);
      const cat = (it + 40 * inc < 180) ? 'rating_bullet'
        : (it + 40 * inc < 480) ? 'rating_blitz'
        : (it + 40 * inc < 1500) ? 'rating_rapid' : 'rating_classical';
      const rating = user[cat];

      const result = enqueue(ws, state.userId, state.username, rating, it, inc, r);
      if (result.matched) {
        const game = result.game;
        // Both sockets join game room
        game.sockets.add(result.whiteWs);
        game.sockets.add(result.blackWs);
        const whiteState = socketState.get(result.whiteWs);
        const blackState = socketState.get(result.blackWs);
        if (whiteState) whiteState.watchingGameId = game.id;
        if (blackState) blackState.watchingGameId = game.id;

        send(result.whiteWs, { type: 'gameStart', game: game.snapshot(), yourColor: 'white' });
        send(result.blackWs, { type: 'gameStart', game: game.snapshot(), yourColor: 'black' });
      } else {
        send(ws, { type: 'queued', key: result.queued });
      }
      return;
    }

    case 'cancelSeek': {
      leaveQueue(state.userId);
      send(ws, { type: 'queueCancelled' });
      return;
    }

    case 'move': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return send(ws, { type: 'error', error: 'Game not found' });
      const res = game.tryMove(state.userId, msg.move);
      if (res.error) return send(ws, { type: 'moveError', error: res.error });
      broadcastToGame(game, { type: 'move', game: game.snapshot(), lastMove: res.move });
      if (game.ended) {
        broadcastToGame(game, { type: 'gameEnd', game: game.snapshot() });
      }
      return;
    }

    case 'resign': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      const res = game.resign(state.userId);
      if (res.resigned) broadcastToGame(game, { type: 'gameEnd', game: game.snapshot() });
      return;
    }

    case 'abort': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      const res = game.abort(state.userId);
      if (res.aborted) broadcastToGame(game, { type: 'gameEnd', game: game.snapshot() });
      return;
    }

    case 'offerDraw': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      const res = game.offerDraw(state.userId);
      if (res.accepted) {
        broadcastToGame(game, { type: 'gameEnd', game: game.snapshot() });
      } else if (res.offered) {
        broadcastToGame(game, { type: 'drawOffered', from: game.playerColor(state.userId) });
      }
      return;
    }

    case 'declineDraw': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      const res = game.declineDraw(state.userId);
      if (res.declined) broadcastToGame(game, { type: 'drawDeclined' });
      return;
    }

    case 'chat': {
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      const text = String(msg.text || '').slice(0, 200).trim();
      if (!text) return;
      broadcastToGame(game, {
        type: 'chat',
        username: state.username,
        text,
        t: Date.now(),
      });
      return;
    }

    case 'spectate': {
      const game = games.get(msg.gameId);
      if (!game) return send(ws, { type: 'error', error: 'Game not found' });
      // Leave previous
      if (state.watchingGameId) {
        const prev = games.get(state.watchingGameId);
        if (prev) {
          prev.sockets.delete(ws);
          prev.spectators.delete(ws);
        }
      }
      game.spectators.add(ws);
      state.watchingGameId = game.id;
      send(ws, { type: 'gameStart', game: game.snapshot(), yourColor: null });
      return;
    }

    case 'leaveSpectate': {
      if (state.watchingGameId) {
        const g = games.get(state.watchingGameId);
        if (g) {
          g.sockets.delete(ws);
          g.spectators.delete(ws);
        }
        // Only clear if not a player
        if (g && g.playerColor(state.userId) === null) {
          state.watchingGameId = null;
        }
      }
      return;
    }

    case 'focusEvent': {
      // client reports blur/focus during game
      const game = games.get(state.watchingGameId || msg.gameId);
      if (!game) return;
      const color = game.playerColor(state.userId);
      if (!color) return;
      if (msg.event === 'blur' || msg.event === 'focus') {
        game.focusEvents[color].push({ type: msg.event, t: Date.now() });
      }
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
