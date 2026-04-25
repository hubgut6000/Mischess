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
  bio TEXT,
  country TEXT,
  theme TEXT DEFAULT 'cozy',
  piece_set TEXT DEFAULT 'classic',
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add columns if users table existed before this migration
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'cozy';
ALTER TABLE users ADD COLUMN IF NOT EXISTS piece_set TEXT DEFAULT 'classic';
ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT;

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

-- Per-move analysis cache. Populated by background analysis queue or on-demand.
CREATE TABLE IF NOT EXISTS analysis_moves (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  played_san TEXT NOT NULL,
  best_move_san TEXT,
  eval_before NUMERIC,
  eval_after NUMERIC,
  classification TEXT,
  PRIMARY KEY (game_id, ply)
);

CREATE INDEX IF NOT EXISTS idx_analysis_game ON analysis_moves(game_id);

-- Friend requests: pending/accepted/blocked
CREATE TABLE IF NOT EXISTS friend_requests (
  id SERIAL PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  UNIQUE (from_id, to_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_req_to ON friend_requests(to_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_req_from ON friend_requests(from_id, status);

-- Direct messages between users
CREATE TABLE IF NOT EXISTS direct_messages (
  id BIGSERIAL PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(from_id, to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_to ON direct_messages(to_id, read_at);

-- Friend challenges (pending direct game offers)
CREATE TABLE IF NOT EXISTS challenges (
  id SERIAL PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initial_time INTEGER NOT NULL,
  increment INTEGER NOT NULL DEFAULT 0,
  rated BOOLEAN NOT NULL DEFAULT false,
  color TEXT NOT NULL DEFAULT 'random',
  status TEXT NOT NULL DEFAULT 'pending',
  game_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_challenges_to ON challenges(to_id, status);

-- Behavioral restrictions (resignation farming, account boosting, harassment)
CREATE TABLE IF NOT EXISTS restrictions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_restrictions_user ON restrictions(user_id, active);

-- Recent quick resigns (for resignation farming detection)
ALTER TABLE users ADD COLUMN IF NOT EXISTS recent_quick_resigns INTEGER NOT NULL DEFAULT 0;

-- Boost detection: track repeat opponents and IP fingerprints
CREATE TABLE IF NOT EXISTS pair_history (
  user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  games_count INTEGER NOT NULL DEFAULT 0,
  recent_games TIMESTAMPTZ[] NOT NULL DEFAULT ARRAY[]::TIMESTAMPTZ[],
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE INDEX IF NOT EXISTS idx_pair_count ON pair_history(games_count);

-- IP fingerprint for boost/multi-account detection
CREATE TABLE IF NOT EXISTS user_ips (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_hash TEXT NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, ip_hash)
);

CREATE INDEX IF NOT EXISTS idx_user_ips_hash ON user_ips(ip_hash);
`;

async function migrate(pool) {
  await pool.query(SCHEMA);
  console.log('[db] schema ensured');
}

module.exports = { migrate };
