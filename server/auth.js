'use strict';

const jwt = require('jsonwebtoken');
const argon2 = require('argon2');

const JWT_SECRET = process.env.JWT_SECRET || 'mischess-dev-secret-change-in-prod';
const JWT_EXPIRY = '30d';

// Argon2id tuned for a reasonable server-side cost (~50-100ms per hash on typical hardware).
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456,   // ~19 MB
  timeCost: 2,
  parallelism: 1,
};

async function hashPassword(plain) {
  return argon2.hash(plain, ARGON2_OPTS);
}

async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch (e) {
    return false;
  }
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const token =
    req.cookies?.token ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'Invalid token' });
  req.user = data;
  next();
}

function optionalAuth(req, res, next) {
  const token =
    req.cookies?.token ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);
  if (token) {
    const data = verifyToken(token);
    if (data) req.user = data;
  }
  next();
}

module.exports = {
  hashPassword, verifyPassword,
  signToken, verifyToken,
  authMiddleware, optionalAuth,
  JWT_SECRET,
};
