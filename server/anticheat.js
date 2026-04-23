'use strict';

const { Chess } = require('chess.js');
const { analyzer } = require('./stockfishAnalyzer');
const { query, one } = require('./db/pool');

/**
 * Mischess Anti-Cheat v2
 *
 * Signal stack (strongest first):
 *   1. ACPL - average centipawn loss vs Stockfish best move
 *   2. Accuracy% - Lichess-style formula from win% deltas
 *   3. Rolling 6-game average of accuracy per user
 *   4. Move-time variance (coefficient of variation)
 *   5. Focus-loss events during rated games
 *   6. Instant-move ratio on complex positions
 *
 * Output: on evaluation completion, update users.recent_accuracies and
 * recent_acpls arrays. If averages cross thresholds, set is_flagged = true
 * and matchmaking shadow-pools them (see gameManager).
 */

const ANALYSIS_DEPTH = parseInt(process.env.ANALYSIS_DEPTH || '12', 10);
const ACCURACY_FLAG_THRESHOLD = 97;       // avg of last 6 > 97% = flagged
const ACPL_FLAG_THRESHOLD = 10;           // avg of last 6 ACPL < 10 = flagged
const MIN_GAMES_FOR_FLAG = 3;             // require at least 3 analyzed games
const MIN_MOVES_FOR_ANALYSIS = 12;        // skip very short games
const ROLLING_WINDOW = 6;

/**
 * Convert centipawn loss to Lichess-style win percentage delta.
 * Formula: winPct = 50 + 50 * (2 / (1 + e^(-0.00368208 * cp)) - 1)
 * Accuracy per move: 103.1668 * e^(-0.04354 * winPctDelta) - 3.1669 (clamped 0..100)
 */
