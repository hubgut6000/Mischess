'use strict';

const { spawn } = require('child_process');
const path = require('path');

/**
 * StockfishAnalyzer - manages a long-lived Stockfish child process for
 * post-game analysis. Pure UCI over stdio.
 *
 * The Stockfish binary is expected at process.env.STOCKFISH_PATH or simply 'stockfish'
 * on PATH. On Render, install it via the build command (see render.yaml).
 *
 * If no binary is available, analysis is skipped (no crash). The anti-cheat then
 * falls back to the heuristic signals (move timing, focus events) alone.
 */
class StockfishAnalyzer {
  constructor() {
    this.proc = null;
    this.available = false;
    this.ready = false;
    this._queue = []; // pending prompts
    this._current = null;
    this._buffer = '';
  }

  async init() {
    const binaryPath = process.env.STOCKFISH_PATH || 'stockfish';
    try {
      this.proc = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc.on('error', (err) => {
        console.warn('[stockfish] failed to spawn:', err.message);
        this.available = false;
        this.proc = null;
      });
      this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      this.proc.stderr.on('data', () => {}); // swallow
      this.proc.on('exit', () => { this.available = false; this.ready = false; this.proc = null; });

      // UCI handshake
      this._send('uci');
      await this._waitFor(line => line === 'uciok', 5000);
      this._send('setoption name Hash value 32');
      this._send('setoption name Threads value 1');
      this._send('isready');
      await this._waitFor(line => line === 'readyok', 5000);
      this.available = true;
      this.ready = true;
      console.log('[stockfish] analyzer ready');
    } catch (e) {
      console.warn('[stockfish] not available, skipping engine-based analysis:', e.message);
      this.available = false;
      if (this.proc) try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }

  _send(cmd) {
    if (!this.proc) return;
    try { this.proc.stdin.write(cmd + '\n'); } catch {}
  }

  _onStdout(chunk) {
    this._buffer += chunk.toString();
    let idx;
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    if (this._lineHandlers) {
      for (const h of this._lineHandlers.slice()) {
        try { h(line); } catch {}
      }
    }
  }

  _waitFor(predicate, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._removeHandler(handler);
        reject(new Error('timeout waiting for stockfish'));
      }, timeoutMs);
      const handler = (line) => {
        if (predicate(line)) {
          clearTimeout(timer);
          this._removeHandler(handler);
          resolve(line);
        }
      };
      this._addHandler(handler);
    });
  }

  _addHandler(fn) {
    if (!this._lineHandlers) this._lineHandlers = [];
    this._lineHandlers.push(fn);
  }

  _removeHandler(fn) {
    if (!this._lineHandlers) return;
    const i = this._lineHandlers.indexOf(fn);
    if (i >= 0) this._lineHandlers.splice(i, 1);
  }

  /**
   * Evaluate a single position at the given depth. Returns centipawn value
   * from the perspective of the side to move (positive = side to move is better).
   */
  async evaluate(fen, depth = 12) {
    if (!this.available) return null;
    return this._runExclusive(async () => {
      this._send('position fen ' + fen);
      this._send(`go depth ${depth}`);
      let lastCp = 0;
      let lastMate = null;
      const handler = (line) => {
        if (line.startsWith('info ')) {
          const cp = line.match(/score cp (-?\d+)/);
          const mate = line.match(/score mate (-?\d+)/);
          if (cp) { lastCp = parseInt(cp[1], 10); lastMate = null; }
          if (mate) { lastMate = parseInt(mate[1], 10); lastCp = null; }
        }
      };
      this._addHandler(handler);
      try {
        await this._waitFor(l => l.startsWith('bestmove'), 15000);
      } catch (e) {
        this._removeHandler(handler);
        return null;
      }
      this._removeHandler(handler);
      if (lastMate !== null) {
        // Convert mate score to a large centipawn value (positive if side to move mates)
        return lastMate > 0 ? 10000 : -10000;
      }
      return lastCp;
    });
  }

  _runExclusive(fn) {
    const prev = this._current || Promise.resolve();
    this._current = prev.then(() => fn().catch(() => null));
    return this._current;
  }

  shutdown() {
    if (this.proc) {
      try { this._send('quit'); } catch {}
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
    this.available = false;
  }
}

// Single shared instance
const analyzer = new StockfishAnalyzer();

// Kick off init at module load. Non-fatal if it fails.
analyzer.init().catch(() => {});

module.exports = { analyzer, StockfishAnalyzer };
