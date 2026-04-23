'use strict';

const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

router.get('/leaderboard', (req, res) => {
  const category = req.query.category || 'blitz';
  const allowed = ['bullet', 'blitz', 'rapid', 'classical'];
  if (!allowed.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  const col = `rating_${category}`;
  const db = getDb();
  const rows = db.prepare(`
    SELECT username, ${col} AS rating, games_played, wins, losses, draws
    FROM users
    WHERE games_played > 0 AND flagged = 0
    ORDER BY ${col} DESC
    LIMIT 100
  `).all();
  res.json({ category, players: rows });
});

router.get('/:username', (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT id, username,
           rating_bullet, rating_blitz, rating_rapid, rating_classical,
           games_played, wins, losses, draws, flagged, created_at
    FROM users WHERE username = ? COLLATE NOCASE
  `).get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const recentGames = db.prepare(`
    SELECT id, white_name, black_name, category, time_control, result, winner, termination, ended_at
    FROM games
    WHERE (white_id = ? OR black_id = ?) AND ended_at IS NOT NULL
    ORDER BY ended_at DESC LIMIT 20
  `).all(user.id, user.id);

  res.json({ user, recentGames });
});

module.exports = router;
