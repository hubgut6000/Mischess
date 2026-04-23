/**
 * Mischess built-in AI - minimax with alpha-beta pruning.
 * Runs entirely in browser. Difficulty 1-8 maps to search depth.
 */

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// Piece-square tables (from white's perspective, rank 0 = rank 8, rank 7 = rank 1)
const PST = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

function pstValue(piece, color, squareIdx) {
  // squareIdx: 0 = a8, 63 = h1 (our internal board layout)
  const file = squareIdx % 8;
  const rank = Math.floor(squareIdx / 8);
  const idx = color === 'w' ? rank * 8 + file : (7 - rank) * 8 + file;
  return PST[piece.type][idx];
}

function evaluate(chess) {
  if (chess.isCheckmate()) {
    return chess.turn() === 'w' ? -99999 : 99999;
  }
  if (chess.isStalemate() || chess.insufficientMaterial()) return 0;

  const board = chess.board();
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) continue;
      const squareIdx = r * 8 + f;
      const val = PIECE_VALUES[p.type] + pstValue(p, p.color, squareIdx);
      score += p.color === 'w' ? val : -val;
    }
  }
  return score;
}

function orderMoves(moves) {
  // Put captures and promotions first for better pruning
  return moves.sort((a, b) => {
    const av = (a.captured ? PIECE_VALUES[a.captured] : 0) + (a.promotion ? PIECE_VALUES[a.promotion] : 0);
    const bv = (b.captured ? PIECE_VALUES[b.captured] : 0) + (b.promotion ? PIECE_VALUES[b.promotion] : 0);
    return bv - av;
  });
}

function minimax(chess, depth, alpha, beta, maximizing) {
  if (depth === 0 || chess.isGameOver()) {
    return { score: evaluate(chess) };
  }
  const moves = orderMoves(chess.moves({ verbose: true }));
  if (moves.length === 0) return { score: evaluate(chess) };

  let bestMove = null;
  if (maximizing) {
    let maxEval = -Infinity;
    for (const move of moves) {
      chess.move(move);
      const { score } = minimax(chess, depth - 1, alpha, beta, false);
      chess.undo?.() || (() => { /* our chess.js shim doesn't undo; reload */ })();
      // Our lightweight shim needs manual undo handling — use a FEN approach
      if (score > maxEval) { maxEval = score; bestMove = move; }
      alpha = Math.max(alpha, score);
      if (beta <= alpha) break;
    }
    return { score: maxEval, move: bestMove };
  } else {
    let minEval = Infinity;
    for (const move of moves) {
      chess.move(move);
      const { score } = minimax(chess, depth - 1, alpha, beta, true);
      chess.undo?.();
      if (score < minEval) { minEval = score; bestMove = move; }
      beta = Math.min(beta, score);
      if (beta <= alpha) break;
    }
    return { score: minEval, move: bestMove };
  }
}

/**
 * Our client chess shim doesn't expose undo, so we use a FEN-based search.
 * This is slower but correct. Fine for depth 1-4 which is what we want anyway.
 */
function searchWithFen(chess, depth, alpha, beta, maximizing) {
  if (depth === 0 || chess.isGameOver()) {
    return { score: evaluate(chess) };
  }
  const moves = orderMoves(chess.moves({ verbose: true }));
  if (moves.length === 0) return { score: evaluate(chess) };

  let bestMove = null;
  const savedFen = chess.fen();

  if (maximizing) {
    let maxEval = -Infinity;
    for (const move of moves) {
      chess.move(move);
      const { score } = searchWithFen(chess, depth - 1, alpha, beta, false);
      chess.load(savedFen);
      if (score > maxEval) { maxEval = score; bestMove = move; }
      alpha = Math.max(alpha, score);
      if (beta <= alpha) break;
    }
    return { score: maxEval, move: bestMove };
  } else {
    let minEval = Infinity;
    for (const move of moves) {
      chess.move(move);
      const { score } = searchWithFen(chess, depth - 1, alpha, beta, true);
      chess.load(savedFen);
      if (score < minEval) { minEval = score; bestMove = move; }
      beta = Math.min(beta, score);
      if (beta <= alpha) break;
    }
    return { score: minEval, move: bestMove };
  }
}

/**
 * Public: find a move for the current side.
 * @param {string} fen
 * @param {number} level 1-8 (maps to depth 1-4 for perf)
 */
export function findBestMove(fen, level = 3) {
  const chess = new window.Chess(fen);
  // Level 1 = random, 2 = depth 1 greedy, 3 = depth 2, 4 = depth 3, 5+ = depth 3-4 with variance
  if (level <= 1) {
    const moves = chess.moves({ verbose: true });
    if (!moves.length) return null;
    return moves[Math.floor(Math.random() * moves.length)];
  }
  const depthMap = { 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 3, 8: 4 };
  const depth = depthMap[level] || 2;
  const maximizing = chess.turn() === 'w';
  const { move } = searchWithFen(chess, depth, -Infinity, Infinity, maximizing);
  if (!move && level > 1) {
    const moves = chess.moves({ verbose: true });
    return moves[0] || null;
  }
  // Inject randomness at lower levels
  if (level <= 3) {
    const allMoves = orderMoves(chess.moves({ verbose: true }));
    if (Math.random() < 0.2 && allMoves.length > 1) {
      return allMoves[Math.min(1, allMoves.length - 1)];
    }
  }
  return move;
}