function winPct(cp) {
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

function accuracyFromLoss(winPctBefore, winPctAfter) {
  // If the move was from side-to-move perspective, winPctBefore should be >= winPctAfter
  const diff = Math.max(0, winPctBefore - winPctAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * diff) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

/**
 * Analyze a completed game with Stockfish.
 * Returns { white: { acpl, accuracy, movesAnalyzed }, black: { ... } } or null.
 */
async function analyzeGame(game) {
  if (!analyzer.available) return null;
  let moves;
  try {
    moves = typeof game.moves === 'string' ? JSON.parse(game.moves) : game.moves;
  } catch { return null; }
  if (!Array.isArray(moves) || moves.length < MIN_MOVES_FOR_ANALYSIS) return null;

  const chess = new Chess();
  const whiteLosses = [];
  const blackLosses = [];
  const whiteAccuracies = [];
  const blackAccuracies = [];

  // Evaluate starting position
  let prevCp = await analyzer.evaluate(chess.fen(), ANALYSIS_DEPTH);
  if (prevCp === null) return null;
  // prevCp is from side-to-move perspective (white at start)
  let prevWinPctWhite = winPct(prevCp); // from white's perspective
  const sideToMove = () => chess.turn() === 'w' ? 'white' : 'black';

  for (let i = 0; i < moves.length; i++) {
    const san = moves[i];
    const beforeSide = sideToMove();
    const move = chess.move(san);
    if (!move) break;

    // Evaluate post-move position
    const cpAfterRaw = await analyzer.evaluate(chess.fen(), ANALYSIS_DEPTH);
    if (cpAfterRaw === null) continue;

    // cpAfterRaw is from perspective of side to move AFTER the move (i.e. opponent)
    // So cp from white's perspective: flip sign if it's black's turn to move now
    const cpAfterWhite = chess.turn() === 'w' ? cpAfterRaw : -cpAfterRaw;
    const winPctAfterWhite = winPct(cpAfterWhite);

    // Loss from mover's perspective
    const moverWinPctBefore = beforeSide === 'white' ? prevWinPctWhite : (100 - prevWinPctWhite);
    const moverWinPctAfter = beforeSide === 'white' ? winPctAfterWhite : (100 - winPctAfterWhite);
    const moveAccuracy = accuracyFromLoss(moverWinPctBefore, moverWinPctAfter);

    // Centipawn loss for this move (capped at 1000)
    const prevCpMover = beforeSide === 'white' ? cpFromWinPct(prevWinPctWhite) : -cpFromWinPct(prevWinPctWhite);
    const afterCpMover = beforeSide === 'white' ? cpAfterWhite : -cpAfterWhite;
    const cpLoss = Math.max(0, Math.min(1000, prevCpMover - afterCpMover));

    if (beforeSide === 'white') {
      whiteLosses.push(cpLoss);
      whiteAccuracies.push(moveAccuracy);
    } else {
      blackLosses.push(cpLoss);
      blackAccuracies.push(moveAccuracy);
    }

    prevWinPctWhite = winPctAfterWhite;
  }

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  return {
    white: {
      acpl: +avg(whiteLosses).toFixed(1),
      accuracy: +avg(whiteAccuracies).toFixed(2),
      movesAnalyzed: whiteLosses.length,
    },
    black: {
      acpl: +avg(blackLosses).toFixed(1),
      accuracy: +avg(blackAccuracies).toFixed(2),
      movesAnalyzed: blackLosses.length,
    },
  };
}

function cpFromWinPct(wp) {
  // Inverse of winPct - approximate
  const clamped = Math.max(0.01, Math.min(99.99, wp));
  const x = (clamped - 50) / 50;
  // 2 / (1 + e^(-0.00368208 * cp)) - 1 = x
  // => 1 + e^(-0.00368208 * cp) = 2 / (x + 1)
  // => e^(-0.00368208 * cp) = 2 / (x + 1) - 1 = (1 - x) / (1 + x)
  const r = (1 - x) / (1 + x);
  if (r <= 0) return 1000;
  return Math.max(-1000, Math.min(1000, -Math.log(r) / 0.00368208));
}

/**
 * Run analysis for a finished game, update user rolling windows, maybe flag.
 */
async function runAnalysisForGame(gameId) {
  const game = await one('SELECT * FROM games WHERE id = $1 AND analyzed = false', [gameId]);
  if (!game) return;
  if (!game.rated) {
    await query('UPDATE games SET analyzed = true WHERE id = $1', [gameId]);
    return;
  }

  let result;
  try {
    result = await analyzeGame(game);
  } catch (e) {
    console.warn('[anticheat] analysis failed', gameId, e.message);
  }

  if (!result) {
    // No Stockfish available or game too short. Mark analyzed anyway to skip next time.
    await query('UPDATE games SET analyzed = true WHERE id = $1', [gameId]);
    return;
  }

  await query(
    `UPDATE games SET white_acpl = $1, white_accuracy = $2, black_acpl = $3, black_accuracy = $4, analyzed = true WHERE id = $5`,
    [result.white.acpl, result.white.accuracy, result.black.acpl, result.black.accuracy, gameId]
  );

  // Update rolling window for each player
  if (game.white_id) {
    await pushAndEvaluate(game.white_id, result.white.accuracy, result.white.acpl, gameId);
  }
  if (game.black_id) {
    await pushAndEvaluate(game.black_id, result.black.accuracy, result.black.acpl, gameId);
  }
}

async function pushAndEvaluate(userId, accuracy, acpl, gameId) {
  // Append accuracy/acpl, trim to ROLLING_WINDOW
  const row = await one(
    `UPDATE users SET
       recent_accuracies = (ARRAY_APPEND(recent_accuracies, $1::numeric))[GREATEST(1, array_length(recent_accuracies,1) + 1 - $3)::int : ],
       recent_acpls = (ARRAY_APPEND(recent_acpls, $2::numeric))[GREATEST(1, array_length(recent_acpls,1) + 1 - $3)::int : ]
     WHERE id = $4
     RETURNING id, is_flagged, recent_accuracies, recent_acpls`,
    [accuracy, acpl, ROLLING_WINDOW, userId]
  );
  if (!row) return;

  // trim arrays to last N in JS too (Postgres slice is inclusive; our expression above keeps the last N-ish elements but simpler approach below)
  const accs = (row.recent_accuracies || []).slice(-ROLLING_WINDOW).map(Number);
  const acpls = (row.recent_acpls || []).slice(-ROLLING_WINDOW).map(Number);

  // If DB slice didn't truncate cleanly, force it
  if ((row.recent_accuracies || []).length > ROLLING_WINDOW) {
    await query(
      `UPDATE users SET recent_accuracies = $1::numeric[], recent_acpls = $2::numeric[] WHERE id = $3`,
      [accs, acpls, userId]
    );
  }

  // Only flag once we have enough data
  if (accs.length < MIN_GAMES_FOR_FLAG) return;
  if (row.is_flagged) return; // already flagged

  const avgAcc = accs.reduce((a, b) => a + b, 0) / accs.length;
  const avgAcpl = acpls.reduce((a, b) => a + b, 0) / acpls.length;

  const reasons = [];
  if (avgAcc >= ACCURACY_FLAG_THRESHOLD) reasons.push(`avg_accuracy=${avgAcc.toFixed(2)}%`);
  if (avgAcpl <= ACPL_FLAG_THRESHOLD) reasons.push(`avg_acpl=${avgAcpl.toFixed(2)}`);

  if (reasons.length > 0) {
    await query(
      `UPDATE users SET is_flagged = true, flag_reason = $1, flagged_at = NOW() WHERE id = $2`,
      [reasons.join(';'), userId]
    );
    await query(
      `INSERT INTO anticheat_reports (user_id, game_id, reason, severity, details, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
      [
        userId,
        gameId,
        'accuracy_pulse',
        95,
        JSON.stringify({ avgAccuracy: avgAcc, avgAcpl: avgAcpl, window: accs.length }),
      ]
    );
    console.log(`[anticheat] flagged user ${userId}: ${reasons.join(';')}`);
  }
}

// ---------- Heuristic signals (kept as secondary layer) ----------

function analyzeMoveTimes(moveTimes) {
  if (moveTimes.length < 10) return { suspicious: false, score: 0, flags: [] };
  const mean = moveTimes.reduce((a, b) => a + b, 0) / moveTimes.length;
  const variance = moveTimes.reduce((acc, t) => acc + Math.pow(t - mean, 2), 0) / moveTimes.length;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / Math.max(1, mean);
  const flags = [];
  let score = 0;
  if (cv < 0.25 && moveTimes.length > 20) { score += 35; flags.push('low_variance'); }
  const instantMoves = moveTimes.filter(t => t < 500).length;
  if (instantMoves / moveTimes.length > 0.7 && moveTimes.length > 15) { score += 25; flags.push('excessive_instant'); }
  return { suspicious: score >= 40, score, flags, mean: Math.round(mean), stdDev: Math.round(stdDev), cv: +cv.toFixed(3) };
}

function analyzeFocusEvents(focusEvents, moveCount) {
  if (!focusEvents?.length) return { suspicious: false, score: 0, flags: [] };
  const blurs = focusEvents.filter(e => e.event_type === 'blur' || e.type === 'blur').length;
  const flags = [];
  let score = Math.min(50, blurs * 5);
  if (blurs > moveCount / 3) flags.push('frequent_tab_switching');
  if (blurs > 20) flags.push('excessive_focus_loss');
  return { suspicious: score >= 30, score, flags, blurCount: blurs };
}

// ---------- Analysis queue ----------

let queueRunning = false;
async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (true) {
      const job = await one(
        `SELECT id FROM games WHERE analyzed = false AND ended_at IS NOT NULL AND rated = true
         ORDER BY ended_at ASC LIMIT 1`
      );
      if (!job) break;
      await runAnalysisForGame(job.id);
    }
  } catch (e) {
    console.error('[anticheat queue]', e);
  } finally {
    queueRunning = false;
  }
}

function startAnalysisQueue() {
  // Poll every 15 seconds for new games to analyze.
  setInterval(processQueue, 15000);
  // Also kick immediately after boot
  setTimeout(processQueue, 5000);
  console.log('[anticheat] analysis queue started');
}

function enqueueAnalysis(gameId) {
  // Just nudge the queue; actual work happens on interval or next kick
  setImmediate(processQueue);
}

module.exports = {
  runAnalysisForGame,
  analyzeMoveTimes,
  analyzeFocusEvents,
  startAnalysisQueue,
  enqueueAnalysis,
  winPct,
  accuracyFromLoss,
};
