# Mischess

A fast, free, fair online chess platform. Real-time multiplayer, Elo ratings across four time controls, built-in AI, custom game modes, live spectating, friends, and a heuristic anti-cheat system — all in a single Node.js process.

## Features

- **Real-time play** over WebSockets — bullet, blitz, rapid, classical
- **Persistent accounts** — bcrypt-hashed passwords, JWT sessions, SQLite storage survives restarts
- **Matchmaking** — rating-based opponent selection
- **Play vs AI** — built-in minimax engine with alpha-beta pruning, 8 difficulty levels
- **Custom modes** — Chaos 960, Horde, Berserk Blitz, King of the Hill, Three-check, Atomic Lite
- **Friends system** — add, remove, challenge
- **Leaderboard** — top 100 per category
- **Profiles** — ratings, stats, recent games
- **Live spectating** of in-progress games
- **Watch replays** of finished games
- **In-game chat**
- **Anti-cheat** — move-time variance analysis, focus-loss detection, auto-flagging
- **No emojis, no ads, no tracking**

## Stack

- **Backend**: Node.js, Express, `ws` (WebSockets), `better-sqlite3`, `chess.js`, `bcryptjs`, `jsonwebtoken`
- **Frontend**: Vanilla JS modules, custom SPA router, custom board component with drag-and-drop and click-to-move, zero build step

## Local Development

```bash
git clone <your-repo> mischess
cd mischess
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000

## Deploying to Render

1. Push this repo to GitHub.
2. On [render.com](https://render.com), click **New → Blueprint** and connect your GitHub repo.
3. Render auto-detects `render.yaml` and provisions a web service with a 1GB persistent disk mounted at `/var/data`.
4. The `JWT_SECRET` is auto-generated.
5. Deploy. Done.

The SQLite database lives on the persistent disk, so accounts and games survive deploys and restarts.

### Manual (non-blueprint) Render setup

If you prefer to configure the service manually:

- **Environment**: Node
- **Build command**: `npm install`
- **Start command**: `node server/index.js`
- **Persistent disk**: mount at `/var/data`, size 1 GB
- **Environment variables**:
  - `NODE_ENV=production`
  - `JWT_SECRET=<generate a long random string>`
  - `DB_DIR=/var/data`

## Project Structure

```
mischess/
├── package.json
├── render.yaml              # Render Blueprint config
├── .env.example
├── server/
│   ├── index.js             # Express + HTTP + WS boot
│   ├── db.js                # SQLite + schema
│   ├── auth.js              # JWT sign/verify + middleware
│   ├── rating.js            # Elo / Glicko-2
│   ├── anticheat.js         # Heuristic cheat detection
│   ├── gameManager.js       # In-memory games + matchmaking
│   ├── ws.js                # WebSocket protocol
│   └── routes/
│       ├── auth.js          # /api/auth/*
│       ├── users.js         # /api/users/*
│       ├── games.js         # /api/games/*
│       └── friends.js       # /api/friends/*
└── public/
    ├── index.html
    ├── css/style.css
    ├── img/favicon.svg
    └── js/
        ├── app.js           # SPA: router, auth, views, WS client
        ├── board.js         # Board component (render, drag, click)
        ├── chess.min.js     # Legal move gen + validation + FEN
        ├── ai.js            # Minimax + alpha-beta for play vs computer
        └── pieces.js        # SVG piece data URIs
```

## API

All `/api` endpoints return JSON.

### Auth
- `POST /api/auth/register` `{ username, email?, password }` → `{ user, token }`
- `POST /api/auth/login` `{ username, password }` → `{ user, token }`
- `POST /api/auth/logout`
- `GET /api/auth/me` (authed) → `{ user }`

### Users
- `GET /api/users/:username` → `{ user, recentGames }`
- `GET /api/users/leaderboard?category=blitz` → `{ category, players }`

### Games
- `GET /api/games/live` → `{ games }`
- `GET /api/games/recent` → `{ games }`
- `GET /api/games/:id` → `{ live, game }`

### Friends
- `GET /api/friends` (authed) → `{ friends }`
- `POST /api/friends` `{ username }` (authed)
- `DELETE /api/friends/:username` (authed)

### WebSocket (`/ws?token=...`)

Client messages: `seekGame`, `cancelSeek`, `move`, `resign`, `offerDraw`, `declineDraw`, `abort`, `chat`, `spectate`, `leaveSpectate`, `focusEvent`, `ping`.

Server messages: `connected`, `queued`, `gameStart`, `move`, `clock`, `drawOffered`, `drawDeclined`, `gameEnd`, `chat`, `moveError`, `error`, `pong`.

## Anti-Cheat

Every rated game is analyzed after completion for engine-assistance signals. Flagged accounts are excluded from leaderboards; highly-suspicious accounts are auto-hidden from matchmaking. The system is heuristic, not perfect — false positives are reviewed manually.

Metrics tracked: move-time mean, standard deviation, coefficient of variation, instant-move ratio, focus-loss events during play, timing clustering.

## License

MIT
