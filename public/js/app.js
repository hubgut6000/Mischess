import { Board } from './board.js';
import { findBestMove } from './ai.js';
import { sound, installClickSounds } from './sound.js';
import { StockfishEngine } from './stockfish.js';
import { AntiCheatTelemetry } from './anticheat.js';

// ---------- State ----------
const state = {
  user: null,
  token: null,
  ws: null,
  wsReconnectTimer: null,
  game: null,          // current game snapshot
  gameTimers: null,
  board: null,
  playerColor: null,
  focusBlurListener: null,
  stockfish: null,     // persistent engine instance
  settings: loadSettings(),
  lastFen: null,       // to detect move type (capture/check) for sound
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('mischess:settings');
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {}
  return defaultSettings();
}
function defaultSettings() {
  return { sound: true, moveSound: true, boardTheme: 'classic', theme: 'cozy' };
}
function saveSettings() {
  try { localStorage.setItem('mischess:settings', JSON.stringify(state.settings)); } catch {}
  sound.setEnabled(state.settings.sound);
}

// ---------- Utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function toast(msg, type = 'info') {
  const container = $('#toast-container');
  const t = h('div', { class: `toast ${type}` }, msg);
  container.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; }, 3500);
  setTimeout(() => t.remove(), 3900);
}

function fmtTime(ms) {
  if (ms == null) return '--:--';
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (ms < 10000) {
    const tenths = Math.floor(ms / 100) % 10;
    return `${String(m).padStart(1,'0')}:${String(s).padStart(2,'0')}.${tenths}`;
  }
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// Read CSRF token from cookie (set by server on login/register/me)
function getCsrf() {
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  // Add CSRF token for state-changing requests
  const method = (opts.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = getCsrf();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(path, {
    ...opts,
    headers,
    credentials: 'include',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ---------- Theme ----------
function applyTheme(theme) {
  if (!theme) theme = 'cozy';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('mischess:theme', theme); } catch {}
  state.settings.theme = theme;
}

// ---------- Auth ----------
function loadToken() {
  try { return localStorage.getItem('mischess:token'); } catch { return null; }
}
function saveToken(t) { try { t ? localStorage.setItem('mischess:token', t) : localStorage.removeItem('mischess:token'); } catch {} }

async function checkAuth() {
  state.token = loadToken();
  if (!state.token) return;
  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
    // Apply user's saved theme
    if (user.theme) applyTheme(user.theme);
    renderAuthArea();
  } catch (e) {
    state.token = null;
    state.user = null;
    saveToken(null);
  }
}

function renderAuthArea() {
  const area = $('#auth-area');
  area.innerHTML = '';
  if (state.user) {
    const initial = state.user.username[0].toUpperCase();
    area.appendChild(h('a', {
      href: `#/profile/${state.user.username}`,
      'data-link': '',
      class: 'user-pill',
    },
      h('span', { class: 'avatar' }, initial),
      h('span', { class: 'username' }, state.user.username),
      h('span', { class: 'rating' }, `${state.user.rating_blitz}`),
    ));
    area.appendChild(h('button', { class: 'btn btn-ghost btn-sm', onclick: logout }, 'Sign out'));
  } else {
    area.appendChild(h('a', { href: '#/login', 'data-link': '', class: 'btn btn-ghost' }, 'Sign in'));
    area.appendChild(h('a', { href: '#/register', 'data-link': '', class: 'btn btn-primary' }, 'Register'));
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  state.user = null;
  state.token = null;
  saveToken(null);
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  renderAuthArea();
  navigate('#/');
}

// ---------- Router ----------
const routes = [];
function route(pattern, handler) { routes.push({ pattern, handler }); }

function parseRoute(hash) {
  hash = (hash || '#/').replace(/^#/, '');
  if (!hash.startsWith('/')) hash = '/' + hash;
  for (const { pattern, handler } of routes) {
    const parts = pattern.split('/');
    const segs = hash.split('/');
    if (parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (parts[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

function navigate(hash) { location.hash = hash; }

async function renderRoute() {
  const match = parseRoute(location.hash);
  // Leave any active game WS room if we leave /game/:id
  if (!location.hash.startsWith('#/game/') && state.game) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'leaveSpectate' }));
    }
    cleanupGame();
  }
  // Update active link
  $$('.main-nav a').forEach(a => a.classList.toggle('active',
    (location.hash || '#/').startsWith(a.getAttribute('href'))));
  const view = $('#view');
  view.innerHTML = '';
  if (!match) { view.appendChild(renderNotFound()); return; }
  try {
    const content = await match.handler(match.params);
    if (content) view.appendChild(content);
  } catch (e) {
    console.error(e);
    view.appendChild(h('div', { class: 'loading' }, 'Error: ' + e.message));
  }
}

window.addEventListener('hashchange', renderRoute);

// Interceptor for internal links
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('#')) return;
  e.preventDefault();
  navigate(href);
});

// ---------- WebSocket ----------
function ensureWs() {
  return new Promise((resolve, reject) => {
    if (state.ws && state.ws.readyState === 1) return resolve(state.ws);
    if (!state.token) return reject(new Error('Not authenticated'));
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(state.token)}`);
    state.ws = ws;
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('WebSocket error'));
    ws.onmessage = onWsMessage;
    ws.onclose = () => {
      state.ws = null;
      if (state.user) {
        clearTimeout(state.wsReconnectTimer);
        state.wsReconnectTimer = setTimeout(() => ensureWs().catch(() => {}), 2000);
      }
    };
  });
}

function sendWs(msg) {
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function onWsMessage(ev) {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  switch (msg.type) {
    case 'connected': break;
    case 'queued':
      onQueued();
      break;
    case 'queueCancelled':
      onQueueCancelled();
      break;
    case 'gameStart':
      onGameStart(msg.game, msg.yourColor);
      break;
    case 'move':
      onGameUpdate(msg.game, msg.lastMove);
      break;
    case 'clock':
      onClockTick(msg.whiteTime, msg.blackTime);
      break;
    case 'drawOffered':
      onDrawOffered(msg.from);
      break;
    case 'drawDeclined':
      toast('Draw offer declined');
      break;
    case 'gameEnd':
      onGameEnd(msg.game);
      break;
    case 'chat':
      onChatMessage(msg);
      break;
    case 'moveError':
      sound.error();
      toast(msg.error, 'error');
      if (state.board && state.game) state.board.setPosition(state.game.fen);
      break;
    case 'error':
      toast(msg.error, 'error');
      break;
  }
}

// ---------- Views ----------

// HOME
route('/', async () => {
  const view = h('div');
  const hero = h('section', { class: 'hero' },
    h('div', {},
      h('h1', { class: 'hero-title' }, 'Play chess. ', h('em', {}, 'Seriously.')),
      h('p', { class: 'hero-sub' }, 'Mischess is a fast, fair, free chess platform. Ranked matches across four time controls, custom modes, live spectating, and the strongest anti-cheat in the game.'),
      h('div', { class: 'hero-cta' },
        h('a', { href: '#/play', 'data-link': '', class: 'btn btn-primary' }, 'Play now'),
        h('a', { href: '#/play/ai', 'data-link': '', class: 'btn btn-ghost' }, 'Play vs AI'),
        h('a', { href: '#/leaderboard', 'data-link': '', class: 'btn btn-ghost' }, 'Leaderboard'),
      ),
    ),
    h('div', { class: 'hero-chessboard', id: 'hero-board' }),
  );
  view.appendChild(hero);

  const stats = h('section', { class: 'stats-strip', id: 'stats' });
  view.appendChild(stats);

  view.appendChild(h('section', { class: 'features' },
    h('div', { class: 'feature-card' },
      h('h3', {}, 'Real-time play'),
      h('p', {}, 'Bullet, blitz, rapid, classical. Sub-100ms move transport over WebSocket. Clocks accurate to the millisecond.'),
    ),
    h('div', { class: 'feature-card' },
      h('h3', {}, 'Fair play, enforced'),
      h('p', {}, 'Continuous move-time analysis, focus tracking, and multi-account detection. Cheaters get caught, honest players get clean games.'),
    ),
    h('div', { class: 'feature-card' },
      h('h3', {}, 'Custom modes'),
      h('p', {}, 'Beyond standard: try Chaos Chess, Berserk Blitz, King of the Hill-style variants, and private challenges with friends.'),
    ),
  ));

  // Hero board - animated random game
  setTimeout(() => {
    const boardEl = $('#hero-board');
    if (!boardEl) return;
    const board = new Board(boardEl, { interactive: false });
    board.setPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    // Auto-play a famous opening
    const opening = ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','Be7','Re1','b5','Bb3','d6','c3','O-O'];
    let i = 0;
    const iv = setInterval(() => {
      if (i >= opening.length) { clearInterval(iv); return; }
      if (!document.body.contains(boardEl)) { clearInterval(iv); return; }
      const from = board.chess.fen();
      const m = board.chess.move(opening[i]);
      if (m) board.setLastMove(m.from, m.to);
      board.render();
      i++;
    }, 1200);
  }, 100);

  // Fetch stats
  try {
    const [live, recent] = await Promise.all([
      fetch('/api/games/live').then(r => r.json()).catch(() => ({ games: [] })),
      fetch('/api/games/recent').then(r => r.json()).catch(() => ({ games: [] })),
    ]);
    const statsEl = $('#stats', view);
    statsEl.appendChild(h('div', { class: 'stat' },
      h('div', { class: 'stat-number' }, String(live.games.length)),
      h('div', { class: 'stat-label' }, 'Live games')));
    statsEl.appendChild(h('div', { class: 'stat' },
      h('div', { class: 'stat-number' }, String(recent.games.length)),
      h('div', { class: 'stat-label' }, 'Games today')));
    statsEl.appendChild(h('div', { class: 'stat' },
      h('div', { class: 'stat-number' }, '4'),
      h('div', { class: 'stat-label' }, 'Time controls')));
    statsEl.appendChild(h('div', { class: 'stat' },
      h('div', { class: 'stat-number' }, '0'),
      h('div', { class: 'stat-label' }, 'Ads, ever')));
  } catch {}
  return view;
});

// LOGIN
route('/login', async () => {
  if (state.user) { navigate('#/'); return null; }
  const view = h('div', { class: 'auth-page' });
  view.appendChild(h('h2', {}, 'Welcome back'));
  const errBox = h('div');
  view.appendChild(errBox);
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const username = $('input[name=username]', form).value;
    const password = $('input[name=password]', form).value;
    errBox.innerHTML = '';
    try {
      const { user, token } = await api('/api/auth/login', { method: 'POST', body: { username, password } });
      state.user = user;
      state.token = token;
      saveToken(token);
      renderAuthArea();
      toast('Signed in', 'success');
      navigate('#/');
    } catch (err) {
      errBox.appendChild(h('div', { class: 'error-message' }, err.message));
    }
  }});
  form.appendChild(fieldInput('Username', 'username', 'text', true));
  form.appendChild(fieldInput('Password', 'password', 'password', true));
  form.appendChild(h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in'));
  view.appendChild(form);
  view.appendChild(h('p', { class: 'form-meta' }, 'No account? ',
    h('a', { href: '#/register', 'data-link': '' }, 'Create one')));
  return view;
});

// REGISTER
route('/register', async () => {
  if (state.user) { navigate('#/'); return null; }
  const view = h('div', { class: 'auth-page' });
  view.appendChild(h('h2', {}, 'Create account'));
  const errBox = h('div');
  view.appendChild(errBox);
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const username = $('input[name=username]', form).value;
    const email = $('input[name=email]', form).value;
    const password = $('input[name=password]', form).value;
    errBox.innerHTML = '';
    try {
      const { user, token } = await api('/api/auth/register', { method: 'POST', body: { username, email, password } });
      state.user = user;
      state.token = token;
      saveToken(token);
      renderAuthArea();
      toast('Welcome to Mischess', 'success');
      navigate('#/');
    } catch (err) {
      errBox.appendChild(h('div', { class: 'error-message' }, err.message));
    }
  }});
  form.appendChild(fieldInput('Username', 'username', 'text', true));
  form.appendChild(fieldInput('Email (optional)', 'email', 'email', false));
  form.appendChild(fieldInput('Password', 'password', 'password', true));
  form.appendChild(h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create account'));
  view.appendChild(form);
  view.appendChild(h('p', { class: 'form-meta' }, 'Have an account? ',
    h('a', { href: '#/login', 'data-link': '' }, 'Sign in')));
  return view;
});

function fieldInput(label, name, type, required) {
  return h('div', { class: 'form-field' },
    h('label', {}, label),
    h('input', { name, type, required: required ? '' : null, autocomplete: type === 'password' ? 'current-password' : 'username' }),
  );
}

// PLAY
route('/play', async () => {
  if (!state.user) { navigate('#/login'); return null; }
  return renderPlayPicker();
});

function renderPlayPicker() {
  const view = h('div', { class: 'play-layout' });
  view.appendChild(h('h1', {}, 'New game'));
  view.appendChild(h('p', {}, 'Pick a time control to find an opponent.'));

  const TC = [
    { initial: 60,   inc: 0, label: '1+0',  cat: 'Bullet' },
    { initial: 120,  inc: 1, label: '2+1',  cat: 'Bullet' },
    { initial: 180,  inc: 0, label: '3+0',  cat: 'Blitz' },
    { initial: 180,  inc: 2, label: '3+2',  cat: 'Blitz' },
    { initial: 300,  inc: 0, label: '5+0',  cat: 'Blitz' },
    { initial: 300,  inc: 3, label: '5+3',  cat: 'Blitz' },
    { initial: 600,  inc: 0, label: '10+0', cat: 'Rapid' },
    { initial: 900,  inc: 10, label: '15+10', cat: 'Rapid' },
    { initial: 1800, inc: 0, label: '30+0', cat: 'Classical' },
    { initial: 1800, inc: 20, label: '30+20', cat: 'Classical' },
  ];
  let selected = TC[3];
  const grid = h('div', { class: 'time-control-grid' });
  TC.forEach(tc => {
    const card = h('div', { class: 'tc-card' + (tc === selected ? ' selected' : ''), onclick: () => {
      selected = tc;
      $$('.tc-card', grid).forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    }},
      h('div', { class: 'tc-time' }, tc.label),
      h('div', { class: 'tc-cat' }, tc.cat),
    );
    grid.appendChild(card);
  });
  view.appendChild(grid);

  const ratedToggle = h('label', { class: 'form-field', style: 'display:flex;gap:8px;align-items:center;justify-content:center;margin:0;' },
    h('input', { type: 'checkbox', name: 'rated', checked: '' }),
    h('span', {}, 'Rated'),
  );

  view.appendChild(h('div', { class: 'play-controls' },
    ratedToggle,
    h('button', { class: 'btn btn-primary', onclick: async () => {
      const rated = $('input[name=rated]', ratedToggle).checked;
      await startSeek(selected.initial, selected.inc, rated);
    }}, 'Find opponent'),
    h('a', { href: '#/play/ai', 'data-link': '', class: 'btn btn-ghost' }, 'Play vs Computer'),
    h('a', { href: '#/play/custom', 'data-link': '', class: 'btn btn-ghost' }, 'Custom modes'),
    h('a', { href: '#/play/friend', 'data-link': '', class: 'btn btn-ghost' }, 'Challenge friend'),
  ));

  view.appendChild(h('div', { id: 'queue-status' }));
  return view;
}

async function startSeek(initialTime, increment, rated) {
  await ensureWs();
  sendWs({ type: 'seekGame', initialTime, increment, rated });
  sound.startSearch();
  const status = $('#queue-status');
  if (status) {
    status.innerHTML = '';
    status.appendChild(h('div', { class: 'queue-status' },
      h('span', { class: 'pulse' }),
      h('span', {}, `Searching for opponent  (${initialTime/60}+${increment}${rated ? ', rated' : ', casual'})...`),
      h('div', { style: 'margin-top:14px' },
        h('button', { class: 'btn btn-ghost btn-sm', onclick: cancelSeek }, 'Cancel')),
    ));
  }
}

function cancelSeek() {
  sendWs({ type: 'cancelSeek' });
  sound.stopSearch();
}

function onQueued() { /* already shown */ }
function onQueueCancelled() {
  sound.stopSearch();
  const status = $('#queue-status');
  if (status) status.innerHTML = '';
  toast('Search cancelled');
}

// PLAY vs AI
route('/play/ai', async () => {
  const view = h('div', { class: 'play-layout' });
  view.appendChild(h('h1', {}, 'Play vs Computer'));
  view.appendChild(h('p', {},
    'Practice against Stockfish. Pick a target Elo or a classic skill level. ',
    'Ratings are not affected. Engine runs in a background thread, UI stays smooth.'));

  // Elo presets — map to Stockfish Skill Level and search depth
  const PRESETS = [
    { label: 'Beginner',     elo: 800,  skill: 0,  depth: 3  },
    { label: 'Casual',       elo: 1200, skill: 3,  depth: 4  },
    { label: 'Club player',  elo: 1500, skill: 6,  depth: 6  },
    { label: 'Intermediate', elo: 1800, skill: 10, depth: 8  },
    { label: 'Advanced',     elo: 2100, skill: 14, depth: 10 },
    { label: 'Expert',       elo: 2400, skill: 17, depth: 12 },
    { label: 'Master',       elo: 2700, skill: 20, depth: 16 },
  ];
  let selected = PRESETS[2];
  let color = 'white';

  const grid = h('div', { class: 'time-control-grid' });
  PRESETS.forEach(p => {
    const c = h('div', { class: 'tc-card' + (p === selected ? ' selected' : ''), onclick: () => {
      selected = p;
      $$('.tc-card', grid).forEach(x => x.classList.remove('selected'));
      c.classList.add('selected');
    }},
      h('div', { class: 'tc-time' }, `${p.elo}`),
      h('div', { class: 'tc-cat' }, p.label),
    );
    grid.appendChild(c);
  });
  view.appendChild(grid);

  const colorRow = h('div', { class: 'play-controls' });
  ['white', 'random', 'black'].forEach(cName => {
    const btn = h('button', { class: 'btn btn-ghost' + (cName === color ? ' btn-primary' : ''),
      onclick: () => { color = cName; $$('button', colorRow).forEach((b,i) => b.classList.toggle('btn-primary', ['white','random','black'][i] === cName)); }
    }, cName[0].toUpperCase() + cName.slice(1));
    colorRow.appendChild(btn);
  });
  view.appendChild(colorRow);

  view.appendChild(h('div', { class: 'play-controls' },
    h('button', { class: 'btn btn-primary', onclick: () => {
      const finalColor = color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : color;
      startAiGame(selected, finalColor);
    }}, 'Start game'),
  ));

  view.appendChild(h('p', { style: 'color:var(--text-dim);font-size:0.85rem;text-align:center;margin-top:20px' },
    'Powered by Stockfish 10+ WASM. First move may take a moment while the engine loads.'));

  return view;
});

async function startAiGame(preset, playerColor) {
  // Check if Chess.js loaded
  if (!window.Chess) {
    toast('Chess library not loaded - refresh the page', 'error');
    console.error('window.Chess is undefined');
    return;
  }

  // Initialize Stockfish engine (persistent across games if possible)
  if (!state.stockfish) {
    state.stockfish = new StockfishEngine();
    toast('Loading Stockfish engine...', 'info');
  }
  try {
    await state.stockfish.init();
    if (state.stockfish.useFallback) {
      toast('Using fallback AI (Stockfish unavailable)', 'info');
    }
  } catch (e) {
    console.error('Stockfish init error:', e);
    toast('Engine failed to load, using fallback AI', 'error');
  }
  state.stockfish.newGame();
  state.stockfish.setSkillLevel(preset.skill);
  state.stockfish.setElo(preset.elo);

  const aiGame = {
    preset,
    playerColor,
    chess: new window.Chess(),
    history: [],
    thinking: false,
  };
  renderAiGameView(aiGame);
}

function renderAiGameView(aiGame) {
  const view = $('#view');
  view.innerHTML = '';
  const container = h('div', { class: 'game-page' });
  const boardCol = h('div', { class: 'game-board-col' });

  const oppStrip = h('div', { class: 'player-strip' },
    h('div', { class: 'player-info' },
      h('span', { class: 'name' }, `Stockfish (${aiGame.preset.label})`),
      h('span', { class: 'rating' }, `${aiGame.preset.elo}`),
    ),
    h('div', { class: 'clock', id: 'ai-thinking' }, 'ready'),
  );
  const meStrip = h('div', { class: 'player-strip' },
    h('div', { class: 'player-info' },
      h('span', { class: 'name' }, state.user ? state.user.username : 'You'),
      state.user ? h('span', { class: 'rating' }, `${state.user.rating_blitz}`) : null,
    ),
    h('div', { class: 'clock' }, '--'),
  );
  boardCol.appendChild(oppStrip);
  const boardEl = h('div');
  boardCol.appendChild(boardEl);
  boardCol.appendChild(meStrip);

  const sideCol = h('div', { class: 'game-side-col' });
  const moveList = h('div', { class: 'move-list' }, h('div', { class: 'moves' }));
  const actions = h('div', { class: 'game-actions' },
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
      if (confirm('Resign?')) endAiGame(aiGame, aiGame.playerColor === 'white' ? '0-1' : '1-0', 'resignation');
    }}, 'Resign'),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
      if (aiGame.thinking) return toast('Wait for Stockfish to finish', 'error');
      if (aiGame.chess.isGameOver()) return;
      if (aiGame.history.length < 2) return;
      const target = aiGame.history.slice(0, -2);
      aiGame.chess = new window.Chess();
      aiGame.history = [];
      for (const m of target) { aiGame.chess.move(m); aiGame.history.push(m); }
      state.board.setPosition(aiGame.chess.fen());
      renderMoveList(moveList, aiGame.chess.fen(), aiGame.history);
    }}, 'Undo'),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => navigate('#/play/ai') }, 'New'),
  );
  sideCol.appendChild(moveList);
  sideCol.appendChild(actions);

  container.appendChild(boardCol);
  container.appendChild(sideCol);
  view.appendChild(container);

  const board = new Board(boardEl, {
    orientation: aiGame.playerColor,
    onMove: (move) => {
      if (aiGame.thinking) return false;
      const res = aiGame.chess.move(move);
      if (!res) return false;
      aiGame.history.push(res.san);
      // Play move sound
      if (state.settings.moveSound) {
        if (res.captured) sound.capture();
        else sound.move();
        if (aiGame.chess.inCheck()) setTimeout(() => sound.check(), 120);
      }
      board.setLastMove(res.from, res.to);
      board.setPosition(aiGame.chess.fen());
      renderMoveList(moveList, aiGame.chess.fen(), aiGame.history);
      checkAiGameEnd(aiGame);
      if (!aiGame.chess.isGameOver()) {
        // Async AI move — UI stays fluid
        requestAiMove(aiGame, board, moveList);
      }
      return true;
    },
  });
  state.board = board;
  board.setPlayerColor(aiGame.playerColor);
  board.setPosition(aiGame.chess.fen());

  // If player is black, Stockfish opens
  if (aiGame.playerColor === 'black') {
    requestAiMove(aiGame, board, moveList);
  }
}

async function requestAiMove(aiGame, board, moveList) {
  if (aiGame.chess.isGameOver()) return;
  aiGame.thinking = true;
  const ind = $('#ai-thinking');
  if (ind) { ind.textContent = 'thinking...'; ind.classList.add('active'); }

  try {
    const engine = state.stockfish;
    const moveUci = await engine.getBestMove(aiGame.chess.fen(), {
      depth: aiGame.preset.depth,
      movetime: Math.min(3000, aiGame.preset.depth * 200),
    });

    if (!moveUci) {
      aiGame.thinking = false;
      if (ind) { ind.textContent = 'ready'; ind.classList.remove('active'); }
      return;
    }

    // Convert UCI (e.g. e2e4 or e7e8q) to move object
    const from = moveUci.slice(0, 2);
    const to = moveUci.slice(2, 4);
    const promotion = moveUci.length >= 5 ? moveUci[4] : undefined;
    const res = aiGame.chess.move({ from, to, promotion });
    if (!res) {
      aiGame.thinking = false;
      if (ind) { ind.textContent = 'ready'; ind.classList.remove('active'); }
      return;
    }
    aiGame.history.push(res.san);
    if (state.settings.moveSound) {
      if (res.captured) sound.capture();
      else sound.move();
      if (aiGame.chess.inCheck()) setTimeout(() => sound.check(), 120);
    }
    board.setPosition(aiGame.chess.fen());
    board.setLastMove(res.from, res.to);
    renderMoveList(moveList, aiGame.chess.fen(), aiGame.history);
    checkAiGameEnd(aiGame);
  } catch (e) {
    console.error(e);
    toast('Engine error', 'error');
  } finally {
    aiGame.thinking = false;
    if (ind) { ind.textContent = 'ready'; ind.classList.remove('active'); }
  }
}

function checkAiGameEnd(aiGame) {
  if (!aiGame.chess.isGameOver()) return;
  let result = '1/2-1/2', termination = 'draw';
  if (aiGame.chess.isCheckmate()) {
    const loser = aiGame.chess.turn();
    result = loser === 'w' ? '0-1' : '1-0';
    termination = 'checkmate';
  } else if (aiGame.chess.isStalemate()) termination = 'stalemate';
  else termination = 'draw';
  endAiGame(aiGame, result, termination);
}

function endAiGame(aiGame, result, termination) {
  const msg = result === '1-0' ? 'White wins' : result === '0-1' ? 'Black wins' : 'Draw';
  // Play victory/loss sound
  const youWon =
    (aiGame.playerColor === 'white' && result === '1-0') ||
    (aiGame.playerColor === 'black' && result === '0-1');
  if (state.settings.sound) {
    if (youWon) sound.victory();
    else sound.gameEnd();
  }
  showGameEndModal(`${msg} — ${termination}`, () => navigate('#/play/ai'));
}

function renderMoveList(el, fen, history) {
  const moves = el.querySelector('.moves');
  moves.innerHTML = '';
  for (let i = 0; i < history.length; i += 2) {
    moves.appendChild(h('span', { class: 'num' }, `${i/2 + 1}.`));
    moves.appendChild(h('span', { class: 'move' + (i === history.length - 1 ? ' current' : '') }, history[i] || ''));
    moves.appendChild(h('span', { class: 'move' + (i + 1 === history.length - 1 ? ' current' : '') }, history[i+1] || ''));
  }
  el.scrollTop = el.scrollHeight;
}

// CUSTOM MODES
route('/play/custom', async () => {
  const view = h('div', { class: 'play-layout' });
  view.appendChild(h('h1', {}, 'Custom Mischess modes'));
  view.appendChild(h('p', {}, 'Alternate rulesets and unusual setups, playable against the computer.'));

  const MODES = [
    {
      id: 'chaos960',
      title: 'Chaos 960',
      desc: 'Randomized starting position (Fischer Random style). No two games alike.',
      start: () => {
        const fen = chaos960Fen();
        startCustomAiGame(fen, 'Chaos 960');
      }
    },
    {
      id: 'horde',
      title: 'Horde',
      desc: 'White plays an army of pawns. Black wins by capturing every pawn; White wins by checkmate.',
      start: () => startCustomAiGame('rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1', 'Horde'),
    },
    {
      id: 'berserk',
      title: 'Berserk Blitz',
      desc: 'Start at 1+0 with a 5-second timeout on every move. Think fast.',
      start: () => startCustomAiGame(null, 'Berserk', { perMoveCap: 5000, initialTime: 60 }),
    },
    {
      id: 'king-hill',
      title: 'King of the Hill',
      desc: 'Get your king safely to e4, e5, d4, or d5 to win. Checkmate also wins.',
      start: () => startCustomAiGame(null, 'King of the Hill', { kingHill: true }),
    },
    {
      id: 'three-check',
      title: 'Three-check',
      desc: 'Deliver three checks to win. Checkmate still ends it immediately.',
      start: () => startCustomAiGame(null, 'Three-check', { threeCheck: true }),
    },
    {
      id: 'atomic-lite',
      title: 'Atomic Lite',
      desc: 'Captures explode: the capturing piece and all adjacent non-pawns die with the captured piece.',
      start: () => startCustomAiGame(null, 'Atomic Lite', { atomic: true }),
    },
  ];

  const grid = h('div', { class: 'features' });
  MODES.forEach(m => {
    grid.appendChild(h('div', { class: 'feature-card' },
      h('h3', {}, m.title),
      h('p', {}, m.desc),
      h('div', { style: 'margin-top:14px' },
        h('button', { class: 'btn btn-primary btn-sm', onclick: m.start }, 'Play')),
    ));
  });
  view.appendChild(grid);
  return view;
});

function chaos960Fen() {
  // Valid chess960 backrank: bishops opposite color, king between rooks
  while (true) {
    const positions = [0,1,2,3,4,5,6,7];
    const shuffled = positions.sort(() => Math.random() - 0.5).slice(0);
    // Pick positions for pieces
    // b on different colors, king between rooks
    const arr = shuffled.slice();
    // Deterministic: just use a standard randomizer
    const order = ['r','n','b','q','k','b','n','r']; // can randomize but keep symmetric
    // Shuffle once
    const backrank = [...order];
    for (let i = backrank.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [backrank[i], backrank[j]] = [backrank[j], backrank[i]];
    }
    // Validate bishops different color
    const bishops = backrank.map((p,i) => p === 'b' ? i : -1).filter(i => i >= 0);
    if (bishops.length !== 2 || (bishops[0] % 2) === (bishops[1] % 2)) continue;
    // King between rooks
    const king = backrank.indexOf('k');
    const rooks = backrank.map((p,i) => p === 'r' ? i : -1).filter(i => i >= 0);
    if (king < rooks[0] || king > rooks[1]) continue;
    const whiteBack = backrank.map(c => c.toUpperCase()).join('');
    const blackBack = backrank.join('');
    return `${blackBack}/pppppppp/8/8/8/8/PPPPPPPP/${whiteBack} w KQkq - 0 1`;
  }
}

function startCustomAiGame(fen, name, rules = {}) {
  const view = $('#view');
  view.innerHTML = '';
  const aiGame = {
    level: 3,
    playerColor: 'white',
    chess: new window.Chess(fen || undefined),
    history: [],
    modeName: name,
    rules: rules,
    checksGiven: { w: 0, b: 0 },
    moveTimer: null,
  };
  const container = h('div', { class: 'game-page' });
  const boardCol = h('div', { class: 'game-board-col' });

  const oppStrip = h('div', { class: 'player-strip' },
    h('div', { class: 'player-info' },
      h('span', { class: 'name' }, `${name} - Computer`),
    ),
    h('div', { class: 'clock', id: 'opp-clock' }, '--:--'),
  );
  const meStrip = h('div', { class: 'player-strip' },
    h('div', { class: 'player-info' },
      h('span', { class: 'name' }, state.user ? state.user.username : 'You'),
    ),
    h('div', { class: 'clock', id: 'me-clock' }, '--:--'),
  );
  boardCol.appendChild(oppStrip);
  const boardEl = h('div');
  boardCol.appendChild(boardEl);
  boardCol.appendChild(meStrip);

  const moveList = h('div', { class: 'move-list' }, h('div', { class: 'moves' }));
  const info = h('div', { class: 'feature-card' },
    h('h3', {}, name),
    h('p', { id: 'custom-info' }, 'Your move.'),
  );
  const actions = h('div', { class: 'game-actions' },
    h('button', { class: 'btn btn-danger btn-sm', onclick: () => navigate('#/play/custom') }, 'End'),
  );
  const sideCol = h('div', { class: 'game-side-col' });
  sideCol.appendChild(info);
  sideCol.appendChild(moveList);
  sideCol.appendChild(actions);

  container.appendChild(boardCol);
  container.appendChild(sideCol);
  view.appendChild(container);

  const board = new Board(boardEl, {
    orientation: 'white',
    onMove: (move) => handleCustomMove(aiGame, board, moveList, move),
  });
  state.board = board;
  board.setPlayerColor('white');
  board.setPosition(aiGame.chess.fen());
}

function handleCustomMove(aiGame, board, moveList, move) {
  const res = aiGame.chess.move(move);
  if (!res) return false;
  aiGame.history.push(res.san);
  board.setPosition(aiGame.chess.fen());
  board.setLastMove(res.from, res.to);
  renderMoveList(moveList, aiGame.chess.fen(), aiGame.history);

  // Apply custom rules
  if (aiGame.rules.threeCheck && res.san.includes('+')) {
    aiGame.checksGiven[res.color]++;
    const i = $('#custom-info');
    if (i) i.textContent = `Checks: White ${aiGame.checksGiven.w} / Black ${aiGame.checksGiven.b}`;
    if (aiGame.checksGiven[res.color] >= 3) {
      showGameEndModal(`${res.color === 'w' ? 'White' : 'Black'} wins by three checks`, () => navigate('#/play/custom'));
      return;
    }
  }
  if (aiGame.rules.kingHill) {
    const hills = ['e4','e5','d4','d5'];
    const board2 = aiGame.chess.board();
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = board2[r][f];
      if (!p || p.type !== 'k') continue;
      const sq = 'abcdefgh'[f] + (8 - r);
      if (hills.includes(sq)) {
        showGameEndModal(`${p.color === 'w' ? 'White' : 'Black'} reached the hill!`, () => navigate('#/play/custom'));
        return;
      }
    }
  }
  if (aiGame.chess.isGameOver()) {
    let msg = 'Draw';
    if (aiGame.chess.isCheckmate()) msg = aiGame.chess.turn() === 'w' ? 'Black wins by checkmate' : 'White wins by checkmate';
    else if (aiGame.chess.isStalemate()) msg = 'Stalemate - draw';
    showGameEndModal(msg, () => navigate('#/play/custom'));
    return;
  }
  // AI's turn
  setTimeout(() => {
    if (aiGame.chess.isGameOver()) return;
    const m = findBestMove(aiGame.chess.fen(), aiGame.level);
    if (!m) return;
    const r2 = aiGame.chess.move(m);
    aiGame.history.push(r2.san);
    board.setPosition(aiGame.chess.fen());
    board.setLastMove(r2.from, r2.to);
    renderMoveList(moveList, aiGame.chess.fen(), aiGame.history);
    if (aiGame.rules.threeCheck && r2.san.includes('+')) {
      aiGame.checksGiven[r2.color]++;
      const inf = $('#custom-info');
      if (inf) inf.textContent = `Checks: White ${aiGame.checksGiven.w} / Black ${aiGame.checksGiven.b}`;
      if (aiGame.checksGiven[r2.color] >= 3) showGameEndModal(`${r2.color === 'w' ? 'White' : 'Black'} wins by three checks`, () => navigate('#/play/custom'));
    }
    if (aiGame.chess.isGameOver()) {
      let msg = 'Draw';
      if (aiGame.chess.isCheckmate()) msg = aiGame.chess.turn() === 'w' ? 'Black wins' : 'White wins';
      showGameEndModal(msg, () => navigate('#/play/custom'));
    }
  }, 400);
}

// FRIEND CHALLENGE
route('/play/friend', async () => {
  if (!state.user) { navigate('#/login'); return null; }
  const view = h('div', { class: 'play-layout' });
  view.appendChild(h('h1', {}, 'Challenge a friend'));
  view.appendChild(h('p', {}, 'Share a direct invite link. When your friend opens it, both of you join the same game.'));

  let selected = { initial: 300, inc: 3, label: '5+3' };
  const TC = [
    { initial: 60, inc: 0, label: '1+0' },
    { initial: 180, inc: 2, label: '3+2' },
    { initial: 300, inc: 3, label: '5+3' },
    { initial: 600, inc: 0, label: '10+0' },
    { initial: 1800, inc: 20, label: '30+20' },
  ];
  const grid = h('div', { class: 'time-control-grid' });
  TC.forEach(tc => {
    const c = h('div', { class: 'tc-card' + (tc === selected ? ' selected' : ''), onclick: () => {
      selected = tc;
      $$('.tc-card', grid).forEach(x => x.classList.remove('selected'));
      c.classList.add('selected');
    }}, h('div', { class: 'tc-time' }, tc.label));
    grid.appendChild(c);
  });
  view.appendChild(grid);

  const linkBox = h('div', { class: 'queue-status', style: 'margin-top:24px' },
    h('p', {}, 'Your invite link will appear here. Keep this page open while you wait.'));
  view.appendChild(linkBox);

  view.appendChild(h('div', { class: 'play-controls' },
    h('button', { class: 'btn btn-primary', onclick: async () => {
      // Use WebSocket seek with a private key (simulate via unusual time control combo)
      // Simpler: use seek with a custom flag
      await ensureWs();
      // Reuse regular queue but restrict to friend via a token in URL
      // For simplicity, encode: use normal matchmaking with casual flag
      toast('Friend challenges coming soon — using standard matchmaking for this build');
      sendWs({ type: 'seekGame', initialTime: selected.initial, increment: selected.inc, rated: false });
      linkBox.innerHTML = '';
      linkBox.appendChild(h('div', {},
        h('span', { class: 'pulse' }),
        h('span', {}, 'Waiting for any opponent at ' + selected.label + ' (casual)...')));
    }}, 'Create game'),
  ));
  return view;
});

// LEADERBOARD
route('/leaderboard', async () => {
  const view = h('div', { class: 'leaderboard' });
  view.appendChild(h('h1', {}, 'Leaderboard'));

  const cats = ['bullet', 'blitz', 'rapid', 'classical'];
  let current = 'blitz';

  const tabs = h('div', { class: 'lb-tabs' });
  for (const c of cats) {
    const tab = h('button', { class: 'lb-tab' + (c === current ? ' active' : ''), onclick: async () => {
      current = c;
      $$('.lb-tab', tabs).forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      await loadLB();
    }}, c.charAt(0).toUpperCase() + c.slice(1));
    tabs.appendChild(tab);
  }
  view.appendChild(tabs);

  const body = h('div');
  view.appendChild(body);

  async function loadLB() {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'loading' }, h('div', { class: 'spinner' })));
    try {
      const { players } = await api(`/api/users/leaderboard?category=${current}`);
      body.innerHTML = '';
      if (!players.length) {
        body.appendChild(h('p', { style: 'text-align:center;color:var(--text-dim);padding:40px;' }, 'No rated players yet. Be the first.'));
        return;
      }
      const table = h('table', { class: 'lb-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Rank'),
          h('th', {}, 'Player'),
          h('th', {}, 'Rating'),
          h('th', {}, 'Games'),
          h('th', {}, 'W / L / D'),
        )),
        h('tbody', {},
          ...players.map((p, i) => h('tr', {},
            h('td', { class: 'rank' + (i < 3 ? ' top' : '') }, `#${i + 1}`),
            h('td', {}, h('a', { href: `#/profile/${p.username}`, 'data-link': '' }, p.username)),
            h('td', { class: 'rating' }, String(p.rating)),
            h('td', {}, String(p.games_played)),
            h('td', {}, `${p.wins} / ${p.losses} / ${p.draws}`),
          )),
        ),
      );
      body.appendChild(table);
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(h('p', { class: 'error-message' }, e.message));
    }
  }
  await loadLB();
  return view;
});

