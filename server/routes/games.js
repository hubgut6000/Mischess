'use strict';

const express = require('express');
const { many, one } = require('../db/pool');
const { games } = require('../gameManager');

const router = express.Router();

router.get('/recent', async (req, res) => {
  const rows = await many(
    `SELECT id, white_name, black_name, category, time_control, result, winner, termination, ended_at,
            white_acpl, black_acpl, white_accuracy, black_accuracy
     FROM games WHERE ended_at IS NOT NULL
     ORDER BY ended_at DESC LIMIT 30`
  );
  res.json({ games: rows });
});

router.get('/live', (req, res) => {
  const live = [];
  for (const g of games.values()) {
    if (!g.ended) {
      live.push({
        id: g.id,
        white: g.whiteName,
        black: g.blackName,
        whiteRating: g.whiteRating,
        blackRating: g.blackRating,
        category: g.category,
        timeControl: g.timeControl,
        moves: g.core.history().length,
      });
    }
  }
  res.json({ games: live.slice(0, 30) });
});

router.get('/:id', async (req, res) => {
  const live = games.get(req.params.id);
  if (live) {
    return res.json({
      live: true,
      game: {
        id: live.id,
        white: live.whiteName,
        black: live.blackName,
        whiteRating: live.whiteRating,
        blackRating: live.blackRating,
        timeControl: live.timeControl,
        category: live.category,
        fen: live.core.fen,
        pgn: live.core.pgn,
        moves: live.core.history(),
        ended: live.ended,
        result: live.result,
        winner: live.winner,
      }
    });
  }
  const game = await one('SELECT * FROM games WHERE id = $1', [req.params.id]);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json({ live: false, game });
});

module.exports = router;
