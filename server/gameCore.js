'use strict';

const { Chess } = require('chess.js');

/**
 * GameCore - pure chess logic wrapper.
 *
 * Responsibility: move validation, turn management, termination detection,
 * FEN/PGN, clock arithmetic. Nothing else.
 *
 * No database, no network, no persistence. GameSession (in gameManager)
 * composes GameCore with clocks, telemetry, and lifecycle.
 */
class GameCore {
  constructor(fen) {
    this.chess = fen ? new Chess(fen) : new Chess();
  }

  get turn() {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  get fen() { return this.chess.fen(); }
  get pgn() { return this.chess.pgn(); }

  history(verbose = false) {
    return this.chess.history(verbose ? { verbose: true } : undefined);
  }

  /**
   * Apply a move. Returns the move object if legal, or null if illegal.
   */
  tryMove(move) {
    try {
      const res = this.chess.move(move);
      return res || null;
    } catch (e) {
      return null;
    }
  }

  isCheckmate() { return this.chess.isCheckmate(); }
  isStalemate() { return this.chess.isStalemate(); }
  isThreefoldRepetition() { return this.chess.isThreefoldRepetition(); }
  isInsufficientMaterial() { return this.chess.isInsufficientMaterial(); }
  isDraw() { return this.chess.isDraw(); }
  isGameOver() { return this.chess.isGameOver(); }

  /**
   * Determine terminal state + termination reason from current position.
   */
  terminationInfo() {
    if (this.isCheckmate()) {
      // The side to move was mated, so opposite side wins
      const winner = this.chess.turn() === 'w' ? 'black' : 'white';
      return {
        ended: true,
        result: winner === 'white' ? '1-0' : '0-1',
        winner,
        termination: 'checkmate',
      };
    }
    if (this.isStalemate()) return { ended: true, result: '1/2-1/2', winner: null, termination: 'stalemate' };
    if (this.isThreefoldRepetition()) return { ended: true, result: '1/2-1/2', winner: null, termination: 'repetition' };
    if (this.isInsufficientMaterial()) return { ended: true, result: '1/2-1/2', winner: null, termination: 'insufficient_material' };
    if (this.isDraw()) return { ended: true, result: '1/2-1/2', winner: null, termination: 'fifty_move_rule' };
    return { ended: false };
  }
}

module.exports = { GameCore };