// WATCH
route('/watch', async () => {
  const view = h('div');
  view.appendChild(h('h1', {}, 'Watch live games'));

  const live = h('div', { class: 'games-list' });
  const recent = h('div', { class: 'games-list', style: 'margin-top:24px' });
  view.appendChild(h('h3', {}, 'Live now'));
  view.appendChild(live);
  view.appendChild(h('h3', { style: 'margin-top:32px' }, 'Recent finished'));
  view.appendChild(recent);

  try {
    const [liveData, recentData] = await Promise.all([
      api('/api/games/live'),
      api('/api/games/recent'),
    ]);
    if (!liveData.games.length) live.appendChild(h('p', { style: 'color:var(--text-dim)' }, 'No games currently being played. Be the first.'));
    for (const g of liveData.games) {
      live.appendChild(h('a', { class: 'game-list-item', href: `#/game/${g.id}`, 'data-link': '' },
        h('div', { class: 'gl-players' },
          h('div', {}, `${g.white} (${g.whiteRating})`),
          h('div', { class: 'vs' }, 'vs'),
          h('div', {}, `${g.black} (${g.blackRating})`),
        ),
        h('div', { class: 'gl-tc' }, g.timeControl),
        h('div', { class: 'gl-result' }, `${g.moves} moves`),
      ));
    }
    if (!recentData.games.length) recent.appendChild(h('p', { style: 'color:var(--text-dim)' }, 'No finished games yet.'));
    for (const g of recentData.games) {
      recent.appendChild(h('a', { class: 'game-list-item', href: `#/game/${g.id}`, 'data-link': '' },
        h('div', { class: 'gl-players' },
          h('div', {}, g.white_name),
          h('div', { class: 'vs' }, 'vs'),
          h('div', {}, g.black_name),
        ),
        h('div', { class: 'gl-tc' }, g.time_control),
        h('div', { class: 'gl-result' }, g.result || '—'),
      ));
    }
  } catch (e) {
    view.appendChild(h('p', { class: 'error-message' }, e.message));
  }
  return view;
});

