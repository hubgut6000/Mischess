'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { query, many, one } = require('../db/pool');
const { authMiddleware } = require('../auth');

const router = express.Router();
router.use(authMiddleware);

// Tighter rate limit for messaging to prevent spam
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Sending too quickly. Slow down.' },
});

// =========================================================================
//  FRIENDS LIST
// =========================================================================

router.get('/', async (req, res) => {
  // Bidirectional: a user's friends are anyone with a mutual friendship row
  const rows = await many(
    `SELECT u.id, u.username, u.title, u.country,
            u.rating_bullet, u.rating_blitz, u.rating_rapid, u.rating_classical,
            u.last_seen
     FROM friends f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = $1
     ORDER BY u.last_seen DESC`,
    [req.user.id]
  );
  res.json({ friends: rows });
});

router.delete('/:username', async (req, res) => {
  const friend = await one('SELECT id FROM users WHERE username_lower = $1',
    [req.params.username.toLowerCase()]);
  if (!friend) return res.status(404).json({ error: 'User not found' });
  // Remove both directions
  await query('DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.user.id, friend.id]);
  res.json({ ok: true });
});

// =========================================================================
//  FRIEND REQUESTS
// =========================================================================

router.get('/requests', async (req, res) => {
  const incoming = await many(
    `SELECT r.id, r.from_id, u.username, u.rating_blitz, r.created_at
     FROM friend_requests r JOIN users u ON u.id = r.from_id
     WHERE r.to_id = $1 AND r.status = 'pending'
     ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  const outgoing = await many(
    `SELECT r.id, r.to_id, u.username, r.created_at
     FROM friend_requests r JOIN users u ON u.id = r.to_id
     WHERE r.from_id = $1 AND r.status = 'pending'`,
    [req.user.id]
  );
  res.json({ incoming, outgoing });
});

router.post('/requests', async (req, res) => {
  const { username } = req.body || {};
  if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Username required' });
  const target = await one('SELECT id, username FROM users WHERE username_lower = $1',
    [username.toLowerCase()]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: "Can't friend yourself" });

  // Already friends?
  const already = await one('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2',
    [req.user.id, target.id]);
  if (already) return res.status(409).json({ error: 'Already friends' });

  // Existing request?
  const existing = await one(
    `SELECT id, status FROM friend_requests
     WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)`,
    [req.user.id, target.id]
  );
  if (existing && existing.status === 'pending') {
    return res.status(409).json({ error: 'Friend request already pending' });
  }

  // Create or reactivate
  await query(
    `INSERT INTO friend_requests (from_id, to_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (from_id, to_id) DO UPDATE SET status = 'pending', created_at = NOW()`,
    [req.user.id, target.id]
  );
  res.json({ ok: true });
});

router.post('/requests/:id/accept', async (req, res) => {
  const reqRow = await one(
    `SELECT * FROM friend_requests WHERE id = $1 AND to_id = $2 AND status = 'pending'`,
    [req.params.id, req.user.id]
  );
  if (!reqRow) return res.status(404).json({ error: 'Request not found' });
  // Add bidirectional friendship
  await query('BEGIN');
  try {
    await query(
      `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
      [reqRow.from_id, reqRow.to_id]
    );
    await query(
      `UPDATE friend_requests SET status = 'accepted', responded_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    await query('COMMIT');
  } catch (e) {
    await query('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

router.post('/requests/:id/decline', async (req, res) => {
  const reqRow = await one(
    `SELECT * FROM friend_requests WHERE id = $1 AND to_id = $2 AND status = 'pending'`,
    [req.params.id, req.user.id]
  );
  if (!reqRow) return res.status(404).json({ error: 'Request not found' });
  await query(
    `UPDATE friend_requests SET status = 'declined', responded_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
});

// =========================================================================
//  DIRECT MESSAGES
// =========================================================================

// Sanitize message body — strip control chars, cap length
function sanitizeMessage(s) {
  if (typeof s !== 'string') return null;
  // Strip null bytes and most control chars but keep newlines/tabs
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  s = s.trim();
  if (s.length === 0 || s.length > 1000) return null;
  return s;
}

// List my conversations (unique partners with most recent message)
router.get('/messages', async (req, res) => {
  const rows = await many(
    `SELECT DISTINCT ON (other_id)
            other_id, username, title, body, created_at, mine
     FROM (
       SELECT to_id AS other_id, u.username, u.title, body, created_at, true AS mine
       FROM direct_messages d JOIN users u ON u.id = d.to_id
       WHERE from_id = $1
       UNION ALL
       SELECT from_id AS other_id, u.username, u.title, body, created_at, false AS mine
       FROM direct_messages d JOIN users u ON u.id = d.from_id
       WHERE to_id = $1
     ) t
     ORDER BY other_id, created_at DESC`,
    [req.user.id]
  );
  // Sort all by most recent
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ conversations: rows });
});

// Get messages with one user
router.get('/messages/:username', async (req, res) => {
  const other = await one('SELECT id, username FROM users WHERE username_lower = $1',
    [req.params.username.toLowerCase()]);
  if (!other) return res.status(404).json({ error: 'User not found' });

  // Must be friends to DM
  const friendship = await one('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2',
    [req.user.id, other.id]);
  if (!friendship) return res.status(403).json({ error: 'You can only message friends' });

  const messages = await many(
    `SELECT id, from_id, to_id, body, created_at
     FROM direct_messages
     WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)
     ORDER BY created_at ASC LIMIT 200`,
    [req.user.id, other.id]
  );
  // Mark as read
  await query(
    `UPDATE direct_messages SET read_at = NOW()
     WHERE to_id = $1 AND from_id = $2 AND read_at IS NULL`,
    [req.user.id, other.id]
  );
  res.json({ messages, partner: other });
});

