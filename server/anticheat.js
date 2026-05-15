'use strict';

const { Chess } = require('chess.js');
const { analyzer } = require('./stockfishAnalyzer');
const { query, one, many } = require('./db/pool');

/**
 * Mischess Anti-Cheat v3
 *
 * Primary: Stockfish ACPL + Lichess-style accuracy + top-move correlation
 * Secondary: move-time variance, focus/telemetry events from client
 */

const ANALYSIS_DEPTH = parseInt(process.env.ANALYSIS_DEPTH || '12', 10);
const ACCURACY_FLAG_THRESHOLD = 96;
const ACPL_FLAG_THRESHOLD = 11;
const TOP_MOVE_MATCH_THRESHOLD = 0.82;
const MIN_GAMES_FOR_FLAG = 3;
const MIN_MOVES_FOR_ANALYSIS = 12;
const ROLLING_WINDOW = 6;
const OPENING_PLY_SKIP = 8;
const FORCED_DELTA_CP = 60;
const BEHAVIORAL_FLAG_SCORE = 55;
const TELEMETRY_SEVERE_COUNT = 4;

function winPct(cp) {
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

function accuracyFromLoss(winPctBefore, winPctAfter) {
  const diff = Math.max(0, winPctBefore - winPctAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * diff) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

function cpFromWinPct(wp) {
  const clamped = Math.max(0.01, Math.min(99.99, wp));
  const x = (clamped - 50) / 50;
  const r = (1 - x) / (1 + x);
  if (r <= 0) return 1000;
  return Math.max(-1000, Math.min(1000, -Math.log(r) / 0.00368208));
}

function moveToUci(move) {
  if (!move) return '';
  return move.from + move.to + (move.promotion || '');
}

function classifyCpLoss(cpLoss) {
  if (cpLoss >= 300) return 'blunder';
  if (cpLoss >= 150) return 'mistake';
  if (cpLoss >= 50) return 'inaccuracy';
  return 'good';
}

/**
 * Analyze a completed game with Stockfish.
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
  const whiteTopMatches = [];
  const blackTopMatches = [];
  const perMoveAnalysis = [];

  const startCp = await analyzer.evaluate(chess.fen(), ANALYSIS_DEPTH);
  if (startCp === null) return null;
  let prevWinPctWhite = winPct(startCp);

  for (let i = 0; i < moves.length; i++) {
    const san = moves[i];
    const beforeSide = chess.turn() === 'w' ? 'white' : 'black';
    const fenBefore = chess.fen();
    const evalBefore = beforeSide === 'white' ? prevWinPctWhite : (100 - prevWinPctWhite);

    const bestUci = await analyzer.getBestMove(fenBefore, ANALYSIS_DEPTH);
    const move = chess.move(san);
    if (!move) break;

    const playedUci = moveToUci(move);
    const matchedTop = bestUci && playedUci === bestUci;
    const bestSan = bestUci ? uciToSan(fenBefore, bestUci) : null;

    const cpAfterRaw = await analyzer.evaluate(chess.fen(), ANALYSIS_DEPTH);
    if (cpAfterRaw === null) continue;

    const cpAfterWhite = chess.turn() === 'w' ? cpAfterRaw : -cpAfterRaw;
    const winPctAfterWhite = winPct(cpAfterWhite);

    const moverWinPctBefore = beforeSide === 'white' ? prevWinPctWhite : (100 - prevWinPctWhite);
    const moverWinPctAfter = beforeSide === 'white' ? winPctAfterWhite : (100 - winPctAfterWhite);
    const moveAccuracy = accuracyFromLoss(moverWinPctBefore, moverWinPctAfter);

    const prevCpMover = beforeSide === 'white' ? cpFromWinPct(prevWinPctWhite) : -cpFromWinPct(prevWinPctWhite);
    const afterCpMover = beforeSide === 'white' ? cpAfterWhite : -cpAfterWhite;
    const cpLoss = Math.max(0, Math.min(1000, prevCpMover - afterCpMover));

    perMoveAnalysis.push({
      ply: i + 1,
      played_san: san,
      best_move_san: bestSan,
      eval_before: evalBefore,
      eval_after: 100 - moverWinPctAfter,
      classification: classifyCpLoss(cpLoss),
    });

    const isInOpening = i < OPENING_PLY_SKIP;
    if (!isInOpening) {
      const wasForcedRecapture = move.captured && Math.abs(prevCpMover) < 100 && cpLoss < FORCED_DELTA_CP;
      const weight = wasForcedRecapture ? 0.3 : 1.0;
      const weightedLoss = cpLoss * weight;

      if (beforeSide === 'white') {
        whiteLosses.push(weightedLoss);
        whiteAccuracies.push(moveAccuracy);
        if (bestUci) whiteTopMatches.push(matchedTop ? 1 : 0);
      } else {
        blackLosses.push(weightedLoss);
        blackAccuracies.push(moveAccuracy);
        if (bestUci) blackTopMatches.push(matchedTop ? 1 : 0);
      }
    }

    prevWinPctWhite = winPctAfterWhite;
  }

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const topMatchRate = arr => arr.length ? avg(arr) : null;

  return {
    white: {
      acpl: +avg(whiteLosses).toFixed(1),
      accuracy: +avg(whiteAccuracies).toFixed(2),
      movesAnalyzed: whiteLosses.length,
      topMoveMatch: topMatchRate(whiteTopMatches),
    },
    black: {
      acpl: +avg(blackLosses).toFixed(1),
      accuracy: +avg(blackAccuracies).toFixed(2),
      movesAnalyzed: blackLosses.length,
      topMoveMatch: topMatchRate(blackTopMatches),
    },
    perMove: perMoveAnalysis,
  };
}

function uciToSan(fen, uci) {
  try {
    const c = new Chess(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const m = c.move({ from, to, promotion });
    return m ? m.san : uci;
  } catch {
    return uci;
  }
}

function analyzeMoveTimes(moveTimes) {
  if (moveTimes.length < 10) return { suspicious: false, score: 0, flags: [] };
  const mean = moveTimes.reduce((a, b) => a + b, 0) / moveTimes.length;
  const variance = moveTimes.reduce((acc, t) => acc + Math.pow(t - mean, 2), 0) / moveTimes.length;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / Math.max(1, mean);
  const flags = [];
  let score = 0;
  if (cv < 0.22 && moveTimes.length > 20) { score += 40; flags.push('low_variance'); }
  const instantMoves = moveTimes.filter(t => t < 400).length;
  if (instantMoves / moveTimes.length > 0.65 && moveTimes.length > 15) { score += 30; flags.push('excessive_instant'); }
  const veryFast = moveTimes.filter(t => t < 200).length;
  if (veryFast / moveTimes.length > 0.4 && moveTimes.length > 12) { score += 20; flags.push('sub_200ms_moves'); }
  return { suspicious: score >= 40, score, flags, mean: Math.round(mean), stdDev: Math.round(stdDev), cv: +cv.toFixed(3) };
}

function analyzeFocusEvents(focusEvents, moveCount) {
  if (!focusEvents?.length) return { suspicious: false, score: 0, flags: [] };
  const flags = [];
  let score = 0;

  const blurs = focusEvents.filter(e =>
    e.event_type === 'blur' || e.event_type === 'window_blur' || e.type === 'blur'
  ).length;
  const telemetry = focusEvents.filter(e => String(e.event_type || '').startsWith('ac:'));
  const severe = telemetry.filter(e => {
    const t = e.event_type.replace(/^ac:/, '');
    return ['devtools_open', 'paste_during_game', 'multi_tab_game', 'zero_mouse_drift'].includes(t);
  }).length;

  score += Math.min(35, blurs * 4);
  score += Math.min(45, severe * 12);

  if (blurs > moveCount / 3) flags.push('frequent_tab_switching');
  if (blurs > 15) flags.push('excessive_focus_loss');
  if (severe >= 2) flags.push('client_telemetry');
  if (severe >= TELEMETRY_SEVERE_COUNT) flags.push('severe_client_signals');

  return { suspicious: score >= 30, score, flags, blurCount: blurs, telemetryCount: severe };
}

async function loadBehavioralSignals(gameId, userId) {
  const times = await many(
    `SELECT think_ms FROM move_telemetry WHERE game_id = $1 AND user_id = $2 ORDER BY ply`,
    [gameId, userId]
  );
  const events = await many(
    `SELECT event_type FROM focus_events WHERE game_id = $1 AND user_id = $2`,
    [gameId, userId]
  );
  return {
    moveTimes: times.map(r => r.think_ms),
    focusEvents: events,
  };
}

function buildFlagReasons({ avgAcc, avgAcpl, topMatch, behavioral, accuracyOnly }) {
  const reasons = [];
  if (accuracyOnly || avgAcc >= ACCURACY_FLAG_THRESHOLD) reasons.push(`avg_accuracy=${avgAcc.toFixed(2)}%`);
  if (accuracyOnly || avgAcpl <= ACPL_FLAG_THRESHOLD) reasons.push(`avg_acpl=${avgAcpl.toFixed(2)}`);
  if (topMatch != null && topMatch >= TOP_MOVE_MATCH_THRESHOLD) reasons.push(`top_move_match=${(topMatch * 100).toFixed(1)}%`);
  if (behavioral?.suspicious) reasons.push(`behavioral=${behavioral.flags.join(',')}`);
  return reasons;
}

function shouldFlag({ accs, acpls, topMatches, behavioral, gameStats }) {
  if (accs.length < MIN_GAMES_FOR_FLAG) return { flag: false, reasons: [] };

  const avgAcc = accs.reduce((a, b) => a + b, 0) / accs.length;
  const avgAcpl = acpls.reduce((a, b) => a + b, 0) / acpls.length;
  const avgTopMatch = topMatches.length
    ? topMatches.reduce((a, b) => a + b, 0) / topMatches.length
    : null;

  const accuracySuspicious = avgAcc >= ACCURACY_FLAG_THRESHOLD || avgAcpl <= ACPL_FLAG_THRESHOLD;
  const engineCorrelation = avgTopMatch != null && avgTopMatch >= TOP_MOVE_MATCH_THRESHOLD
    && avgAcc >= 92;
  const behavioralStrong = behavioral?.score >= BEHAVIORAL_FLAG_SCORE;
  const singleGameEngine = gameStats?.topMoveMatch >= TOP_MOVE_MATCH_THRESHOLD
    && gameStats?.accuracy >= 97
    && gameStats?.movesAnalyzed >= 20;

  const flag = accuracySuspicious
    || engineCorrelation
    || (behavioralStrong && (avgAcc >= 93 || avgAcpl <= 14))
    || (singleGameEngine && behavioral?.score >= 35);

  const reasons = buildFlagReasons({
    avgAcc,
    avgAcpl,
    topMatch: avgTopMatch,
    behavioral,
    accuracyOnly: accuracySuspicious,
  });

  return { flag, reasons, avgAcc, avgAcpl, avgTopMatch };
}

async function pushAndEvaluate(userId, accuracy, acpl, topMoveMatch, gameId) {
  const row = await one(
    `UPDATE users SET
       recent_accuracies = (ARRAY_APPEND(recent_accuracies, $1::numeric))[GREATEST(1, array_length(recent_accuracies,1) + 1 - $4)::int : ],
       recent_acpls = (ARRAY_APPEND(recent_acpls, $2::numeric))[GREATEST(1, array_length(recent_acpls,1) + 1 - $4)::int : ]
     WHERE id = $5
     RETURNING id, is_flagged, recent_accuracies, recent_acpls`,
    [accuracy, acpl, ROLLING_WINDOW, userId]
  );
  if (!row || row.is_flagged) return;

  const accs = (row.recent_accuracies || []).slice(-ROLLING_WINDOW).map(Number);
  const acpls = (row.recent_acpls || []).slice(-ROLLING_WINDOW).map(Number);

  if ((row.recent_accuracies || []).length > ROLLING_WINDOW) {
    await query(
      `UPDATE users SET recent_accuracies = $1::numeric[], recent_acpls = $2::numeric[] WHERE id = $3`,
      [accs, acpls, userId]
    );
  }

  const { moveTimes, focusEvents } = await loadBehavioralSignals(gameId, userId);
  const timing = analyzeMoveTimes(moveTimes);
  const focus = analyzeFocusEvents(focusEvents, moveTimes.length);
  const behavioral = {
    suspicious: timing.suspicious || focus.suspicious,
    score: timing.score + focus.score,
    flags: [...timing.flags, ...focus.flags],
  };

  const { flag, reasons, avgAcc, avgAcpl } = shouldFlag({
    accs,
    acpls,
    topMatches: topMoveMatch != null ? [topMoveMatch] : [],
    behavioral,
    gameStats: { accuracy, acpl, topMoveMatch, movesAnalyzed: moveTimes.length },
  });

  if (!flag || reasons.length === 0) return;

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
      'accuracy_pulse_v3',
      Math.min(100, 70 + behavioral.score),
      JSON.stringify({
        avgAccuracy: avgAcc,
        avgAcpl,
        topMoveMatch,
        behavioral,
        timing,
        focus,
        window: accs.length,
      }),
    ]
  );
  console.log(`[anticheat] flagged user ${userId}: ${reasons.join(';')}`);
}

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
    await query('UPDATE games SET analyzed = true WHERE id = $1', [gameId]);
    return;
  }

  await query(
    `UPDATE games SET white_acpl = $1, white_accuracy = $2, black_acpl = $3, black_accuracy = $4, analyzed = true WHERE id = $5`,
    [result.white.acpl, result.white.accuracy, result.black.acpl, result.black.accuracy, gameId]
  );

  if (result.perMove?.length) {
    try {
      await query('DELETE FROM analysis_moves WHERE game_id = $1', [gameId]);
      for (const m of result.perMove) {
        await query(
          `INSERT INTO analysis_moves (game_id, ply, played_san, best_move_san, eval_before, eval_after, classification)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (game_id, ply) DO NOTHING`,
          [gameId, m.ply, m.played_san, m.best_move_san, m.eval_before, m.eval_after, m.classification]
        );
      }
    } catch (e) {
      console.error('[analysis_moves persist]', e);
    }
  }

  if (game.white_id) {
    await pushAndEvaluate(game.white_id, result.white.accuracy, result.white.acpl, result.white.topMoveMatch, gameId);
  }
  if (game.black_id) {
    await pushAndEvaluate(game.black_id, result.black.accuracy, result.black.acpl, result.black.topMoveMatch, gameId);
  }
}

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
  setInterval(processQueue, 15000);
  setTimeout(processQueue, 5000);
  console.log('[anticheat] analysis queue started (v3)');
}

function enqueueAnalysis(gameId) {
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
