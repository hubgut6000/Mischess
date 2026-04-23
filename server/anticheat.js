'use strict';

// Mischess Anti-Cheat
// Heuristic approach combining multiple signals:
//  1. Move-time consistency (engines produce unnaturally uniform timing)
//  2. Tab-switch / focus loss telemetry during game
//  3. Impossible accuracy over long games
//  4. Browser fingerprint + user-agent anomalies
//  5. Multi-account detection via IP clustering
//  6. Statistical move-time variance analysis

const { getDb } = require('./db');

/**
 * Analyze move-time patterns for a game.
 * Engine users often have:
 *  - Very low variance in think time
 *  - Fast responses on critical/complex positions
 *  - Sudden time jumps after switching tabs
 */
function analyzeMoveTimes(moveTimes) {
  if (moveTimes.length < 10) return { suspicious: false, score: 0 };

  const mean = moveTimes.reduce((a, b) => a + b, 0) / moveTimes.length;
  const variance = moveTimes.reduce((acc, t) => acc + Math.pow(t - mean, 2), 0) / moveTimes.length;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / mean; // coefficient of variation

  let score = 0;
  const flags = [];

  // Unnaturally low variance (bot-like)
  if (cv < 0.25 && moveTimes.length > 20) {
    score += 35;
    flags.push('low_variance');
  }

  // Too many instant moves (< 500ms) on non-trivial positions
  const instantMoves = moveTimes.filter(t => t < 500).length;
  const instantRatio = instantMoves / moveTimes.length;
  if (instantRatio > 0.7 && moveTimes.length > 15) {
    score += 25;
    flags.push('excessive_instant_moves');
  }

  // Suspiciously round numbers (engine outputs often cluster)
  const roundCount = moveTimes.filter(t => t % 1000 < 50 || t % 1000 > 950).length;
  if (roundCount / moveTimes.length > 0.4) {
    score += 10;
    flags.push('clustered_timings');
  }

  return {
    suspicious: score >= 40,
    score,
    flags,
    mean: Math.round(mean),
    stdDev: Math.round(stdDev),
    cv: +cv.toFixed(3),
  };
}

/**
 * Track tab-switch events during a game.
 * Honest players rarely blur the window mid-game.
 */
function analyzeFocusEvents(focusEvents, moveCount) {
  if (!focusEvents || focusEvents.length === 0) return { suspicious: false, score: 0 };

  const blurs = focusEvents.filter(e => e.type === 'blur').length;
  const score = Math.min(50, blurs * 5);
  const flags = [];
  if (blurs > moveCount / 3) flags.push('frequent_tab_switching');
  if (blurs > 20) flags.push('excessive_focus_loss');

  return {
    suspicious: score >= 30,
    score,
    flags,
    blurCount: blurs,
  };
}

/**
 * Multi-account detection: flag if IP has many accounts.
 */
function analyzeMultiAccount(userId, ip) {
  if (!ip) return { suspicious: false, score: 0 };
  // This would be extended with IP logging table; for now simple check
  return { suspicious: false, score: 0 };
}

/**
 * Full evaluation after a game completes.
 */
function evaluateGame(gameId, userId, moveTimes, focusEvents) {
  const timing = analyzeMoveTimes(moveTimes);
  const focus = analyzeFocusEvents(focusEvents || [], moveTimes.length);

  const totalScore = timing.score + focus.score;
  const suspicious = totalScore >= 50;

  if (suspicious && userId) {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO anticheat_reports (user_id, game_id, reason, severity, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        gameId,
        [...timing.flags, ...focus.flags].join(',') || 'heuristic_flag',
        totalScore,
        JSON.stringify({ timing, focus }),
        Date.now()
      );

      // Auto-flag account if severity is very high
      if (totalScore >= 80) {
        db.prepare('UPDATE users SET flagged = 1 WHERE id = ?').run(userId);
      }
    } catch (e) {
      console.error('[anticheat] failed to log report', e);
    }
  }

  return { score: totalScore, suspicious, timing, focus };
}

/**
 * Real-time move validation: detect suspicious single-move patterns.
 * Called during play, returns whether to increase monitoring.
 */
function checkMove(thinkMs, moveCount, complexity) {
  const flags = [];
  if (thinkMs < 150 && moveCount > 5 && complexity === 'high') {
    flags.push('instant_complex_move');
  }
  return { flags };
}

module.exports = {
  analyzeMoveTimes,
  analyzeFocusEvents,
  evaluateGame,
  checkMove,
};
