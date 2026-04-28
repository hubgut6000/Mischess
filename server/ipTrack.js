'use strict';

const crypto = require('crypto');
const { query, many } = require('./db/pool');

/**
 * Hash an IP with a server-side secret so we can compare IPs across users
 * without ever storing the raw IP. Truncated to first 16 chars (96 bits) to
 * limit reversibility while still being collision-resistant for our use.
 */
function hashIp(ip) {
  if (!ip) return null;
  const secret = process.env.IP_HASH_SECRET || process.env.JWT_SECRET || 'mischess-default-secret';
  return crypto.createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32);
}

/**
 * Record that a user was seen from this IP. Called on login + on each WS connection.
 */
async function recordIp(userId, ip) {
  if (!userId || !ip) return;
  const h = hashIp(ip);
  if (!h) return;
  try {
    await query(
      `INSERT INTO user_ips (user_id, ip_hash, last_seen)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, ip_hash)
       DO UPDATE SET last_seen = NOW()`,
      [userId, h]
    );
  } catch (e) {
    console.error('[ip record]', e.message);
  }
}

/**
 * Find other user IDs who have shared an IP with this user in the last 30 days.
 */
async function findIpSiblings(userId) {
  const rows = await many(
    `SELECT DISTINCT b.user_id FROM user_ips a
     JOIN user_ips b ON a.ip_hash = b.ip_hash AND a.user_id != b.user_id
     WHERE a.user_id = $1
       AND a.last_seen > NOW() - INTERVAL '30 days'
       AND b.last_seen > NOW() - INTERVAL '30 days'`,
    [userId]
  );
  return rows.map(r => r.user_id);
}

/**
 * Check if two users have ever shared an IP. Used to block boost-farming.
 */
async function shareIp(userIdA, userIdB) {
  const rows = await many(
    `SELECT 1 FROM user_ips a
     JOIN user_ips b ON a.ip_hash = b.ip_hash
     WHERE a.user_id = $1 AND b.user_id = $2
       AND a.last_seen > NOW() - INTERVAL '30 days'
       AND b.last_seen > NOW() - INTERVAL '30 days'
     LIMIT 1`,
    [userIdA, userIdB]
  );
  return rows.length > 0;
}

module.exports = { hashIp, recordIp, findIpSiblings, shareIp };