// PROFILE
route('/profile/:username', async (params) => {
  const view = h('div');
  view.appendChild(h('div', { class: 'loading' }, h('div', { class: 'spinner' })));
  try {
    const { user, recentGames } = await api('/api/users/' + encodeURIComponent(params.username));
    view.innerHTML = '';
    const createdAt = new Date(user.created_at);
    const initial = user.username[0].toUpperCase();

    const headerChildren = [
      h('div', { class: 'profile-avatar' }, initial),
      h('div', { class: 'profile-info' },
        h('h1', {}, user.username,
          user.title ? h('span', {
            style: 'margin-left:10px;font-size:0.7em;padding:3px 10px;background:var(--accent-muted);color:var(--accent);border-radius:999px;vertical-align:middle',
          }, user.title) : null,
          user.country ? h('span', {
            style: 'margin-left:8px;font-size:0.6em;color:var(--text-dim);vertical-align:middle',
          }, user.country) : null,
        ),
        h('div', { class: 'joined' }, `Member since ${createdAt.toLocaleDateString()}`),
        user.bio ? h('div', { class: 'bio' }, user.bio) : null,
      ),
    ];
    view.appendChild(h('div', { class: 'profile-header' }, ...headerChildren));
    view.appendChild(h('div', { class: 'rating-grid' },
      ratingCard('Bullet', user.rating_bullet),
      ratingCard('Blitz', user.rating_blitz),
      ratingCard('Rapid', user.rating_rapid),
      ratingCard('Classical', user.rating_classical),
    ));
    view.appendChild(h('div', { class: 'stats-strip', style: 'margin-bottom:32px' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-number' }, String(user.games_played)), h('div', { class: 'stat-label' }, 'Games')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-number' }, String(user.wins)), h('div', { class: 'stat-label' }, 'Wins')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-number' }, String(user.draws)), h('div', { class: 'stat-label' }, 'Draws')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-number' }, String(user.losses)), h('div', { class: 'stat-label' }, 'Losses')),
    ));
    view.appendChild(h('h3', {}, 'Recent games'));
    const list = h('div', { class: 'games-list' });
    if (!recentGames.length) list.appendChild(h('p', { style: 'color:var(--text-dim)' }, 'No games played yet.'));
    for (const g of recentGames) {
      list.appendChild(h('a', { class: 'game-list-item', href: `#/game/${g.id}`, 'data-link': '' },
        h('div', { class: 'gl-players' },
          h('div', {}, g.white_name),
          h('div', { class: 'vs' }, 'vs'),
          h('div', {}, g.black_name),
        ),
        h('div', { class: 'gl-tc' }, `${g.category} ${g.time_control}`),
        h('div', { class: 'gl-result' }, g.result || g.termination),
      ));
    }
    view.appendChild(list);

    // Friend actions
    if (state.user && state.user.username.toLowerCase() !== user.username.toLowerCase()) {
      view.insertBefore(
        h('div', { class: 'play-controls', style: 'justify-content:flex-start;margin-bottom:24px' },
          h('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
            try {
              await api('/api/friends', { method: 'POST', body: { username: user.username }});
              toast('Friend added', 'success');
            } catch (e) { toast(e.message, 'error'); }
          }}, 'Add friend'),
          h('a', { href: '#/play/friend', 'data-link': '', class: 'btn btn-ghost btn-sm' }, 'Challenge'),
        ),
        view.children[1],
      );
    }
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(h('p', { class: 'error-message' }, e.message));
  }
  return view;
});

