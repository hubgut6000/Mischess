# Mischess

A high-performance online chess platform. Real-time multiplayer, AI opponents, ACPL-based anti-cheat with shadow-pool matchmaking, Elo ratings across four time controls, custom game modes, friends system, live spectating, and a full audio engine — all in a single Node.js process.

## Features

### Play
- **Real-time multiplayer** over WebSockets — bullet, blitz, rapid, classical
- **Play vs AI** — Stockfish WASM running in a Web Worker, with presets from 800 to 2700 Elo (Stockfish Skill Level + UCI_Elo)
- **Custom modes** — Chaos 960, Horde, Berserk Blitz, King of the Hill, Three-check, Atomic Lite
- **Live spectating**, finished-game replay, in-game chat, friends
- **Profiles** with ACPL and accuracy shown on every game

### Anti-cheat ("Accuracy Pulse")
- Post-game Stockfish analysis computes **Average Centipawn Loss** (ACPL) and **move-by-move accuracy** using Lichess's win-percentage formula
- Each user has a rolling window of the last 6 games' accuracy and ACPL stored in Postgres
- Crossing thresholds (>97% avg accuracy or <10 avg ACPL over 3+ games) silently sets `is_flagged = true`
- **Shadow-pool matchmaking**: flagged users only match with other flagged users. Nothing visible changes for them.
- Secondary signals: move-time variance, instant-move ratio, focus-loss events during rated games
- Background analysis queue processes games asynchronously — never blocks play

### Audio
- Web Audio API synth — zero-latency, no files to load
- Button click/pop on every interactive element
- Ambient rhythmic search sound while matchmaking
- Distinct match-found chime, move/capture/check/victory cues
- Full on/off toggle in Settings, persisted to localStorage

### Code quality
- `GameCore` class isolates chess logic (move validation, turn management, termination detection) from session/IO/database
- Stockfish runs in a Web Worker on client and a child process on server — UI and request thread never block
- All move validation happens server-side — client is a view + hint layer only
- Argon2id password hashing (replaces bcrypt)
- Helmet CSP, rate limiting, JWT over httpOnly cookies

## Stack

- **Backend**: Node.js 20, Express, `ws`, `pg` (Postgres), `chess.js`, `argon2`, `jsonwebtoken`, Stockfish (child process)
- **Frontend**: Vanilla JS modules, custom SPA router, custom board with drag-and-drop + click-to-move, Stockfish WASM in a Web Worker (loaded from CDN with local minimax fallback), Web Audio API sound engine
- **Database**: PostgreSQL 16

## Deploy to Render

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Blueprint** → connect your repo.
3. Render reads `render.yaml`, provisions a Postgres database, installs Stockfish via apt during the build, generates `JWT_SECRET`, runs migrations on first boot, and deploys.

The database is persistent; the web service is stateless.

### Manual Render setup

If not using the Blueprint:

- **Environment**: Node
- **Build command**: `apt-get update && apt-get install -y stockfish || true && npm install`
- **Start command**: `node server/index.js`
- **Environment variables**:
  - `NODE_VERSION=20.18.1`
  - `NODE_ENV=production`
  - `JWT_SECRET=<long random string>`
  - `DATABASE_URL=<your Postgres connection string>`
  - `STOCKFISH_PATH=stockfish` *(optional — server runs without if missing; anti-cheat analysis is skipped)*
  - `ANALYSIS_DEPTH=12` *(lower to 8-10 on free/starter plans for speed)*

Create the Postgres database in Render first, copy the **Internal Connection String** into `DATABASE_URL`.

## Local Development

```bash
# 1. Install Postgres locally (or use Docker)
docker run --name mischess-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16

# 2. Install Stockfish (optional; anti-cheat analysis needs it)
# macOS:  brew install stockfish
# Ubuntu: sudo apt install stockfish
# Windows: download from https://stockfishchess.org/download/

# 3. Set up env
cp .env.example .env
# Edit .env and set DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres

# 4. Install and run
npm install
npm start

# 5. Open http://localhost:3000
```

Migrations run automatically on boot; no separate migrate step needed.

