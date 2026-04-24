'use strict';

const crypto = require('crypto');

/**
 * Double-submit cookie CSRF protection.
 * - On auth success, server sets a csrf cookie (not httpOnly so JS can read it).
 * - Client must echo the value back in X-CSRF-Token header on state-changing requests.
 * - Attacker cross-origin requests won't be able to read the cookie, so can't forge the header.
 */

function generateCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function setCsrfCookie(res, token) {
  res.cookie('csrf', token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function csrfMiddleware(req, res, next) {
  // Only check state-changing methods
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // Skip on auth endpoints (login/register bootstrap the token)
  if (req.path === '/login' || req.path === '/register') return next();

  const cookieToken = req.cookies?.csrf;
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF token missing or invalid' });
  }
  next();
}

module.exports = { generateCsrfToken, setCsrfCookie, csrfMiddleware };
