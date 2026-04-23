'use strict';

const express = require('express');
const { query, many, one } = require('../db/pool');
const { authMiddleware } = require('../auth');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  const rows = await many(
    `SELECT u.id, u.username, u.rating_bullet, u.rating_blitz, u.rating_rapid, u.rating_classical, u.last_seen
     FROM friends f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = $1
     ORDER BY u.last_seen DESC`,
    [req.user.id]
  );
  res.json({ friends: rows });
});

router.post('/', async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const friend = await one('SELECT id, username FROM users WHERE username_lower = $1', [username.toLowerCase()]);
  if (!friend) return res.status(404).json({ error: 'User not found' });
  if (friend.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
  await query(
    `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [req.user.id, friend.id]
  );
  res.json({ ok: true });
});

router.delete('/:username', async (req, res) => {
  const friend = await one('SELECT id FROM users WHERE username_lower = $1', [req.params.username.toLowerCase()]);
  if (!friend) return res.status(404).json({ error: 'User not found' });
  await query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [req.user.id, friend.id]);
  res.json({ ok: true });
});

module.exports = router;
