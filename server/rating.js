'use strict';

// Simplified Glicko-2 rating system
// https://en.wikipedia.org/wiki/Glicko_rating_system

const TAU = 0.5;
const SCALE = 173.7178;
const EPSILON = 0.000001;

function g(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function E(mu, muJ, phiJ) {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Compute new rating for player after one game.
 * @param {object} player - { rating, rd, vol }
 * @param {object} opponent - { rating, rd }
 * @param {number} score - 1, 0.5, 0
 * @returns {{rating: number, rd: number, vol: number}}
 */
function updateRating(player, opponent, score) {
  const mu = (player.rating - 1500) / SCALE;
  const phi = (player.rd || 200) / SCALE;
  const sigma = player.vol || 0.06;

  const muJ = (opponent.rating - 1500) / SCALE;
  const phiJ = (opponent.rd || 200) / SCALE;

  const gPhiJ = g(phiJ);
  const EValue = E(mu, muJ, phiJ);
  const v = 1 / (gPhiJ * gPhiJ * EValue * (1 - EValue));
  const delta = v * gPhiJ * (score - EValue);

  // Volatility update (iterative)
  const a = Math.log(sigma * sigma);
  let A = a;
  let B;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU, delta, phi, v, a) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A, delta, phi, v, a);
  let fB = f(B, delta, phi, v, a);
  let iter = 0;
  while (Math.abs(B - A) > EPSILON && iter < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C, delta, phi, v, a);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
    iter++;
  }
  const newSigma = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * gPhiJ * (score - EValue);

  return {
    rating: Math.round(newMu * SCALE + 1500),
    rd: newPhi * SCALE,
    vol: newSigma,
  };
}

function f(x, delta, phi, v, a) {
  const ex = Math.exp(x);
  const num = ex * (delta * delta - phi * phi - v - ex);
  const den = 2 * Math.pow(phi * phi + v + ex, 2);
  return num / den - (x - a) / (TAU * TAU);
}

// Simple Elo fallback — used when we want quick rating updates
// K-factor tuned by rating and games played
function eloUpdate(playerRating, opponentRating, score, kFactor = 32) {
  const expected = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
  const delta = Math.round(kFactor * (score - expected));
  return playerRating + delta;
}

module.exports = { updateRating, eloUpdate };
