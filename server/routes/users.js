'use strict';

const express = require('express');
const { many, one } = require('../db/pool');

const router = express.Router();

router.get('/leaderboard', async (req, res) => {
  const category = req.query.category || 'blitz';
  const allowed = ['bullet', 'blitz', 'rapid', 'classical'];
  if (!allowed.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  const col = `rating_${category}`;
  const rows = await many(
    `SELECT username, ${col} AS rating, games_played, wins, losses, draws
     FROM users WHERE games_played > 0 AND is_flagged = false
     ORDER BY ${col} DESC LIMIT 100`
  );
  res.json({ category, players: rows });
});

router.get('/:username', async (req, res) => {
  const user = await one(
    `SELECT id, username,
            rating_bullet, rating_blitz, rating_rapid, rating_classical,
            games_played, wins, losses, draws, is_flagged, created_at
     FROM users WHERE username_lower = $1`,
    [req.params.username.toLowerCase()]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });

  const recentGames = await many(
    `SELECT id, white_name, black_name, category, time_control, result, winner, termination, ended_at,
            white_acpl, black_acpl, white_accuracy, black_accuracy
     FROM games WHERE (white_id = $1 OR black_id = $1) AND ended_at IS NOT NULL
     ORDER BY ended_at DESC LIMIT 20`,
    [user.id]
  );

  // Hide is_flagged from public display — shadow-ban is silent
  const publicUser = { ...user };
  delete publicUser.is_flagged;
  res.json({ user: publicUser, recentGames });
});

module.exports = router;
