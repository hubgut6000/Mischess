'use strict';

const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = express.Router();

router.use(authMiddleware);

// List friends
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.id, u.username, u.rating_bullet, u.rating_blitz, u.rating_rapid, u.rating_classical, u.last_seen
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY u.last_seen DESC
  `).all(req.user.id);
  res.json({ friends: rows });
});

// Add friend
router.post('/', (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const db = getDb();
  const friend = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!friend) return res.status(404).json({ error: 'User not found' });
  if (friend.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
  try {
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)')
      .run(req.user.id, friend.id, Date.now());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove friend
router.delete('/:username', (req, res) => {
  const db = getDb();
  const friend = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(req.params.username);
  if (!friend) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(req.user.id, friend.id);
  res.json({ ok: true });
});

module.exports = router;
