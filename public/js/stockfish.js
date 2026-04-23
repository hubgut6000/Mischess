/**
 * StockfishEngine - wraps stockfish.js in a Web Worker.
 * Falls back gracefully to the built-in minimax AI if Stockfish can't load.
 *
 * Public API:
 *   const engine = new StockfishEngine();
 *   await engine.init();
 *   engine.setSkillLevel(10); // 0-20
 *   const move = await engine.getBestMove(fen, { depth: 12, movetime: 1500 });
 *   engine.terminate();
 */

// Stockfish is loaded from a CDN at runtime. We pick a version that works as a Web Worker
// out of the box (lila-style). If the CDN is unreachable we fall back to the local minimax.
const STOCKFISH_CDNS = [
  'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js',
  'https://unpkg.com/stockfish.js@10.0.2/stockfish.js',
];

import { findBestMove as fallbackFindBestMove } from './ai.js';

export class StockfishEngine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.pending = null; // { resolve, reject, bestmoveOnly }
    this.skillLevel = 10;
    this.elo = null;
    this.useFallback = false;
  }

  async init() {
    if (this.ready || this.useFallback) return;
    // Try each CDN. We can't direct-import the worker cross-origin, so we fetch the
    // script text and create a blob worker from it. This is the standard trick.
    for (const url of STOCKFISH_CDNS) {
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) continue;
        const text = await res.text();
        const blob = new Blob([text], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        this.worker = new Worker(blobUrl);
        this.worker.onmessage = (e) => this._onMessage(e.data);
        this.worker.onerror = () => { /* ignore, handled in promise */ };
        await this._uciHandshake();
        this.ready = true;
        return;
      } catch (e) {
        // try next CDN
      }
    }
    // All CDNs failed — use fallback
    this.useFallback = true;
    console.warn('[stockfish] failed to load, falling back to built-in minimax');
  }

  _uciHandshake() {
    return new Promise((resolve, reject) => {
      let got_uciok = false;
      const timeout = setTimeout(() => {
        if (!got_uciok) reject(new Error('UCI handshake timeout'));
      }, 8000);
      this._handshakeHandler = (msg) => {
        if (msg === 'uciok') {
          got_uciok = true;
          this._send('isready');
        } else if (msg === 'readyok' && got_uciok) {
          clearTimeout(timeout);
          this._handshakeHandler = null;
          resolve();
        }
      };
      this._send('uci');
    });
  }

  _send(cmd) {
    if (this.worker) this.worker.postMessage(cmd);
  }

  _onMessage(msg) {
    if (typeof msg !== 'string') return;
    if (this._handshakeHandler) this._handshakeHandler(msg);

    if (this.pending && msg.startsWith('bestmove')) {
      const parts = msg.split(/\s+/);
      const best = parts[1];
      const { resolve } = this.pending;
      this.pending = null;
      if (!best || best === '(none)') resolve(null);
      else resolve(best); // UCI format e.g. e2e4, e7e8q
    }

    // Track info lines (eval) for anti-cheat/analysis use
    if (msg.startsWith('info ') && this.onInfo) {
      this.onInfo(msg);
    }
  }

  setSkillLevel(level) {
    this.skillLevel = Math.max(0, Math.min(20, level | 0));
    if (this.ready) {
      this._send('setoption name Skill Level value ' + this.skillLevel);
    }
  }

  setElo(elo) {
    this.elo = elo ? Math.max(1320, Math.min(3190, elo | 0)) : null;
    if (!this.ready) return;
    if (this.elo) {
      this._send('setoption name UCI_LimitStrength value true');
      this._send('setoption name UCI_Elo value ' + this.elo);
    } else {
      this._send('setoption name UCI_LimitStrength value false');
    }
  }

  /**
   * Get best move for position. Resolves with UCI-style move string (e.g. 'e2e4', 'e7e8q')
   * or a move object if fallback is used.
   */
  async getBestMove(fen, { depth = 12, movetime = 1500 } = {}) {
    if (this.useFallback) {
      // Translate minimax output to UCI format
      return new Promise((resolve) => {
        // Run on next tick so UI doesn't freeze noticeably
        setTimeout(() => {
          const level = Math.max(1, Math.min(8, Math.round(this.skillLevel / 3) || 3));
          const move = fallbackFindBestMove(fen, level);
          if (!move) return resolve(null);
          const uci = (move.from || '') + (move.to || '') + (move.promotion || '');
          resolve(uci);
        }, 50);
      });
    }
    if (!this.ready) await this.init();
    if (this.useFallback) return this.getBestMove(fen, { depth, movetime });

    return new Promise((resolve, reject) => {
      if (this.pending) {
        // Cancel prior
        this._send('stop');
        this.pending.resolve(null);
      }
      this.pending = { resolve, reject };
      this._send('position fen ' + fen);
      // Use movetime + depth cap together — whichever finishes first
      this._send(`go depth ${depth} movetime ${movetime}`);
    });
  }

  /**
   * Evaluate a position (useful for analysis / anti-cheat). Returns {cp, mate, bestmove}.
   */
  async evaluate(fen, { depth = 14 } = {}) {
    if (this.useFallback) return { cp: 0, mate: null, bestmove: null };
    if (!this.ready) await this.init();

    let lastCp = 0;
    let lastMate = null;
    const prevInfo = this.onInfo;
    this.onInfo = (msg) => {
      const cpMatch = msg.match(/score cp (-?\d+)/);
      const mateMatch = msg.match(/score mate (-?\d+)/);
      if (cpMatch) lastCp = parseInt(cpMatch[1], 10);
      if (mateMatch) lastMate = parseInt(mateMatch[1], 10);
    };
    const bestmove = await this.getBestMove(fen, { depth, movetime: 2000 });
    this.onInfo = prevInfo;
    return { cp: lastCp, mate: lastMate, bestmove };
  }

  newGame() {
    if (this.ready) this._send('ucinewgame');
  }

  terminate() {
    if (this.worker) {
      try { this.worker.terminate(); } catch {}
      this.worker = null;
    }
    this.ready = false;
  }
}
