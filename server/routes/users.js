'use strict';

const express = require('express');
const { query, many, one } = require('../db/pool');
const { authMiddleware } = require('../auth');

const router = express.Router();

const ALLOWED_THEMES = ['cozy', 'dark', 'forest', 'rose', 'ocean'];
const ALLOWED_PIECES = ['classic'];

router.get('/leaderboard', async (req, res) => {
  const category = req.query.category || 'blitz';
  const allowed = ['bullet', 'blitz', 'rapid', 'classical'];
  if (!allowed.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  const col = `rating_${category}`;
  const rows = await many(
    `SELECT username, title, country, ${col} AS rating, games_played, wins, losses, draws
     FROM users WHERE games_played > 0 AND is_flagged = false
     ORDER BY ${col} DESC LIMIT 100`
  );
  res.json({ category, players: rows });
});

// Update current user's profile (bio, country, theme, piece_set)
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const { bio, country, theme, piece_set, title } = req.body || {};

    // Validate
    const updates = {};
    if (bio !== undefined) {
      if (typeof bio !== 'string' || bio.length > 500) return res.status(400).json({ error: 'Bio must be string under 500 chars' });
      updates.bio = bio.trim();
    }
    if (country !== undefined) {
      if (country !== null && (typeof country !== 'string' || country.length > 3)) return res.status(400).json({ error: 'Invalid country code' });
      updates.country = country;
    }
    if (theme !== undefined) {
      if (!ALLOWED_THEMES.includes(theme)) return res.status(400).json({ error: 'Invalid theme' });
      updates.theme = theme;
    }
    if (piece_set !== undefined) {
      if (!ALLOWED_PIECES.includes(piece_set)) return res.status(400).json({ error: 'Invalid piece set' });
      updates.piece_set = piece_set;
    }
    if (title !== undefined) {
      if (title !== null && (typeof title !== 'string' || title.length > 30)) return res.status(400).json({ error: 'Title too long' });
      updates.title = title;
    }

    if (Object.keys(updates).length === 0) return res.json({ ok: true, noop: true });

    const sets = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = Object.values(updates);
    values.push(req.user.id);

    await query(`UPDATE users SET ${sets} WHERE id = $${values.length}`, values);
    res.json({ ok: true });
  } catch (e) {
    console.error('[users update]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:username', async (req, res) => {
  const user = await one(
    `SELECT id, username, bio, country, title, theme, piece_set,
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
