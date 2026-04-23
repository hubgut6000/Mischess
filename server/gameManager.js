'use strict';

const crypto = require('crypto');
const { GameCore } = require('./gameCore');
const { query, one, tx } = require('./db/pool');
const { eloUpdate } = require('./rating');
const { enqueueAnalysis } = require('./anticheat');

// In-memory maps — ephemeral, OK if they reset on deploy because only live games rely on them.
const games = new Map();     // gameId -> GameSession
const userGame = new Map();  // userId -> gameId
const queues = new Map();    // queueKey -> [{ userId, username, rating, flagged, ws, joinedAt }]

function gameId() {
  return crypto.randomBytes(5).toString('hex');
}

function categoryFor(initialSec, increment) {
  const estimated = initialSec + 40 * increment;
  if (estimated < 180) return 'bullet';
  if (estimated < 480) return 'blitz';
  if (estimated < 1500) return 'rapid';
  return 'classical';
}

/**
 * Queue keys include flagged bucket to shadow-pool cheaters.
 * Flagged users only match with other flagged users.
 */
function queueKey(initialSec, increment, rated, flaggedBucket) {
  return `${initialSec}+${increment}:${rated ? 'r' : 'c'}:${flaggedBucket ? 'f' : 'c'}`;
}

/**
 * GameSession composes GameCore with clocks, telemetry, lifecycle.
 */
class GameSession {
  constructor(opts) {
    this.id = opts.id;
    this.whiteId = opts.whiteId;
    this.blackId = opts.blackId;
    this.whiteName = opts.whiteName;
    this.blackName = opts.blackName;
    this.whiteRating = opts.whiteRating;
    this.blackRating = opts.blackRating;
    this.initialTime = opts.initialTime;
    this.increment = opts.increment;
    this.category = opts.category;
    this.timeControl = `${Math.floor(opts.initialTime / 60)}+${opts.increment}`;
    this.rated = opts.rated !== false;
    this.core = new GameCore();
    this.whiteTime = opts.initialTime * 1000;
    this.blackTime = opts.initialTime * 1000;
    this.lastMoveAt = Date.now();
    this.startedAt = Date.now();
    this.ended = false;
    this.result = null;
    this.winner = null;
    this.termination = null;
    this.moveTimes = { white: [], black: [] };
    this.drawOffer = null;
    this.sockets = new Set();
    this.spectators = new Set();
  }

  playerColor(userId) {
    if (userId === this.whiteId) return 'white';
    if (userId === this.blackId) return 'black';
    return null;
  }

  _tickClock() {
    if (this.ended) return;
    const now = Date.now();
    const elapsed = now - this.lastMoveAt;
    const side = this.core.turn;
    if (this.core.history().length < 2) {
      this.lastMoveAt = now;
      return;
    }
    if (side === 'white') this.whiteTime -= elapsed;
    else this.blackTime -= elapsed;
    this.lastMoveAt = now;
    if (this.whiteTime <= 0) { this.whiteTime = 0; this._endGame('0-1', 'black', 'timeout'); }
    else if (this.blackTime <= 0) { this.blackTime = 0; this._endGame('1-0', 'white', 'timeout'); }
  }

  currentClocks() {
    if (this.ended || this.core.history().length < 2) {
      return { white: this.whiteTime, black: this.blackTime };
    }
    const now = Date.now();
    const elapsed = now - this.lastMoveAt;
    const side = this.core.turn;
    return {
      white: side === 'white' ? Math.max(0, this.whiteTime - elapsed) : this.whiteTime,
      black: side === 'black' ? Math.max(0, this.blackTime - elapsed) : this.blackTime,
    };
  }

