'use strict';

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL not set — cannot connect to Postgres');
  }
  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => console.error('[pg pool]', err));
  return pool;
}

async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

async function one(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

async function many(text, params) {
  const res = await query(text, params);
  return res.rows;
}

async function tx(fn) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, one, many, tx };
