'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');
const { signToken, authMiddleware } = require('../auth');

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
  try {
    const { username, email, password } = req.body || {};
    if (!username || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-20 chars (letters, numbers, _ -)' });
    }
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    if (!password || password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: 'Password must be 6-100 chars' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });
    if (email) {
      const existingEmail = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email);
      if (existingEmail) return res.status(409).json({ error: 'Email already in use' });
    }

    const hash = await bcrypt.hash(password, 10);
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO users (username, email, password_hash, created_at, last_seen)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, email || null, hash, now, now);

    const token = signToken({ id: result.lastInsertRowid, username });
    setCookie(res, token);
    return res.json({
      ok: true,
      token,
      user: {
        id: result.lastInsertRowid,
        username,
        email: email || null,
        rating_bullet: 1500, rating_blitz: 1500, rating_rapid: 1500, rating_classical: 1500,
        games_played: 0, wins: 0, losses: 0, draws: 0,
      }
    });
  } catch (e) {
    console.error('[register]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const db = getDb();
    const user = db.prepare(`
      SELECT id, username, email, password_hash,
             rating_bullet, rating_blitz, rating_rapid, rating_classical,
             games_played, wins, losses, draws
      FROM users WHERE username = ? COLLATE NOCASE
    `).get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), user.id);

    const token = signToken({ id: user.id, username: user.username });
    setCookie(res, token);
    delete user.password_hash;
    res.json({ ok: true, token, user });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT id, username, email,
           rating_bullet, rating_blitz, rating_rapid, rating_classical,
           games_played, wins, losses, draws, created_at
    FROM users WHERE id = ?
  `).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

module.exports = router;
