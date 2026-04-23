'use strict';

const express = require('express');
const { getDb } = require('../db');
const { games } = require('../gameManager');

const router = express.Router();

router.get('/recent', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, white_name, black_name, category, time_control, result, winner, termination, ended_at
    FROM games
    WHERE ended_at IS NOT NULL
    ORDER BY ended_at DESC LIMIT 30
  `).all();
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
        moves: g.chess.history().length,
      });
    }
  }
  res.json({ games: live.slice(0, 30) });
});

router.get('/:id', (req, res) => {
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
        fen: live.chess.fen(),
        pgn: live.chess.pgn(),
        moves: live.chess.history(),
        ended: live.ended,
        result: live.result,
        winner: live.winner,
      }
    });
  }

  const db = getDb();
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json({ live: false, game });
});

module.exports = router;