function ratingCard(cat, val) {
  return h('div', { class: 'rating-card' },
    h('div', { class: 'cat' }, cat),
    h('div', { class: 'val' }, String(val)),
  );
}

// FRIENDS LIST
route('/friends', async () => {
  if (!state.user) { navigate('#/login'); return null; }
  const view = h('div');
  view.appendChild(h('h1', {}, 'Friends'));
  const list = h('div', { class: 'games-list' });
  view.appendChild(list);
  try {
    const { friends } = await api('/api/friends');
    if (!friends.length) list.appendChild(h('p', { style: 'color:var(--text-dim)' }, 'No friends yet. Visit a profile to add one.'));
    for (const f of friends) {
      list.appendChild(h('div', { class: 'game-list-item' },
        h('div', {}, h('a', { href: `#/profile/${f.username}`, 'data-link': '' }, f.username)),
        h('div', { class: 'gl-tc' }, `${f.rating_blitz}`),
        h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
          await api('/api/friends/' + f.username, { method: 'DELETE' });
          renderRoute();
        }}, 'Remove'),
      ));
    }
  } catch (e) {
    list.appendChild(h('p', { class: 'error-message' }, e.message));
  }
  return view;
});

// GAME
route('/game/:id', async (params) => {
  if (!state.user) { navigate('#/login'); return null; }
  await ensureWs();
  // Check if we're already in this game (live) — server sends gameStart on reconnect
  if (state.game && state.game.id === params.id) {
    return renderGamePage(state.game);
  }
  // Otherwise, fetch and spectate (or replay if ended)
  try {
    const data = await api('/api/games/' + params.id);
    if (data.live) {
      // Join as spectator
      sendWs({ type: 'spectate', gameId: params.id });
      state.game = data.game;
      state.playerColor = null;
      return renderGamePage(data.game);
    } else {
      return renderFinishedGame(data.game);
    }
  } catch (e) {
    return h('div', { class: 'error-message' }, e.message);
  }
});

