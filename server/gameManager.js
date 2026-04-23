'use strict';

const crypto = require('crypto');
const { Chess } = require('chess.js');
const { getDb } = require('./db');
const { eloUpdate } = require('./rating');
const { evaluateGame } = require('./anticheat');

// In-memory maps
const games = new Map(); // gameId -> Game
const userGame = new Map(); // userId -> gameId (active)
const queues = new Map(); // key -> [{ userId, username, rating, ws, joinedAt }]

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

function queueKey(initialSec, increment, rated) {
  return `${initialSec}+${increment}:${rated ? 'r' : 'c'}`;
}

class Game {
  constructor(opts) {
    this.id = opts.id;
    this.whiteId = opts.whiteId;
    this.blackId = opts.blackId;
    this.whiteName = opts.whiteName;
    this.blackName = opts.blackName;
    this.whiteRating = opts.whiteRating;
    this.blackRating = opts.blackRating;
    this.initialTime = opts.initialTime;  // seconds
    this.increment = opts.increment;      // seconds
    this.category = opts.category;
    this.timeControl = `${Math.floor(opts.initialTime / 60)}+${opts.increment}`;
    this.rated = opts.rated !== false;
    this.chess = new Chess();
    this.whiteTime = opts.initialTime * 1000; // ms
    this.blackTime = opts.initialTime * 1000;
    this.lastMoveAt = Date.now();
    this.startedAt = Date.now();
    this.ended = false;
    this.result = null;
    this.winner = null;
    this.termination = null;
    this.moveTimes = { white: [], black: [] };
    this.focusEvents = { white: [], black: [] };
    this.drawOffer = null; // 'white' | 'black' | null
    this.sockets = new Set();
    this.spectators = new Set();
  }

  turn() {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  playerColor(userId) {
    if (userId === this.whiteId) return 'white';
    if (userId === this.blackId) return 'black';
    return null;
  }

  // Apply clock, checking for flag
  _tickClock() {
    if (this.ended) return;
    const now = Date.now();
    const elapsed = now - this.lastMoveAt;
    const side = this.turn();
    if (side === 'white') this.whiteTime -= elapsed;
    else this.blackTime -= elapsed;
    this.lastMoveAt = now;
    if (this.whiteTime <= 0) {
      this.whiteTime = 0;
      this.endGame('0-1', 'black', 'timeout');
    } else if (this.blackTime <= 0) {
      this.blackTime = 0;
      this.endGame('1-0', 'white', 'timeout');
    }
  }

  currentClocks() {
    if (this.ended) return { white: this.whiteTime, black: this.blackTime };
    if (this.chess.history().length < 2) {
      // clock doesn't run until both players have moved once
      return { white: this.whiteTime, black: this.blackTime };
    }
    const now = Date.now();
    const elapsed = now - this.lastMoveAt;
    const side = this.turn();
    return {
      white: side === 'white' ? Math.max(0, this.whiteTime - elapsed) : this.whiteTime,
      black: side === 'black' ? Math.max(0, this.blackTime - elapsed) : this.blackTime,
    };
  }

  tryMove(userId, move) {
    if (this.ended) return { error: 'Game ended' };
    const color = this.playerColor(userId);
    if (!color) return { error: 'Not a player' };
    if (color !== this.turn()) return { error: 'Not your turn' };

    // Check flag before move
    this._tickClock();
    if (this.ended) return { error: 'Game ended on time' };

    const now = Date.now();
    const thinkMs = this.chess.history().length >= 2 ? (now - this.lastMoveAt) : 0;

    let result;
    try {
      result = this.chess.move(move);
    } catch (e) {
      return { error: 'Illegal move' };
    }
    if (!result) return { error: 'Illegal move' };

    // Apply increment
    if (this.chess.history().length >= 2) {
      if (color === 'white') this.whiteTime += this.increment * 1000;
      else this.blackTime += this.increment * 1000;
    }

    this.moveTimes[color].push(thinkMs);
    this.lastMoveAt = now;
    this.drawOffer = null; // move cancels any draw offer

    // Log move telemetry
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO move_telemetry (game_id, user_id, ply, think_ms, san, fen, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.id, userId, this.chess.history().length, thinkMs,
        result.san, this.chess.fen(), now
      );
    } catch (e) { /* non-fatal */ }

    // Check termination
    if (this.chess.isCheckmate()) {
      const winnerColor = color;
      const resStr = winnerColor === 'white' ? '1-0' : '0-1';
      this.endGame(resStr, winnerColor, 'checkmate');
    } else if (this.chess.isStalemate()) {
      this.endGame('1/2-1/2', null, 'stalemate');
    } else if (this.chess.isThreefoldRepetition()) {
      this.endGame('1/2-1/2', null, 'repetition');
    } else if (this.chess.isInsufficientMaterial()) {
      this.endGame('1/2-1/2', null, 'insufficient_material');
    } else if (this.chess.isDraw()) {
      this.endGame('1/2-1/2', null, 'fifty_move_rule');
    }

    return { move: result, thinkMs };
  }