router.post('/messages/:username', messageLimiter, async (req, res) => {
  const other = await one('SELECT id FROM users WHERE username_lower = $1',
    [req.params.username.toLowerCase()]);
  if (!other) return res.status(404).json({ error: 'User not found' });
  if (other.id === req.user.id) return res.status(400).json({ error: "Can't message yourself" });

  // Must be friends
  const friendship = await one('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2',
    [req.user.id, other.id]);
  if (!friendship) return res.status(403).json({ error: 'You can only message friends' });

  const body = sanitizeMessage(req.body?.body);
  if (!body) return res.status(400).json({ error: 'Empty or invalid message' });

  const row = await one(
    `INSERT INTO direct_messages (from_id, to_id, body)
     VALUES ($1, $2, $3) RETURNING id, created_at`,
    [req.user.id, other.id, body]
  );
  res.json({ ok: true, message: { id: row.id, body, created_at: row.created_at, from_id: req.user.id, to_id: other.id } });
});

// =========================================================================
//  CHALLENGES (challenge friend to a game)
// =========================================================================

router.get('/challenges', async (req, res) => {
  const incoming = await many(
    `SELECT c.id, c.from_id, u.username, c.initial_time, c.increment, c.rated, c.color, c.created_at
     FROM challenges c JOIN users u ON u.id = c.from_id
     WHERE c.to_id = $1 AND c.status = 'pending'
       AND (c.expires_at IS NULL OR c.expires_at > NOW())
     ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  res.json({ incoming });
});

router.post('/challenges', async (req, res) => {
  const { username, initialTime, increment, rated, color } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  const time = parseInt(initialTime, 10);
  const inc = parseInt(increment, 10) || 0;
  if (!time || time < 30 || time > 7200) return res.status(400).json({ error: 'Invalid time control' });
  if (inc < 0 || inc > 60) return res.status(400).json({ error: 'Invalid increment' });
  const validColor = ['white', 'black', 'random'].includes(color) ? color : 'random';

  const target = await one('SELECT id FROM users WHERE username_lower = $1',
    [username.toLowerCase()]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: "Can't challenge yourself" });

  // Must be friends to challenge
  const friendship = await one('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2',
    [req.user.id, target.id]);
  if (!friendship) return res.status(403).json({ error: 'You can only challenge friends' });

  // Cancel any prior pending challenges from us to them
  await query(
    `UPDATE challenges SET status = 'cancelled' WHERE from_id = $1 AND to_id = $2 AND status = 'pending'`,
    [req.user.id, target.id]
  );

  const row = await one(
    `INSERT INTO challenges (from_id, to_id, initial_time, increment, rated, color, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '5 minutes')
     RETURNING id`,
    [req.user.id, target.id, time, inc, !!rated, validColor]
  );
  res.json({ ok: true, id: row.id });
});

router.post('/challenges/:id/accept', async (req, res) => {
  const ch = await one(
    `SELECT * FROM challenges WHERE id = $1 AND to_id = $2 AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [req.params.id, req.user.id]
  );
  if (!ch) return res.status(404).json({ error: 'Challenge not found or expired' });

  // Pair-history check: prevent boost-farming
  const [a, b] = ch.from_id < ch.to_id ? [ch.from_id, ch.to_id] : [ch.to_id, ch.from_id];
  const pair = await one('SELECT * FROM pair_history WHERE user_a = $1 AND user_b = $2', [a, b]);
  if (pair && ch.rated) {
    // Limit rated games between same pair to 5 per 24h
    const recent = (pair.recent_games || []).filter(t => Date.now() - new Date(t).getTime() < 24 * 3600 * 1000);
    if (recent.length >= 5) {
      await query(`UPDATE challenges SET status = 'declined' WHERE id = $1`, [ch.id]);
      return res.status(429).json({
        error: 'Too many rated games with this player recently. Try a casual game instead.',
      });
    }
  }

  // Mark accepted - the actual game will be created via WS
  await query(
    `UPDATE challenges SET status = 'accepted', responded_at = NOW() WHERE id = $1`,
    [ch.id]
  );
  res.json({ ok: true, challenge: ch });
});

router.post('/challenges/:id/decline', async (req, res) => {
  const ch = await one(
    `SELECT * FROM challenges WHERE id = $1 AND to_id = $2 AND status = 'pending'`,
    [req.params.id, req.user.id]
  );
  if (!ch) return res.status(404).json({ error: 'Challenge not found' });
  await query(
    `UPDATE challenges SET status = 'declined', responded_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
});

router.post('/challenges/:id/cancel', async (req, res) => {
  const ch = await one(
    `SELECT * FROM challenges WHERE id = $1 AND from_id = $2 AND status = 'pending'`,
    [req.params.id, req.user.id]
  );
  if (!ch) return res.status(404).json({ error: 'Challenge not found' });
  await query(
    `UPDATE challenges SET status = 'cancelled', responded_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
});

module.exports = router;