## Project Structure

```
mischess/
├── package.json
├── render.yaml               # Render Blueprint (provisions Postgres + Stockfish)
├── .env.example
├── server/
│   ├── index.js              # Express + HTTP + WS boot, runs migrations
│   ├── auth.js               # JWT + Argon2id
│   ├── gameCore.js           # Pure chess logic (move validation, termination)
│   ├── gameManager.js        # Live games + shadow-pool matchmaking
│   ├── ws.js                 # WebSocket protocol
│   ├── rating.js             # Elo / Glicko-2
│   ├── anticheat.js          # ACPL + accuracy + rolling windows + flag logic
│   ├── stockfishAnalyzer.js  # Stockfish child process wrapper
│   ├── db/
│   │   ├── pool.js           # pg Pool + query helpers
│   │   ├── schema.js         # Idempotent schema migration
│   │   └── migrate.js        # Standalone CLI migrator
│   └── routes/
│       ├── auth.js           # /api/auth/*
│       ├── users.js          # /api/users/*
│       ├── games.js          # /api/games/*
│       └── friends.js        # /api/friends/*
└── public/
    ├── index.html
    ├── css/style.css
    ├── img/favicon.svg
    └── js/
        ├── app.js            # SPA: router, auth, views, WS client, sound wiring
        ├── board.js          # Board component (render, drag, click-to-move)
        ├── chess.min.js      # Client-side legal move gen
        ├── ai.js             # Local minimax fallback for Stockfish
        ├── stockfish.js      # Stockfish WASM Worker wrapper
        ├── sound.js          # Web Audio SoundManager
        └── pieces.js         # SVG piece data URIs
```

## Database Schema

See `server/db/schema.js`. Key tables:

- `users` — credentials, ratings per category, `is_flagged`, `recent_accuracies`, `recent_acpls`
- `games` — full game record + `white_acpl`, `black_acpl`, `white_accuracy`, `black_accuracy`, `analyzed`
- `move_telemetry` — per-move think time and resulting FEN for post-game analysis
- `focus_events` — blur/focus events during rated games
- `anticheat_reports` — raised by the analyzer when thresholds are crossed
- `friends` — simple follow graph

## API

All `/api` endpoints return JSON.

### Auth
- `POST /api/auth/register` `{ username, email?, password }` → `{ user, token }`
- `POST /api/auth/login` `{ username, password }` → `{ user, token }`
- `POST /api/auth/logout`
- `GET /api/auth/me` (authed) → `{ user }`

### Users
- `GET /api/users/:username` → `{ user, recentGames }` *(is_flagged never exposed publicly)*
- `GET /api/users/leaderboard?category=blitz` → `{ category, players }` *(flagged users hidden)*

### Games
- `GET /api/games/live` → `{ games }` — in-progress games
- `GET /api/games/recent` → `{ games }` — last 30 finished
- `GET /api/games/:id` → `{ live, game }` — live snapshot or full record

### Friends
- `GET /api/friends` (authed) → `{ friends }`
- `POST /api/friends` `{ username }` (authed)
- `DELETE /api/friends/:username` (authed)

### WebSocket (`/ws?token=...`)

Client: `seekGame`, `cancelSeek`, `move`, `resign`, `offerDraw`, `declineDraw`, `abort`, `chat`, `spectate`, `leaveSpectate`, `focusEvent`, `ping`

Server: `connected`, `queued`, `gameStart`, `move`, `clock`, `drawOffered`, `drawDeclined`, `gameEnd`, `chat`, `moveError`, `error`, `pong`

## Configuration

Environment variables (`.env` locally, Render env vars in production):

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | 3000 |
| `NODE_ENV` | `production` turns on cookie `secure` flag | — |
| `DATABASE_URL` | Postgres connection string | *required* |
| `JWT_SECRET` | Session signing key | dev default — **must** change in prod |
| `STOCKFISH_PATH` | Path to Stockfish binary for analysis | `stockfish` |
| `ANALYSIS_DEPTH` | Stockfish depth for per-move eval (higher = slower but more accurate) | 12 |

## License

MIT
