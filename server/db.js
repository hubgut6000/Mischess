'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function getDbPath() {
  // Render persistent disk mounts at /var/data by convention — configurable via env
  const dir = process.env.DB_DIR || path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'mischess.db');
}

function initDb() {
  if (db) return db;
  const dbPath = getDbPath();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      email TEXT UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      rating_bullet INTEGER NOT NULL DEFAULT 1500,
      rating_blitz INTEGER NOT NULL DEFAULT 1500,
      rating_rapid INTEGER NOT NULL DEFAULT 1500,
      rating_classical INTEGER NOT NULL DEFAULT 1500,
      games_played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      white_id INTEGER,
      black_id INTEGER,
      white_name TEXT NOT NULL,
      black_name TEXT NOT NULL,
      time_control TEXT NOT NULL,
      initial_time INTEGER NOT NULL,
      increment INTEGER NOT NULL,
      category TEXT NOT NULL,
      rated INTEGER NOT NULL DEFAULT 1,
      result TEXT,
      winner TEXT,
      termination TEXT,
      pgn TEXT,
      moves TEXT,
      final_fen TEXT,
      white_rating_before INTEGER,
      black_rating_before INTEGER,
      white_rating_after INTEGER,
      black_rating_after INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      FOREIGN KEY (white_id) REFERENCES users(id),
      FOREIGN KEY (black_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS move_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      user_id INTEGER,
      ply INTEGER NOT NULL,
      think_ms INTEGER NOT NULL,
      san TEXT NOT NULL,
      fen TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS anticheat_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      game_id TEXT,
      reason TEXT NOT NULL,
      severity INTEGER NOT NULL,
      details TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS friends (
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_id);
    CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_id);
    CREATE INDEX IF NOT EXISTS idx_games_ended ON games(ended_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_game ON move_telemetry(game_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_user ON move_telemetry(user_id);
    CREATE INDEX IF NOT EXISTS idx_reports_user ON anticheat_reports(user_id);
    CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);
  `);

  console.log('[db] initialized at', dbPath);
  return db;
}

function getDb() {
  if (!db) initDb();
  return db;
}

module.exports = { initDb, getDb };