  tryMove(userId, move) {
    if (this.ended) return { error: 'Game ended' };
    const color = this.playerColor(userId);
    if (!color) return { error: 'Not a player' };
    if (color !== this.core.turn) return { error: 'Not your turn' };
    this._tickClock();
    if (this.ended) return { error: 'Game ended on time' };

    const now = Date.now();
    const thinkMs = this.core.history().length >= 2 ? (now - this.lastMoveAt) : 0;

    const res = this.core.tryMove(move);
    if (!res) return { error: 'Illegal move' };

    if (this.core.history().length >= 2) {
      if (color === 'white') this.whiteTime += this.increment * 1000;
      else this.blackTime += this.increment * 1000;
    }
    this.moveTimes[color].push(thinkMs);
    this.lastMoveAt = now;
    this.drawOffer = null;

    // Log telemetry asynchronously (non-blocking)
    const ply = this.core.history().length;
    const fen = this.core.fen;
    const san = res.san;
    query(
      `INSERT INTO move_telemetry (game_id, user_id, color, ply, think_ms, san, fen) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [this.id, userId, color, ply, thinkMs, san, fen]
    ).catch(() => {});

    const term = this.core.terminationInfo();
    if (term.ended) this._endGame(term.result, term.winner, term.termination);

    return { move: res, thinkMs };
  }

  offerDraw(userId) {
    const color = this.playerColor(userId);
    if (!color) return { error: 'Not a player' };
    if (this.ended) return { error: 'Game ended' };
    if (this.drawOffer === color) return { error: 'Already offered' };
    if (this.drawOffer && this.drawOffer !== color) {
      this._endGame('1/2-1/2', null, 'agreement');
      return { accepted: true };
    }
    this.drawOffer = color;
    return { offered: true };
  }

  declineDraw(userId) {
    const color = this.playerColor(userId);
    if (!color) return { error: 'Not a player' };
    if (this.drawOffer && this.drawOffer !== color) {
      this.drawOffer = null;
      return { declined: true };
    }
    return { error: 'No draw to decline' };
  }

  resign(userId) {
    const color = this.playerColor(userId);
    if (!color) return { error: 'Not a player' };
    if (this.ended) return { error: 'Game ended' };
    const winner = color === 'white' ? 'black' : 'white';
    const result = winner === 'white' ? '1-0' : '0-1';
    this._endGame(result, winner, 'resignation');
    return { resigned: true };
  }

  abort(userId) {
    const color = this.playerColor(userId);
    if (!color) return { error: 'Not a player' };
    if (this.core.history().length >= 2) return { error: 'Too late to abort' };
    this._endGame(null, null, 'aborted');
    return { aborted: true };
  }

  async _endGame(result, winner, termination) {
    if (this.ended) return;
    this.ended = true;
    this.result = result;
    this.winner = winner;
    this.termination = termination;
    this.endedAt = Date.now();

    if (this.whiteId) userGame.delete(this.whiteId);
    if (this.blackId) userGame.delete(this.blackId);

    let whiteRatingAfter = this.whiteRating;
    let blackRatingAfter = this.blackRating;

    if (termination !== 'aborted' && this.rated && this.whiteId && this.blackId) {
      let whiteScore;
      if (result === '1-0') whiteScore = 1;
      else if (result === '0-1') whiteScore = 0;
      else whiteScore = 0.5;

      const kW = await this._kFactor(this.whiteId);
      const kB = await this._kFactor(this.blackId);
      whiteRatingAfter = eloUpdate(this.whiteRating, this.blackRating, whiteScore, kW);
      blackRatingAfter = eloUpdate(this.blackRating, this.whiteRating, 1 - whiteScore, kB);

      const col = `rating_${this.category}`;
      await tx(async (client) => {
        await client.query(
          `UPDATE users SET ${col} = $1, games_played = games_played + 1,
             wins = wins + $2, losses = losses + $3, draws = draws + $4, last_seen = NOW()
             WHERE id = $5`,
          [whiteRatingAfter, whiteScore === 1 ? 1 : 0, whiteScore === 0 ? 1 : 0, whiteScore === 0.5 ? 1 : 0, this.whiteId]
        );
        await client.query(
          `UPDATE users SET ${col} = $1, games_played = games_played + 1,
             wins = wins + $2, losses = losses + $3, draws = draws + $4, last_seen = NOW()
             WHERE id = $5`,
          [blackRatingAfter, whiteScore === 0 ? 1 : 0, whiteScore === 1 ? 1 : 0, whiteScore === 0.5 ? 1 : 0, this.blackId]
        );
      }).catch(err => console.error('[game rating update]', err));
    }

    // Persist game record
    const endedAt = new Date();
    await query(
      `INSERT INTO games (
         id, white_id, black_id, white_name, black_name,
         time_control, initial_time, increment, category, rated,
         result, winner, termination, pgn, moves, final_fen,
         white_rating_before, black_rating_before, white_rating_after, black_rating_after,
         started_at, ended_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22)`,
      [
        this.id, this.whiteId, this.blackId, this.whiteName, this.blackName,
        this.timeControl, this.initialTime, this.increment, this.category, this.rated,
        this.result, this.winner, this.termination, this.core.pgn,
        JSON.stringify(this.core.history()), this.core.fen,
        this.whiteRating, this.blackRating, whiteRatingAfter, blackRatingAfter,
        new Date(this.startedAt), endedAt,
      ]
    ).catch(err => console.error('[game save]', err));

    this.whiteRatingAfter = whiteRatingAfter;
    this.blackRatingAfter = blackRatingAfter;

    // Kick the anti-cheat analysis queue
    if (this.rated) enqueueAnalysis(this.id);

    // Clean up from memory after 10 min (reconnect + spectate window)
    setTimeout(() => games.delete(this.id), 10 * 60 * 1000);
  }

  async _kFactor(userId) {
    const row = await one('SELECT games_played, rating_bullet, rating_blitz, rating_rapid, rating_classical FROM users WHERE id = $1', [userId]);
    if (!row) return 32;
    if (row.games_played < 30) return 40;
    const r = row[`rating_${this.category}`];
    if (r >= 2400) return 16;
    return 20;
  }

  snapshot() {
    const clocks = this.currentClocks();
    return {
      id: this.id,
      white: this.whiteName,
      black: this.blackName,
      whiteRating: this.whiteRating,
      blackRating: this.blackRating,
      whiteRatingAfter: this.whiteRatingAfter,
      blackRatingAfter: this.blackRatingAfter,
      category: this.category,
      timeControl: this.timeControl,
      rated: this.rated,
      fen: this.core.fen,
      pgn: this.core.pgn,
      moves: this.core.history(),
      turn: this.core.turn,
      whiteTime: clocks.white,
      blackTime: clocks.black,
      drawOffer: this.drawOffer,
      ended: this.ended,
      result: this.result,
      winner: this.winner,
      termination: this.termination,
    };
  }
}

/**
 * Matchmaking entry point. Shadow-pools flagged users.
 */
function enqueue(ws, { userId, username, rating, flagged }, initialTime, increment, rated = true) {
  const key = queueKey(initialTime, increment, rated, flagged);
  if (!queues.has(key)) queues.set(key, []);
  const q = queues.get(key);

  // Remove any existing entry for this user across all queues
  for (const list of queues.values()) {
    const idx = list.findIndex(e => e.userId === userId);
    if (idx >= 0) list.splice(idx, 1);
  }

  if (q.length > 0) {
    q.sort((a, b) => Math.abs(a.rating - rating) - Math.abs(b.rating - rating));
    const opp = q.shift();
    const whiteFirst = Math.random() < 0.5;
    const white = whiteFirst ? { userId, username, rating, ws } : opp;
    const black = whiteFirst ? opp : { userId, username, rating, ws };

    const session = new GameSession({
      id: gameId(),
      whiteId: white.userId,
      blackId: black.userId,
      whiteName: white.username,
      blackName: black.username,
      whiteRating: white.rating,
      blackRating: black.rating,
      initialTime, increment,
      category: categoryFor(initialTime, increment),
      rated,
    });
    games.set(session.id, session);
    userGame.set(white.userId, session.id);
    userGame.set(black.userId, session.id);
    return { matched: true, game: session, whiteWs: white.ws, blackWs: black.ws };
  }

  q.push({ userId, username, rating, flagged, ws, joinedAt: Date.now() });
  return { matched: false, queued: key };
}

function leaveQueue(userId) {
  for (const list of queues.values()) {
    const idx = list.findIndex(e => e.userId === userId);
    if (idx >= 0) list.splice(idx, 1);
  }
}

function getUserActiveGame(userId) {
  const gid = userGame.get(userId);
  if (!gid) return null;
  return games.get(gid) || null;
}

module.exports = {
  games, userGame, queues,
  enqueue, leaveQueue, getUserActiveGame,
  GameSession,
};