function renderFinishedGame(game) {
  const view = h('div', { class: 'game-page' });
  const boardCol = h('div', { class: 'game-board-col' });
  boardCol.appendChild(h('div', { class: 'player-strip' },
    h('div', { class: 'player-info' },
      h('span', { class: 'name' }, game.black_name),
      h('span', { class: 'rating' }, String(game.black_rating_after || game.black_rating_before || '')),
    ),
  ));
  const boardEl = h('div');
  boardCol.appendChild(boardEl);
  boardCol.appendChild(h('div', { class: 'player-strip' },
    h('div', { class: 'player-info' },
      h('span', { class: 'name' }, game.white_name),
      h('span', { class: 'rating' }, String(game.white_rating_after || game.white_rating_before || '')),
    ),
  ));

  const sideCol = h('div', { class: 'game-side-col' });
  sideCol.appendChild(h('div', { class: 'feature-card' },
    h('h3', {}, `${game.result || '?'} — ${game.termination}`),
    h('p', {}, `${game.category} - ${game.time_control}`),
    game.white_rating_after && game.white_rating_before ? h('p', {},
      `${game.white_name}: ${game.white_rating_before} → ${game.white_rating_after}`) : null,
    game.black_rating_after && game.black_rating_before ? h('p', {},
      `${game.black_name}: ${game.black_rating_before} → ${game.black_rating_after}`) : null,
  ));
  const movesEl = h('div', { class: 'move-list' }, h('div', { class: 'moves' }));
  sideCol.appendChild(movesEl);

  view.appendChild(boardCol);
  view.appendChild(sideCol);

  const board = new Board(boardEl, { interactive: false });
  const chess = new window.Chess();
  let history = [];
  try {
    if (game.moves) history = JSON.parse(game.moves);
  } catch {}
  for (const m of history) chess.move(m);
  board.setPosition(chess.fen());
  renderMoveList(movesEl, chess.fen(), history);
  return view;
}

