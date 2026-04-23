'use strict';

// Idempotent migration — safe to run on every boot.
// Using raw SQL for clarity. (Drizzle/Prisma work fine here too; this is simpler for deploy.)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  username_lower TEXT UNIQUE NOT NULL,
  email TEXT,
  email_lower TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  rating_bullet INTEGER NOT NULL DEFAULT 1500,
  rating_blitz INTEGER NOT NULL DEFAULT 1500,
  rating_rapid INTEGER NOT NULL DEFAULT 1500,
  rating_classical INTEGER NOT NULL DEFAULT 1500,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  is_flagged BOOLEAN NOT NULL DEFAULT false,
  flag_reason TEXT,
  flagged_at TIMESTAMPTZ,
  recent_accuracies NUMERIC[] NOT NULL DEFAULT ARRAY[]::NUMERIC[],
  recent_acpls NUMERIC[] NOT NULL DEFAULT ARRAY[]::NUMERIC[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  white_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  black_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  white_name TEXT NOT NULL,
  black_name TEXT NOT NULL,
  time_control TEXT NOT NULL,
  initial_time INTEGER NOT NULL,
  increment INTEGER NOT NULL,
  category TEXT NOT NULL,
  rated BOOLEAN NOT NULL DEFAULT true,
  result TEXT,
  winner TEXT,
  termination TEXT,
  pgn TEXT,
  moves JSONB,
  final_fen TEXT,
  white_rating_before INTEGER,
  black_rating_before INTEGER,
  white_rating_after INTEGER,
  black_rating_after INTEGER,
  white_acpl NUMERIC,
  black_acpl NUMERIC,
  white_accuracy NUMERIC,
  black_accuracy NUMERIC,
  analyzed BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_id);
CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_id);
CREATE INDEX IF NOT EXISTS idx_games_ended ON games(ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_analyzed ON games(analyzed) WHERE analyzed = false;

CREATE TABLE IF NOT EXISTS move_telemetry (
  id BIGSERIAL PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  color TEXT NOT NULL,
  ply INTEGER NOT NULL,
  think_ms INTEGER NOT NULL,
  san TEXT NOT NULL,
  fen TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_game ON move_telemetry(game_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_user ON move_telemetry(user_id);

CREATE TABLE IF NOT EXISTS anticheat_reports (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  severity INTEGER NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_user ON anticheat_reports(user_id);

CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id)
);

CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);

CREATE TABLE IF NOT EXISTS focus_events (
  id BIGSERIAL PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_focus_game ON focus_events(game_id);
`;

async function migrate(pool) {
  await pool.query(SCHEMA);
  console.log('[db] schema ensured');
}

module.exports = { migrate };
