/**
 * Human-like opponent behavior: names, Elo mapping, think times.
 */

const FIRST = [
  'Alex', 'Jordan', 'Sam', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Avery',
  'Noah', 'Emma', 'Liam', 'Sofia', 'Omar', 'Priya', 'Kenji', 'Elena',
  'Marcus', 'Nina', 'Felix', 'Zara', 'Leo', 'Maya', 'Ivan', 'Clara',
];

const FLAIR = [
  'Knight', 'Pawn', 'Rook', 'Bishop', 'Blitz', 'Tactic', 'Endgame',
  'Castle', 'Gambit', 'Silence', 'Storm', 'Quiet', 'Swift', 'Calm',
];

const SUFFIXES = ['', '42', '77', '99', '23', 'x', '_chess', ''];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function categoryFromTime(initialSec, increment) {
  const estimated = initialSec + 40 * increment;
  if (estimated < 180) return 'bullet';
  if (estimated < 480) return 'blitz';
  if (estimated < 1500) return 'rapid';
  return 'classical';
}

/** Map target Elo to Stockfish skill / search depth. */
export function eloToEngineConfig(elo) {
  const e = Math.max(800, Math.min(2800, elo | 0));
  const skill = Math.max(0, Math.min(20, Math.round((e - 600) / 110)));
  const depth = Math.max(3, Math.min(16, Math.round(3 + (e - 800) / 180)));
  return { elo: e, skill, depth };
}

/** Generate a believable username near the player's rating. */
export function generateHumanOpponent(targetElo) {
  const style = rand(0, 4);
  let username;
  if (style === 0) username = `${pick(FIRST)}${pick(SUFFIXES)}`;
  else if (style === 1) username = `${pick(FLAIR)}${pick(FIRST)}`;
  else if (style === 2) username = `${pick(FIRST)}_${pick(FLAIR)}`;
  else if (style === 3) username = `${pick(FIRST).toLowerCase()}${pick(['plays', 'chess', 'gm'])}${rand(1, 999)}`;
  else username = `${pick(FLAIR)}${rand(10, 99)}`;

  const rating = Math.max(400, targetElo + rand(-35, 35));
  const engine = eloToEngineConfig(rating);
  return {
    username: username.slice(0, 20),
    rating,
    ...engine,
    title: rating >= 2400 && Math.random() < 0.15 ? 'FM' : null,
  };
}

/**
 * Human-like think delay before playing a move.
 * @param {import('chess.js').Chess} chess
 * @param {{ elo: number, ply: number, lastMove?: object }} ctx
 */
/** Deliberately awful move picker for the 100-Elo "Dummy" bot. Returns { from, to, promotion? }. */
export function pickDummyMove(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;

  const toMove = (m) => ({ from: m.from, to: m.to, promotion: m.promotion });

  const tryMove = (fen, m) => {
    const c = new window.Chess(fen);
    const res = c.move(toMove(m));
    return res ? c : null;
  };

  const mates = moves.filter(m => {
    const c = tryMove(chess.fen(), m);
    return c && c.isCheckmate();
  });

  let pool = moves;
  if (mates.length && Math.random() < 0.5) {
    const nonMates = moves.filter(m => !mates.some(mt => mt.from === m.from && mt.to === m.to));
    if (nonMates.length) pool = nonMates;
  }

  if (Math.random() < 0.55) {
    return toMove(pool[Math.floor(Math.random() * pool.length)]);
  }

  const color = chess.turn();
  const scored = pool.map(m => {
    const c = tryMove(chess.fen(), m);
    if (!c) return { m, s: Infinity };
    let s = _materialFor(c, color);
    s += (Math.random() - 0.25) * 700;
    if (c.isCheckmate()) s += 500;
    else if (c.isCheck()) s += 150;
    if (m.captured) s -= Math.random() * 120;
    return { m, s };
  });

  scored.sort((a, b) => a.s - b.s);
  const worst = scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.4)));
  return toMove(worst[Math.floor(Math.random() * worst.length)].m);
}

function _materialFor(chess, color) {
  const vals = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let score = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p) continue;
      const v = vals[p.type];
      score += p.color === color ? v : -v;
    }
  }
  if (chess.isCheck() && chess.turn() === color) score -= 3;
  return score;
}

export function computeHumanThinkTime(chess, { elo, ply, lastMove }) {
  if (elo <= 150) return rand(120, 520);

  const legalCount = chess.moves().length;
  const eloFactor = 0.55 + (Math.max(800, elo) - 800) / 2000;

  // Obvious recapture / few options
  if (lastMove?.captured || (lastMove?.san && lastMove.san.includes('x'))) {
    if (legalCount <= 4) return rand(180, 750);
    return rand(400, 1400);
  }

  // Opening — faster, especially at lower levels
  if (ply < 12) {
    return Math.round(rand(350, 1100) * (1.1 - eloFactor * 0.25));
  }

  if (legalCount <= 2) return rand(200, 650);
  if (legalCount <= 4) return rand(350, 1200);

  // Complex position
  if (legalCount >= 28) {
    let ms = rand(2500, 7500) * eloFactor;
    if (Math.random() < 0.12) ms += rand(3000, 9000);
    return Math.min(28000, ms);
  }

  if (legalCount >= 18) {
    return Math.round(rand(1500, 4500) * eloFactor);
  }

  // Typical middlegame
  let ms = rand(700, 1800) + legalCount * rand(25, 65);
  ms *= eloFactor;

  // Personality: occasional long think or snap move
  const roll = Math.random();
  if (roll < 0.07) ms += rand(3500, 11000);
  else if (roll < 0.11) ms = rand(120, 380);

  return Math.min(25000, Math.max(180, Math.round(ms)));
}

/** Engine search time cap — humans don't calculate forever. */
export function engineMoveTime(elo, ply) {
  const base = 400 + (elo - 800) * 1.2;
  if (ply < 12) return Math.min(1800, base);
  return Math.min(4500, Math.max(800, base));
}

/** Status text while "thinking". */
export function thinkingLabel(elo, ply) {
  if (elo <= 150) return pick(['...', 'huh?', 'durrr', 'zoning out', 'thinking?']);
  if (ply < 6) return pick(['considering...', 'thinking', 'hmm...']);
  if (Math.random() < 0.2) return pick(['calculating...', 'thinking hard', 'one moment']);
  return 'thinking';
}