  offerDraw(userId) {
    const color = this.playerColor(userId);
    if (!color) return { error: 'Not a player' };
    if (this.ended) return { error: 'Game ended' };
    if (this.drawOffer === color) return { error: 'Already offered' };
    if (this.drawOffer && this.drawOffer !== color) {
      // Accept existing offer
      this.endGame('1/2-1/2', null, 'agreement');
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
    const winnerColor = color === 'white' ? 'black' : 'white';
    const resStr = winnerColor === 'white' ? '1-0' : '0-1';
    this.endGame(resStr, winnerColor, 'resignation');
    return { resigned: true };
  }

  abort(userId) {
    const color = this.playerColor(userId);
    if (!color) return { error: 'Not a player' };
    if (this.chess.history().length >= 2) return { error: 'Too late to abort' };
    this.endGame(null, null, 'aborted');
    return { aborted: true };
  }

  endGame(result, winner, termination) {
    if (this.ended) return;
    this.ended = true;
    this.result = result;
    this.winner = winner;
    this.termination = termination;
    this.endedAt = Date.now();

    // Remove user-active mapping
    if (this.whiteId) userGame.delete(this.whiteId);
    if (this.blackId) userGame.delete(this.blackId);

    // Rating update + persist
    const db = getDb();
    let whiteRatingAfter = this.whiteRating;
    let blackRatingAfter = this.blackRating;

    if (termination !== 'aborted' && this.rated && this.whiteId && this.blackId) {
      let whiteScore;
      if (result === '1-0') whiteScore = 1;
      else if (result === '0-1') whiteScore = 0;
      else whiteScore = 0.5;

      const kW = this._kFactor(this.whiteId);
      const kB = this._kFactor(this.blackId);
      whiteRatingAfter = eloUpdate(this.whiteRating, this.blackRating, whiteScore, kW);
      blackRatingAfter = eloUpdate(this.blackRating, this.whiteRating, 1 - whiteScore, kB);

      const col = `rating_${this.category}`;
      const updateUser = db.prepare(`
        UPDATE users SET
          ${col} = ?,
          games_played = games_played + 1,
          wins = wins + ?,
          losses = losses + ?,
          draws = draws + ?,
          last_seen = ?
        WHERE id = ?
      `);
      updateUser.run(whiteRatingAfter,
        whiteScore === 1 ? 1 : 0, whiteScore === 0 ? 1 : 0, whiteScore === 0.5 ? 1 : 0,
        Date.now(), this.whiteId);
      updateUser.run(blackRatingAfter,
        whiteScore === 0 ? 1 : 0, whiteScore === 1 ? 1 : 0, whiteScore === 0.5 ? 1 : 0,
        Date.now(), this.blackId);
    }

    // Save game
    try {
      db.prepare(`
        INSERT INTO games (
          id, white_id, black_id, white_name, black_name,
          time_control, initial_time, increment, category, rated,
          result, winner, termination, pgn, moves, final_fen,
          white_rating_before, black_rating_before,
          white_rating_after, black_rating_after,
          started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.id, this.whiteId, this.blackId, this.whiteName, this.blackName,
        this.timeControl, this.initialTime, this.increment, this.category, this.rated ? 1 : 0,
        this.result, this.winner, this.termination,
        this.chess.pgn(), JSON.stringify(this.chess.history()), this.chess.fen(),
        this.whiteRating, this.blackRating,
        whiteRatingAfter, blackRatingAfter,
        this.startedAt, this.endedAt
      );
    } catch (e) {
      console.error('[game save]', e);
    }

    // Anti-cheat analysis (async)
    setImmediate(() => {
      try {
        if (this.whiteId) evaluateGame(this.id, this.whiteId, this.moveTimes.white, this.focusEvents.white);
        if (this.blackId) evaluateGame(this.id, this.blackId, this.moveTimes.black, this.focusEvents.black);
      } catch (e) {
        console.error('[anticheat]', e);
      }
    });

    this.whiteRatingAfter = whiteRatingAfter;
    this.blackRatingAfter = blackRatingAfter;

    // Clean up after 10 minutes (keep briefly for analysis/reconnect)
    setTimeout(() => {
      games.delete(this.id);
    }, 10 * 60 * 1000);
  }

  _kFactor(userId) {
    const db = getDb();
    const row = db.prepare('SELECT games_played FROM users WHERE id = ?').get(userId);
    if (!row) return 32;
    if (row.games_played < 30) return 40;
    const ratingCol = `rating_${this.category}`;
    const r = db.prepare(`SELECT ${ratingCol} AS r FROM users WHERE id = ?`).get(userId);
    if (r && r.r >= 2400) return 16;
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
      fen: this.chess.fen(),
      pgn: this.chess.pgn(),
      moves: this.chess.history({ verbose: false }),
      turn: this.turn(),
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
 * Add a user to the matchmaking queue; if someone is there, create a game.
 */
function enqueue(ws, userId, username, rating, initialTime, increment, rated = true) {
  const key = queueKey(initialTime, increment, rated);
  if (!queues.has(key)) queues.set(key, []);
  const q = queues.get(key);

  // Remove existing entry for this user
  for (const list of queues.values()) {
    const idx = list.findIndex(e => e.userId === userId);
    if (idx >= 0) list.splice(idx, 1);
  }

  // Find a match — prefer closest rating
  if (q.length > 0) {
    // Pick the opponent with closest rating (simple approach)
    q.sort((a, b) => Math.abs(a.rating - rating) - Math.abs(b.rating - rating));
    const opp = q.shift();
    // Randomize colors
    const whiteFirst = Math.random() < 0.5;
    const white = whiteFirst
      ? { userId, username, rating, ws }
      : opp;
    const black = whiteFirst
      ? opp
      : { userId, username, rating, ws };

    const game = new Game({
      id: gameId(),
      whiteId: white.userId,
      blackId: black.userId,
      whiteName: white.username,
      blackName: black.username,
      whiteRating: white.rating,
      blackRating: black.rating,
      initialTime,
      increment,
      category: categoryFor(initialTime, increment),
      rated,
    });
    games.set(game.id, game);
    userGame.set(white.userId, game.id);
    userGame.set(black.userId, game.id);
    return { matched: true, game, whiteWs: white.ws, blackWs: black.ws };
  }

  q.push({ userId, username, rating, ws, joinedAt: Date.now() });
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

function challengeUser(challenger, challenged, initialTime, increment, rated) {
  // Friend challenge — direct game creation
  const whiteFirst = Math.random() < 0.5;
  const white = whiteFirst ? challenger : challenged;
  const black = whiteFirst ? challenged : challenger;
  const game = new Game({
    id: gameId(),
    whiteId: white.userId,
    blackId: black.userId,
    whiteName: white.username,
    blackName: black.username,
    whiteRating: white.rating,
    blackRating: black.rating,
    initialTime,
    increment,
    category: categoryFor(initialTime, increment),
    rated,
  });
  games.set(game.id, game);
  userGame.set(white.userId, game.id);
  userGame.set(black.userId, game.id);
  return game;
}

module.exports = {
  games,
  userGame,
  queues,
  enqueue,
  leaveQueue,
  getUserActiveGame,
  Game,
  challengeUser,
};