function renderGamePage(game) {
  state.game = game;
  const view = h('div', { class: 'game-page' });
  const boardCol = h('div', { class: 'game-board-col' });

  // Orientation based on player color
  const orientation = state.playerColor === 'black' ? 'black' : 'white';
  const topPlayer = orientation === 'white' ? 'black' : 'white';
  const botPlayer = orientation === 'white' ? 'white' : 'black';

  const topStrip = h('div', { class: 'player-strip' },
    h('div', { class: 'player-info' },
      h('span', { class: 'name' }, game[topPlayer]),
      h('span', { class: 'rating' }, String(game[topPlayer + 'Rating'])),
    ),
    h('div', { class: 'clock', id: 'clock-top' }, fmtTime(game[topPlayer + 'Time'])),
  );
  boardCol.appendChild(topStrip);
  const boardEl = h('div');
  boardCol.appendChild(boardEl);
  const botStrip = h('div', { class: 'player-strip' },
    h('div', { class: 'player-info' },
      h('span', { class: 'name' }, game[botPlayer]),
      h('span', { class: 'rating' }, String(game[botPlayer + 'Rating'])),
    ),
    h('div', { class: 'clock', id: 'clock-bot' }, fmtTime(game[botPlayer + 'Time'])),
  );
  boardCol.appendChild(botStrip);

  const sideCol = h('div', { class: 'game-side-col' });
  const info = h('div', { class: 'feature-card' },
    h('p', {}, `${game.category} - ${game.timeControl}${game.rated ? ' - rated' : ' - casual'}`),
  );
  sideCol.appendChild(info);

  const movesEl = h('div', { class: 'move-list' }, h('div', { class: 'moves' }));
  sideCol.appendChild(movesEl);

  const isPlayer = state.playerColor !== null;
  const actions = h('div', { class: 'game-actions' });
  if (isPlayer) {
    actions.appendChild(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
      if (confirm('Resign this game?')) sendWs({ type: 'resign' });
    }}, 'Resign'));
    actions.appendChild(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
      sendWs({ type: 'offerDraw' });
      toast('Draw offered');
    }}, 'Draw'));
    if (game.moves.length < 2) {
      actions.appendChild(h('button', { class: 'btn btn-danger btn-sm', onclick: () => {
        sendWs({ type: 'abort' });
      }}, 'Abort'));
    }
  }
  sideCol.appendChild(actions);

  // Chat
  const chatBox = h('div', { class: 'chat-box' });
  const chatMessages = h('div', { class: 'chat-messages', id: 'chat-messages' });
  const chatInput = h('input', { placeholder: 'Say something...', maxlength: '200' });
  const chatForm = h('form', { class: 'chat-input', onsubmit: (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    sendWs({ type: 'chat', text });
    chatInput.value = '';
  }});
  chatForm.appendChild(chatInput);
  chatForm.appendChild(h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Send'));
  chatBox.appendChild(chatMessages);
  chatBox.appendChild(chatForm);
  sideCol.appendChild(chatBox);

  view.appendChild(boardCol);
  view.appendChild(sideCol);

  // Build board
  const board = new Board(boardEl, {
    orientation,
    interactive: isPlayer,
    onMove: (move) => {
      if (!isPlayer) return false;
      sendWs({ type: 'move', move });
      // Optimistic update handled on move echo
    },
  });
  state.board = board;
  if (isPlayer) board.setPlayerColor(state.playerColor);
  board.setPosition(game.fen);
  renderMoveList(movesEl, game.fen, game.moves);

  // Focus telemetry
  if (state.focusBlurListener) {
    window.removeEventListener('blur', state.focusBlurListener.blur);
    window.removeEventListener('focus', state.focusBlurListener.focus);
  }
  const blurH = () => sendWs({ type: 'focusEvent', event: 'blur' });
  const focusH = () => sendWs({ type: 'focusEvent', event: 'focus' });
  window.addEventListener('blur', blurH);
  window.addEventListener('focus', focusH);
  state.focusBlurListener = { blur: blurH, focus: focusH };

  updateClockDisplays();
  return view;
}

