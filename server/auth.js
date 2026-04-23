'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'mischess-dev-secret-change-in-prod';
const JWT_EXPIRY = '30d';

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

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const data = verifyToken(token);
  if (!data) {
    return res.status(401).json({ error: 'Invalid token' });
  }
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

module.exports = { signToken, verifyToken, authMiddleware, optionalAuth, JWT_SECRET };
