'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { query, one } = require('../db/pool');
const { hashPassword, verifyPassword, signToken, authMiddleware } = require('../auth');
const { generateCsrfToken, setCsrfCookie } = require('../csrf');
const { recordIp } = require('../ipTrack');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts, slow down.' },
});

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setCookie(res, token) {
  const prod = process.env.NODE_ENV === 'production';
  res.cookie('token', token, {
    httpOnly: true,
    secure: prod,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

router.post('/register', authLimiter, async (req, res) => {
  // Always set fresh CSRF token so form can be resubmitted
  const csrf = generateCsrfToken();
  setCsrfCookie(res, csrf);
  
  try {
    const { username, email, password } = req.body || {};
    if (!username || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-20 chars (letters, numbers, _ -)', csrf });
    }
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Invalid email', csrf });
    }
    if (!password || password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be 6-128 chars', csrf });
    }

    const existing = await one('SELECT id FROM users WHERE username_lower = $1', [username.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Username already taken', csrf });
    if (email) {
      const existingEmail = await one('SELECT id FROM users WHERE email_lower = $1', [email.toLowerCase()]);
      if (existingEmail) return res.status(409).json({ error: 'Email already in use', csrf });
    }

    const hash = await hashPassword(password);
    const row = await one(
      `INSERT INTO users (username, username_lower, email, email_lower, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, bio, country, title, theme, piece_set,
                 rating_bullet, rating_blitz, rating_rapid, rating_classical,
                 games_played, wins, losses, draws, created_at`,
      [username, username.toLowerCase(), email || null, email ? email.toLowerCase() : null, hash]
    );

    const token = signToken({ id: row.id, username: row.username });
    setCookie(res, token);
    recordIp(row.id, req.ip).catch(() => {});
    res.json({ ok: true, token, csrf, user: row });
  } catch (e) {
    console.error('[register]', e);
    res.status(500).json({ error: 'Server error', csrf });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  // Always set fresh CSRF token so form can be resubmitted
  const csrf = generateCsrfToken();
  setCsrfCookie(res, csrf);
  
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required', csrf });

    const user = await one(
      `SELECT id, username, email, password_hash,
              bio, country, title, theme, piece_set,
              rating_bullet, rating_blitz, rating_rapid, rating_classical,
              games_played, wins, losses, draws
       FROM users WHERE username_lower = $1`,
      [username.toLowerCase()]
    );
    if (!user) return res.status(401).json({ error: 'Invalid credentials', csrf });

    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials', csrf });

    await query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);
    recordIp(user.id, req.ip).catch(() => {});

    const token = signToken({ id: user.id, username: user.username });
    setCookie(res, token);
    delete user.password_hash;
    res.json({ ok: true, token, csrf, user });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ error: 'Server error', csrf });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.clearCookie('csrf', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  // Always set a fresh CSRF token (called on page load to bootstrap)
  const csrf = generateCsrfToken();
  setCsrfCookie(res, csrf);
  
  // If authenticated, return user data
  if (req.user) {
    const user = await one(
      `SELECT id, username, email, bio, country, title, theme, piece_set,
              rating_bullet, rating_blitz, rating_rapid, rating_classical,
              games_played, wins, losses, draws, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found', csrf });
    return res.json({ user, csrf });
  }
  
  // Not authenticated, just return CSRF token for register/login forms
  res.json({ csrf });
});

module.exports = router;