function updateClockDisplays() {
  const game = state.game;
  if (!game) return;
  const orientation = state.playerColor === 'black' ? 'black' : 'white';
  const topPlayer = orientation === 'white' ? 'black' : 'white';
  const botPlayer = orientation === 'white' ? 'white' : 'black';
  const topEl = $('#clock-top');
  const botEl = $('#clock-bot');
  if (topEl) {
    topEl.textContent = fmtTime(game[topPlayer + 'Time']);
    topEl.classList.toggle('active', game.turn === topPlayer && !game.ended);
    topEl.classList.toggle('low', game[topPlayer + 'Time'] < 20000);
  }
  if (botEl) {
    botEl.textContent = fmtTime(game[botPlayer + 'Time']);
    botEl.classList.toggle('active', game.turn === botPlayer && !game.ended);
    botEl.classList.toggle('low', game[botPlayer + 'Time'] < 20000);
  }
}

function onGameStart(game, yourColor) {
  sound.stopSearch();
  sound.matchFound();
  state.game = game;
  state.playerColor = yourColor;
  state.lastFen = game.fen;
  // Activate anti-cheat telemetry for this game
  if (yourColor && !state.telemetry) {
    state.telemetry = new AntiCheatTelemetry((msg) => sendWs(msg));
  }
  if (state.telemetry && yourColor) {
    state.telemetry.activate(game.id);
  }
  navigate('#/game/' + game.id);
  setTimeout(() => renderRoute(), 50);
}

function onGameUpdate(game, lastMove) {
  const prevMoveCount = state.game ? state.game.moves.length : 0;
  state.game = game;
  if (state.board) {
    state.board.setPosition(game.fen);
    if (lastMove) state.board.setLastMove(lastMove.from, lastMove.to);
  }
  const movesEl = $('.move-list');
  if (movesEl) renderMoveList(movesEl, game.fen, game.moves);
  updateClockDisplays();

  // Play appropriate sound based on move type
  if (state.settings.moveSound && game.moves.length > prevMoveCount && lastMove) {
    // Detect check by probing the SAN notation in moves list
    const lastSan = game.moves[game.moves.length - 1] || '';
    if (lastSan.includes('#')) {
      sound.gameEnd();
    } else if (lastSan.includes('+')) {
      sound.check();
    } else if (lastMove.captured || lastSan.includes('x')) {
      sound.capture();
    } else {
      sound.move();
    }
  }
  state.lastFen = game.fen;
}

function onClockTick(whiteTime, blackTime) {
  if (!state.game) return;
  state.game.whiteTime = whiteTime;
  state.game.blackTime = blackTime;
  updateClockDisplays();
}

function onDrawOffered(from) {
  if (!state.playerColor) return;
  if (from === state.playerColor) return;
  showDrawOfferModal();
}

function showDrawOfferModal() {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h('div', { class: 'modal' },
    h('h3', {}, 'Draw offered'),
    h('p', {}, 'Your opponent offers a draw.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn btn-ghost', onclick: () => { sendWs({ type: 'declineDraw' }); backdrop.remove(); }}, 'Decline'),
      h('button', { class: 'btn btn-primary', onclick: () => { sendWs({ type: 'offerDraw' }); backdrop.remove(); }}, 'Accept'),
    ),
  );
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

function onGameEnd(game) {
  state.game = game;
  if (state.telemetry) state.telemetry.deactivate();
  if (state.board) {
    state.board.setInteractive(false);
    state.board.setPosition(game.fen);
  }
  updateClockDisplays();
  let msg;
  if (game.termination === 'checkmate') msg = (game.winner === 'white' ? 'White' : 'Black') + ' wins by checkmate';
  else if (game.termination === 'timeout') msg = (game.winner === 'white' ? 'White' : 'Black') + ' wins on time';
  else if (game.termination === 'resignation') msg = (game.winner === 'white' ? 'White' : 'Black') + ' wins by resignation';
  else if (game.termination === 'agreement') msg = 'Draw by agreement';
  else if (game.termination === 'aborted') msg = 'Game aborted';
  else msg = `Draw - ${game.termination}`;

  // Play victory/defeat/draw sound
  if (state.playerColor && state.settings.sound) {
    if (game.winner === state.playerColor) sound.victory();
    else sound.gameEnd();
  } else if (state.settings.sound) {
    sound.gameEnd();
  }

  // Show rating change if available
  if (game.whiteRatingAfter && state.user) {
    const mine = state.playerColor === 'white' ? 'white' : 'black';
    const before = game[mine + 'Rating'];
    const after = game[mine + 'RatingAfter'];
    if (after && before && state.user) {
      const delta = after - before;
      msg += ` (${delta > 0 ? '+' : ''}${delta})`;
      state.user['rating_' + game.category] = after;
      renderAuthArea();
    }
  }
  showGameEndModal(msg, () => navigate('#/play'));
}

function onChatMessage(msg) {
  const container = $('#chat-messages');
  if (!container) return;
  container.appendChild(h('div', { class: 'chat-msg' },
    h('span', { class: 'who' }, msg.username + ':'),
    h('span', { class: 'txt' }, msg.text),
  ));
  container.scrollTop = container.scrollHeight;
  // Only play notification for messages from others
  if (state.user && msg.username !== state.user.username) sound.notify();
}

function showGameEndModal(message, onClose) {
  const existing = $('.modal-backdrop');
  if (existing) existing.remove();
  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h('div', { class: 'modal' },
    h('h3', {}, 'Game over'),
    h('p', {}, message),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn btn-primary', onclick: () => { backdrop.remove(); if (onClose) onClose(); }}, 'Continue'),
    ),
  );
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

function cleanupGame() {
  state.game = null;
  state.playerColor = null;
  if (state.focusBlurListener) {
    window.removeEventListener('blur', state.focusBlurListener.blur);
    window.removeEventListener('focus', state.focusBlurListener.focus);
    state.focusBlurListener = null;
  }
}

// SETTINGS
route('/settings', async () => {
  const view = h('div', { style: 'max-width:720px;margin:0 auto' });
  view.appendChild(h('h1', {}, 'Settings'));

  // ===== Theme picker =====
  const themeSection = h('div', { class: 'feature-card', style: 'margin-bottom:20px' });
  themeSection.appendChild(h('h3', {}, 'Theme'));
  themeSection.appendChild(h('p', { style: 'margin-bottom:14px' }, 'Pick the vibe. Saved to your account if signed in.'));
  const themeGrid = h('div', { class: 'theme-grid' });
  const THEMES = [
    { id: 'cozy', name: 'Cozy' },
    { id: 'dark', name: 'Dark' },
    { id: 'forest', name: 'Forest' },
    { id: 'rose', name: 'Rose' },
    { id: 'ocean', name: 'Ocean' },
  ];
  const currentTheme = state.settings.theme || 'cozy';
  THEMES.forEach(t => {
    const opt = h('div', {
      class: 'theme-option' + (t.id === currentTheme ? ' active' : ''),
      'data-preview': t.id,
      onclick: async () => {
        applyTheme(t.id);
        saveSettings();
        $$('.theme-option', themeGrid).forEach(x => x.classList.toggle('active', x.getAttribute('data-preview') === t.id));
        sound.click();
        // Save to server if logged in
        if (state.user) {
          try {
            await api('/api/users/me', { method: 'PUT', body: { theme: t.id } });
          } catch {}
        }
      },
    },
      h('div', { class: 'theme-swatch' }),
      h('div', { class: 'theme-name' }, t.name),
    );
    themeGrid.appendChild(opt);
  });
  themeSection.appendChild(themeGrid);
  view.appendChild(themeSection);

  // ===== Audio =====
  const audioSection = h('div', { class: 'feature-card', style: 'margin-bottom:20px' });
  audioSection.appendChild(h('h3', {}, 'Audio'));

  const makeToggle = (label, description, key) => {
    const row = h('div', { class: 'toggle-row' });
    row.appendChild(h('div', {},
      h('label', {}, label),
      h('span', { class: 'desc' }, description),
    ));
    const switchEl = h('label', { class: 'switch' });
    const input = h('input', {
      type: 'checkbox',
      ...(state.settings[key] ? { checked: '' } : {}),
      onchange: (e) => {
        state.settings[key] = e.target.checked;
        saveSettings();
        if (key === 'sound' && e.target.checked) sound.click();
      },
    });
    switchEl.appendChild(input);
    switchEl.appendChild(h('span', { class: 'slider' }));
    row.appendChild(switchEl);
    return row;
  };

  audioSection.appendChild(makeToggle('All sounds', 'Master toggle for every sound effect', 'sound'));
  audioSection.appendChild(makeToggle('Move sounds', 'Piece movement, capture, check, checkmate', 'moveSound'));
  audioSection.appendChild(h('div', { style: 'margin-top:14px;display:flex;gap:8px;flex-wrap:wrap' },
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => sound.click() }, 'Test click'),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => sound.move() }, 'Test move'),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => sound.capture() }, 'Test capture'),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => sound.check() }, 'Test check'),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => sound.matchFound() }, 'Test match found'),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => sound.victory() }, 'Test victory'),
  ));
  view.appendChild(audioSection);

  // ===== Profile editor (if logged in) =====
  if (state.user) {
    const profileSection = h('div', { class: 'feature-card', style: 'margin-bottom:20px' });
    profileSection.appendChild(h('h3', {}, 'Profile'));
    profileSection.appendChild(h('p', { style: 'margin-bottom:14px' }, 'Customize how others see you.'));

    let bio = state.user.bio || '';
    let country = state.user.country || '';
    let title = state.user.title || '';

    profileSection.appendChild(h('div', { class: 'form-group' },
      h('label', {}, 'Bio'),
      h('textarea', {
        maxlength: '500',
        placeholder: 'A short bio...',
        rows: '3',
        oninput: (e) => bio = e.target.value,
      }, bio),
    ));
    profileSection.appendChild(h('div', { class: 'form-group' },
      h('label', {}, 'Country code (optional, 2 letters)'),
      h('input', {
        type: 'text',
        maxlength: '3',
        placeholder: 'US',
        value: country,
        oninput: (e) => country = e.target.value.toUpperCase(),
      }),
    ));
    profileSection.appendChild(h('div', { class: 'form-group' },
      h('label', {}, 'Custom title (optional)'),
      h('input', {
        type: 'text',
        maxlength: '30',
        placeholder: 'e.g. Coffee Lover',
        value: title,
        oninput: (e) => title = e.target.value,
      }),
    ));
    profileSection.appendChild(h('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        try {
          await api('/api/users/me', {
            method: 'PUT',
            body: { bio, country: country || null, title: title || null },
          });
          Object.assign(state.user, { bio, country, title });
          toast('Profile saved', 'success');
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    }, 'Save profile'));
    view.appendChild(profileSection);
  }

  // ===== Account =====
  const accountSection = h('div', { class: 'feature-card', style: 'margin-bottom:20px' });
  accountSection.appendChild(h('h3', {}, 'Account'));
  if (state.user) {
    accountSection.appendChild(h('p', {}, `Signed in as `, h('strong', {}, state.user.username)));
    accountSection.appendChild(h('button', { class: 'btn btn-danger btn-sm', onclick: logout }, 'Sign out'));
  } else {
    accountSection.appendChild(h('p', {}, 'Not signed in. ',
      h('a', { href: '#/login', 'data-link': '' }, 'Sign in'), ' or ',
      h('a', { href: '#/register', 'data-link': '' }, 'create an account'), '.'));
  }
  view.appendChild(accountSection);

  return view;
});

// ABOUT
route('/about', async () => {
  const view = h('div', { style: 'max-width:720px;margin:0 auto' });
  view.appendChild(h('h1', {}, 'About Mischess'));
  view.appendChild(h('p', {}, 'Mischess is a fast, free, fair chess platform built for people who take the game seriously. Real-time multiplayer over WebSockets. PostgreSQL for durable storage. Stockfish for both AI opponents and post-game cheat analysis. No ads, no tracking, no paywalls.'));
  view.appendChild(h('h3', {}, 'Time controls'));
  view.appendChild(h('p', {}, 'Bullet (<3 min est.), Blitz (3-8 min), Rapid (8-25 min), Classical (25+ min). Each category has its own Elo rating.'));
  view.appendChild(h('h3', {}, 'Custom modes'));
  view.appendChild(h('p', {}, 'Chaos 960, Horde, Berserk Blitz, King of the Hill, Three-check, and Atomic Lite for when you want something different from standard play.'));
  view.appendChild(h('h3', {}, 'Fair play'));
  view.appendChild(h('p', {}, 'Every rated game is analyzed by Stockfish to compute centipawn loss and accuracy. Flagged accounts are shadow-pooled: they still match and play, but only against other flagged accounts.'));
  return view;
});

// FAIRPLAY
route('/fairplay', async () => {
  const view = h('div', { style: 'max-width:720px;margin:0 auto' });
  view.appendChild(h('h1', {}, 'Fair Play'));
  view.appendChild(h('p', {}, 'Mischess runs a multi-layer anti-cheat system designed to catch engine assistance without punishing honest players.'));

  view.appendChild(h('h3', {}, 'Accuracy Pulse'));
  view.appendChild(h('p', {}, 'After every rated game, Stockfish evaluates each of your moves against its own best move. We compute Average Centipawn Loss (ACPL) and move-by-move accuracy, then store the last 6 games as a rolling average. Consistent engine-level play pushes both metrics into unreachable territory for humans — and triggers the flag.'));

  view.appendChild(h('h3', {}, 'Secondary signals'));
  view.appendChild(h('p', {}, 'Move-time variance (engines produce unnaturally uniform timings), instant-move ratio on complex positions, tab-switch and focus-loss events during rated games, and IP clustering across accounts. These alone are weak evidence; combined with ACPL they strengthen the signal.'));

  view.appendChild(h('h3', {}, 'Shadow-pool matchmaking'));
  view.appendChild(h('p', {}, 'When an account is flagged, nothing visible changes for that user. They still queue, still get matched, still see ratings change — but they only ever match against other flagged accounts. Cheaters play each other; honest players are untouched. No public shame, no appeals circus, no one-shot mistakes.'));

  view.appendChild(h('h3', {}, 'How to stay clean'));
  view.appendChild(h('p', {}, 'Play your own moves. Don\'t switch tabs during rated games. If you use analysis tools, use them outside of games, not during.'));
  return view;
});

function renderNotFound() {
  return h('div', { class: 'loading' },
    h('h2', {}, 'Not found'),
    h('p', {}, 'Nothing here.'));
}

// ---------- Boot ----------
(async function boot() {
  await checkAuth();
  installClickSounds(document);
  sound.setEnabled(state.settings.sound);
  if (!location.hash) location.hash = '#/';
  if (state.user) ensureWs().catch(() => {});
  renderRoute();
})();
