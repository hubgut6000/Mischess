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
    case 'restricted': {
      sound.error();
      onQueueCancelled();
      const expires = msg.expires ? new Date(msg.expires).toLocaleString() : 'until reviewed';
      toast(`Rated play restricted: ${msg.reason}. Expires ${expires}`, 'error');
      break;
    }
    case 'challengeReceived':
      sound.matchFound();
      toast(`${msg.from} challenged you to a game! Check your challenges page.`, 'info');
      break;
    case 'challengeAccepted':
      // Server will follow up with gameStart
      toast(`${msg.username} accepted your challenge`, 'success');
      break;
    case 'newMessage':
      // From DM partner
      sound.click();
      toast(`New message from ${msg.from}`, 'info');
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

  // Hero
  const hero = h('section', { class: 'home-hero' },
    h('span', { class: 'kicker' }, 'Free forever. No ads. Ever.'),
    h('h1', {}, 'Chess, ', h('span', { class: 'ital' }, 'slowly.')),
    h('p', { class: 'lead' },
      "A cozy place to play serious chess. Fair matchmaking, honest anti-cheat, and room to breathe."),
    h('div', { class: 'home-hero-actions' },
      h('a', { href: state.user ? '#/play' : '#/register', 'data-link': '', class: 'btn btn-primary btn-lg' },
        state.user ? 'Play now' : 'Get started'),
      h('a', { href: '#/play/ai', 'data-link': '', class: 'btn btn-outline btn-lg' }, 'Play vs AI'),
    ),
  );
  view.appendChild(hero);

  // Animated board
  const previewWrap = h('div', { class: 'home-board-preview', id: 'home-board-wrap' });
  view.appendChild(previewWrap);

  // 3-up features
  view.appendChild(h('section', { class: 'home-features' },
    h('div', { class: 'home-feature' },
      h('div', { class: 'icon' },
        h('svg', { width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
          h('path', { d: 'M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83' }),
        ),
      ),
      h('h3', {}, 'Real-time play'),
      h('p', {}, 'Bullet, blitz, rapid, classical. Clocks accurate to the millisecond. Sub-100ms move transport over WebSocket.'),
    ),
    h('div', { class: 'home-feature' },
      h('div', { class: 'icon' },
        h('svg', { width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
          h('path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }),
        ),
      ),
      h('h3', {}, 'Fair play, quietly'),
      h('p', {}, 'Every rated game analyzed with Stockfish. Suspicious accounts are shadow-pooled with each other. You never notice them.'),
    ),
    h('div', { class: 'home-feature' },
      h('div', { class: 'icon' },
        h('svg', { width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
          h('circle', { cx: '12', cy: '12', r: '10' }),
          h('path', { d: 'M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01' }),
        ),
      ),
      h('h3', {}, 'Yours to keep'),
      h('p', {}, 'Five themes, custom profile, bio and title. Open source. No tracking, no dark patterns, no upsells.'),
    ),
  ));

  // Manifesto
  view.appendChild(h('section', { class: 'home-manifesto' },
    h('div', { class: 'text' },
      "Most chess sites treat you like a product. We're building the one that treats you like a player.",
    ),
    h('div', { class: 'byline' }, '— Mischess'),
  ));

  // Boot the board animation
  setTimeout(() => {
    const wrap = $('#home-board-wrap');
    if (!wrap) return;
    const boardEl = document.createElement('div');
    wrap.appendChild(boardEl);
    const board = new Board(boardEl, { interactive: false });
    const famous = ['e4','c5','Nf3','d6','d4','cxd4','Nxd4','Nf6','Nc3','a6','Be2','e5','Nb3','Be7','O-O','O-O'];
    let i = 0;
    let inCycle = false;
    const iv = setInterval(() => {
      if (!document.body.contains(wrap)) { clearInterval(iv); return; }
      if (i >= famous.length) {
        if (!inCycle) return; // Wait for next cycle
        i = 0;
        inCycle = false;
        board.chess.reset();
        board.render();
        return;
      }
      inCycle = true;
      const m = board.chess.move(famous[i]);
      if (m) { board.setLastMove(m.from, m.to); board.render(); }
      i++;
    }, 2800);
  }, 100);

  return view;
});

// LOGIN
route('/login', async () => {
  if (state.user) { navigate('#/'); return null; }
  const view = h('div');
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const username = $('input[name=username]', form).value;
    const password = $('input[name=password]', form).value;
    const errBox = $('#err', form);
    errBox.textContent = '';
    try {
      // Get fresh CSRF token before submitting
      await fetch('/api/auth/me', { credentials: 'include' });
      
      const { user, token } = await api('/api/auth/login', { method: 'POST', body: { username, password } });
      state.user = user;
      state.token = token;
      saveToken(token);
      if (user.theme) applyTheme(user.theme);
      renderAuthArea();
      toast('Welcome back', 'success');
      navigate('#/');
    } catch (err) {
      errBox.textContent = err.message;
      sound.error();
    }
  }});
  form.appendChild(h('h1', {}, 'Welcome back'));
  form.appendChild(h('p', { class: 'lead' }, 'Sign in to pick up where you left off.'));
  form.appendChild(h('div', { id: 'err', style: 'color:var(--negative);margin-bottom:14px' }));
  form.appendChild(fieldInput('Username', 'username', 'text', true));
  form.appendChild(fieldInput('Password', 'password', 'password', true));
  form.appendChild(h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit', style: 'margin-top:8px' }, 'Sign in'));
  form.appendChild(h('p', { class: 'form-footer' }, 'No account? ',
    h('a', { href: '#/register', 'data-link': '' }, 'Create one here')));
  view.appendChild(form);
  return view;
});

// REGISTER
route('/register', async () => {
  if (state.user) { navigate('#/'); return null; }
  const view = h('div');
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const username = $('input[name=username]', form).value;
    const email = $('input[name=email]', form).value;
    const password = $('input[name=password]', form).value;
    const errBox = $('#err', form);
    errBox.textContent = '';
    try {
      // Get fresh CSRF token before submitting
      await fetch('/api/auth/me', { credentials: 'include' });
      
      const { user, token } = await api('/api/auth/register', { method: 'POST', body: { username, email, password } });
      state.user = user;
      state.token = token;
      saveToken(token);
      if (user.theme) applyTheme(user.theme);
      renderAuthArea();
      toast('Welcome to Mischess', 'success');
      navigate('#/');
    } catch (err) {
      errBox.textContent = err.message;
      sound.error();
    }
  }});
  form.appendChild(h('h1', {}, 'Create account'));
  form.appendChild(h('p', { class: 'lead' }, "Join us. It's free and always will be."));
  form.appendChild(h('div', { id: 'err', style: 'color:var(--negative);margin-bottom:14px' }));
  form.appendChild(fieldInput('Username', 'username', 'text', true));
  form.appendChild(fieldInput('Email (optional)', 'email', 'email', false));
  form.appendChild(fieldInput('Password', 'password', 'password', true));
  form.appendChild(h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit', style: 'margin-top:8px' }, 'Create account'));
  form.appendChild(h('p', { class: 'form-footer' }, 'Have an account? ',
    h('a', { href: '#/login', 'data-link': '' }, 'Sign in')));
  view.appendChild(form);
  return view;
});

function fieldInput(label, name, type, required) {
  return h('div', { class: 'form-group' },
    h('label', {}, label),
    h('input', { type, name, required: required ? '' : null, autocomplete: name === 'password' ? 'current-password' : name }),
  );
}

// PLAY
route('/play', async () => {
  if (!state.user) { navigate('#/login'); return null; }
  return renderPlayPicker();
});

function renderPlayPicker() {
  const view = h('div', { class: 'play-layout' });
  view.appendChild(h('span', { class: 'kicker' }, 'Matchmaking'));
  view.appendChild(h('h1', {}, 'New game'));
  view.appendChild(h('p', { class: 'lead' }, 'Pick a time control. We\'ll find you a fair opponent.'));

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
  let rated = true;

  const grid = h('div', { class: 'tc-grid' });
  TC.forEach(tc => {
    const card = h('div', { class: 'tc-card' + (tc === selected ? ' selected' : ''), onclick: () => {
      selected = tc;
      $$('.tc-card', grid).forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      sound.click();
    }},
      h('div', { class: 'tc-time' }, tc.label),
      h('div', { class: 'tc-cat' }, tc.cat),
    );
    grid.appendChild(card);
  });
  view.appendChild(grid);

  // Rated toggle styled as segment
  const ratedRow = h('div', { class: 'play-options-row' });
  const ratedBtn = h('button', { class: 'btn btn-primary btn-sm', onclick: () => {
    rated = true;
    ratedBtn.className = 'btn btn-primary btn-sm';
    casualBtn.className = 'btn btn-outline btn-sm';
    sound.click();
  }}, 'Rated');
  const casualBtn = h('button', { class: 'btn btn-outline btn-sm', onclick: () => {
    rated = false;
    casualBtn.className = 'btn btn-primary btn-sm';
    ratedBtn.className = 'btn btn-outline btn-sm';
    sound.click();
  }}, 'Casual');
  ratedRow.appendChild(ratedBtn);
  ratedRow.appendChild(casualBtn);
  view.appendChild(ratedRow);

  view.appendChild(h('div', { class: 'play-action' },
    h('button', { class: 'btn btn-primary btn-lg', onclick: async () => {
      await startSeek(selected.initial, selected.inc, rated);
    }}, 'Find opponent'),
  ));

  view.appendChild(h('div', { class: 'play-options-row', style: 'margin-top:32px' },
    h('a', { href: '#/play/ai', 'data-link': '', class: 'btn btn-ghost' }, 'Play vs computer'),
    h('a', { href: '#/play/friend', 'data-link': '', class: 'btn btn-ghost' }, 'Challenge friend'),
    h('a', { href: '#/play/custom', 'data-link': '', class: 'btn btn-ghost' }, 'Custom modes'),
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
      h('div', { class: 'status-text' },
        h('span', { class: 'dot' }),
        `Searching for opponent · ${initialTime/60}+${increment} · ${rated ? 'rated' : 'casual'}`),
      h('button', { class: 'btn btn-outline btn-sm', onclick: cancelSeek }, 'Cancel'),
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

  const grid = h('div', { class: 'tc-grid' });
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

  const colorRow = h('div', { class: 'play-options-row' });
  ['white', 'random', 'black'].forEach(cName => {
    const btn = h('button', { class: 'btn btn-ghost' + (cName === color ? ' btn-primary' : ''),
      onclick: () => { color = cName; $$('button', colorRow).forEach((b,i) => b.classList.toggle('btn-primary', ['white','random','black'][i] === cName)); }
    }, cName[0].toUpperCase() + cName.slice(1));
    colorRow.appendChild(btn);
  });
  view.appendChild(colorRow);

  view.appendChild(h('div', { class: 'play-options-row' },
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

  const grid = h('div', { class: 'home-features' });
  MODES.forEach(m => {
    grid.appendChild(h('div', { class: "card" },
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
  const info = h('div', { class: "card" },
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
  const grid = h('div', { class: 'tc-grid' });
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

  view.appendChild(h('div', { class: 'play-options-row' },
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
      body.appendChild(h('p', { class: 'toast error' }, e.message));
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
    view.appendChild(h('p', { class: 'toast error' }, e.message));
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
        h('div', { class: 'play-options-row', style: 'justify-content:flex-start;margin-bottom:24px' },
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
    view.appendChild(h('p', { class: 'toast error' }, e.message));
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
// FRIENDS / REQUESTS / CHALLENGES
route('/friends', async () => {
  if (!state.user) { navigate('#/login'); return null; }
  const view = h('div');
  view.appendChild(h('span', { class: 'kicker' }, 'Your circle'));
  view.appendChild(h('h1', {}, 'Friends'));

  // Tabs
  let activeTab = 'friends';
  const tabsEl = h('div', { class: 'lb-tabs', style: 'margin-bottom:24px' });
  const contentEl = h('div');
  view.appendChild(tabsEl);
  view.appendChild(contentEl);

  const tabs = [
    { id: 'friends', label: 'Friends' },
    { id: 'requests', label: 'Requests' },
    { id: 'challenges', label: 'Challenges' },
    { id: 'add', label: 'Add' },
  ];
  tabs.forEach(t => {
    tabsEl.appendChild(h('button', {
      class: 'lb-tab' + (t.id === activeTab ? ' active' : ''),
      onclick: () => { activeTab = t.id; renderTab(); },
    }, t.label));
  });

  async function renderTab() {
    $$('.lb-tab', tabsEl).forEach((b, i) => b.classList.toggle('active', tabs[i].id === activeTab));
    contentEl.innerHTML = '';
    contentEl.appendChild(h('div', { class: 'loading' }, h('div', { class: 'spinner' })));
    try {
      if (activeTab === 'friends') {
        const { friends } = await api('/api/friends');
        contentEl.innerHTML = '';
        if (!friends.length) {
          contentEl.appendChild(h('p', { class: 'text-dim' }, 'No friends yet. Use the Add tab to send a friend request.'));
          return;
        }
        const list = h('div', { class: 'friend-list' });
        for (const f of friends) {
          const isOnline = f.last_seen && (Date.now() - new Date(f.last_seen).getTime() < 5 * 60 * 1000);
          list.appendChild(h('div', { class: 'friend-item' },
            h('div', { class: 'avatar-sm' }, f.username[0].toUpperCase()),
            h('div', { class: 'meta' },
              h('div', { class: 'name' },
                h('span', { class: 'online-dot' + (isOnline ? ' online' : '') }),
                f.username,
                f.title ? h('span', { class: 'title-badge' }, f.title) : null,
              ),
              h('div', { class: 'status' }, `Blitz ${f.rating_blitz} · Rapid ${f.rating_rapid}`),
            ),
            h('div', { class: 'actions' },
              h('a', { class: 'btn btn-outline btn-sm', href: `#/messages/${f.username}`, 'data-link': '' }, 'Message'),
              h('button', { class: 'btn btn-primary btn-sm', onclick: () => challengeFriend(f.username) }, 'Challenge'),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
                if (!confirm(`Remove ${f.username} as a friend?`)) return;
                try {
                  await api('/api/friends/' + encodeURIComponent(f.username), { method: 'DELETE' });
                  toast('Removed', 'success');
                  renderTab();
                } catch (e) { toast(e.message, 'error'); }
              }}, 'Remove'),
            ),
          ));
        }
        contentEl.appendChild(list);
      } else if (activeTab === 'requests') {
        const { incoming, outgoing } = await api('/api/friends/requests');
        contentEl.innerHTML = '';
        contentEl.appendChild(h('h3', { style: 'margin-top:0' }, `Incoming (${incoming.length})`));
        if (!incoming.length) contentEl.appendChild(h('p', { class: 'text-dim' }, 'No pending requests.'));
        const incList = h('div', { class: 'friend-list' });
        for (const r of incoming) {
          incList.appendChild(h('div', { class: 'friend-item' },
            h('div', { class: 'avatar-sm' }, r.username[0].toUpperCase()),
            h('div', { class: 'meta' },
              h('div', { class: 'name' }, r.username),
              h('div', { class: 'status' }, `Sent ${new Date(r.created_at).toLocaleDateString()}`),
            ),
            h('div', { class: 'actions' },
              h('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
                try {
                  await api(`/api/friends/requests/${r.id}/accept`, { method: 'POST' });
                  toast(`You're now friends with ${r.username}`, 'success');
                  renderTab();
                } catch (e) { toast(e.message, 'error'); }
              }}, 'Accept'),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
                try {
                  await api(`/api/friends/requests/${r.id}/decline`, { method: 'POST' });
                  renderTab();
                } catch (e) { toast(e.message, 'error'); }
              }}, 'Decline'),
            ),
          ));
        }
        contentEl.appendChild(incList);

        contentEl.appendChild(h('h3', { style: 'margin-top:32px' }, `Outgoing (${outgoing.length})`));
        if (!outgoing.length) contentEl.appendChild(h('p', { class: 'text-dim' }, 'No outgoing requests.'));
        const outList = h('div', { class: 'friend-list' });
        for (const r of outgoing) {
          outList.appendChild(h('div', { class: 'friend-item' },
            h('div', { class: 'avatar-sm' }, r.username[0].toUpperCase()),
            h('div', { class: 'meta' },
              h('div', { class: 'name' }, r.username),
              h('div', { class: 'status' }, 'Pending...'),
            ),
          ));
        }
        contentEl.appendChild(outList);
      } else if (activeTab === 'challenges') {
        const { incoming } = await api('/api/friends/challenges');
        contentEl.innerHTML = '';
        if (!incoming.length) {
          contentEl.appendChild(h('p', { class: 'text-dim' }, 'No pending challenges.'));
          return;
        }
        const list = h('div', { class: 'friend-list' });
        for (const c of incoming) {
          list.appendChild(h('div', { class: 'friend-item' },
            h('div', { class: 'avatar-sm' }, c.username[0].toUpperCase()),
            h('div', { class: 'meta' },
              h('div', { class: 'name' }, `${c.username} challenged you`),
              h('div', { class: 'status' },
                `${Math.floor(c.initial_time / 60)}+${c.increment} · ${c.rated ? 'rated' : 'casual'} · ${c.color}`),
            ),
            h('div', { class: 'actions' },
              h('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
                try {
                  const res = await api(`/api/friends/challenges/${c.id}/accept`, { method: 'POST' });
                  // Server creates game via WS - send acceptance event
                  await ensureWs();
                  sendWs({ type: 'acceptChallenge', challengeId: c.id });
                  toast('Challenge accepted, starting game...', 'success');
                } catch (e) { toast(e.message, 'error'); }
              }}, 'Accept'),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
                try {
                  await api(`/api/friends/challenges/${c.id}/decline`, { method: 'POST' });
                  renderTab();
                } catch (e) { toast(e.message, 'error'); }
              }}, 'Decline'),
            ),
          ));
        }
        contentEl.appendChild(list);
      } else if (activeTab === 'add') {
        contentEl.innerHTML = '';
        contentEl.appendChild(h('p', {}, 'Send a friend request by username.'));
        let username = '';
        const form = h('form', { onsubmit: async (e) => {
          e.preventDefault();
          if (!username) return;
          try {
            await api('/api/friends/requests', { method: 'POST', body: { username } });
            toast(`Friend request sent to ${username}`, 'success');
            username = '';
            $('input', form).value = '';
          } catch (err) { toast(err.message, 'error'); }
        }, style: 'display:flex;gap:10px;align-items:flex-end;max-width:480px' },
          h('div', { class: 'form-group', style: 'flex:1;margin:0' },
            h('label', {}, 'Username'),
            h('input', { type: 'text', placeholder: 'their_username', oninput: (e) => username = e.target.value.trim() }),
          ),
          h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send request'),
        );
        contentEl.appendChild(form);
      }
    } catch (e) {
      contentEl.innerHTML = '';
      contentEl.appendChild(h('p', { class: 'toast error' }, e.message));
    }
  }

  renderTab();
  return view;
});

async function challengeFriend(username) {
  // Show modal with time controls
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => {
    if (e.target === backdrop) backdrop.remove();
  }});
  let initialTime = 300, increment = 0, rated = true, color = 'random';
  const modal = h('div', { class: 'modal' });
  modal.appendChild(h('h2', {}, `Challenge ${username}`));
  modal.appendChild(h('p', {}, 'Pick time and settings.'));

  const TC = [
    { it: 60, inc: 0, label: '1+0' }, { it: 180, inc: 0, label: '3+0' },
    { it: 180, inc: 2, label: '3+2' }, { it: 300, inc: 0, label: '5+0' },
    { it: 300, inc: 3, label: '5+3' }, { it: 600, inc: 0, label: '10+0' },
    { it: 900, inc: 10, label: '15+10' }, { it: 1800, inc: 0, label: '30+0' },
  ];
  const tcGrid = h('div', { class: 'tc-grid', style: 'margin:14px 0' });
  TC.forEach(t => {
    const c = h('div', { class: 'tc-card' + (t.it === 300 && t.inc === 0 ? ' selected' : ''),
      onclick: () => {
        initialTime = t.it; increment = t.inc;
        $$('.tc-card', tcGrid).forEach(x => x.classList.remove('selected'));
        c.classList.add('selected');
      } },
      h('div', { class: 'tc-time' }, t.label),
    );
    tcGrid.appendChild(c);
  });
  modal.appendChild(tcGrid);

  modal.appendChild(h('div', { class: 'play-options-row' },
    h('button', { class: 'btn btn-primary btn-sm', id: 'rb', onclick: () => {
      rated = true;
      $('#rb', modal).className = 'btn btn-primary btn-sm';
      $('#cb', modal).className = 'btn btn-outline btn-sm';
    }}, 'Rated'),
    h('button', { class: 'btn btn-outline btn-sm', id: 'cb', onclick: () => {
      rated = false;
      $('#cb', modal).className = 'btn btn-primary btn-sm';
      $('#rb', modal).className = 'btn btn-outline btn-sm';
    }}, 'Casual'),
  ));

  modal.appendChild(h('div', { class: 'modal-actions' },
    h('button', { class: 'btn btn-ghost', onclick: () => backdrop.remove() }, 'Cancel'),
    h('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        await api('/api/friends/challenges', {
          method: 'POST',
          body: { username, initialTime, increment, rated, color },
        });
        toast(`Challenge sent to ${username}`, 'success');
        backdrop.remove();
      } catch (e) { toast(e.message, 'error'); }
    }}, 'Send challenge'),
  ));

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

// MESSAGES (DMs)
route('/messages', async () => {
  if (!state.user) { navigate('#/login'); return null; }
  const view = h('div');
  view.appendChild(h('span', { class: 'kicker' }, 'Direct'));
  view.appendChild(h('h1', {}, 'Messages'));
  view.appendChild(h('p', { class: 'lead' }, 'You can message anyone you\'re friends with.'));
  const list = h('div', { class: 'friend-list', style: 'margin-top:24px' });
  view.appendChild(list);
  try {
    const { conversations } = await api('/api/friends/messages');
    if (!conversations.length) {
      list.appendChild(h('p', { class: 'text-dim' }, 'No conversations yet. Visit Friends to start one.'));
      return view;
    }
    for (const c of conversations) {
      list.appendChild(h('a', {
        class: 'friend-item',
        href: `#/messages/${c.username}`,
        'data-link': '',
        style: 'text-decoration:none;color:inherit',
      },
        h('div', { class: 'avatar-sm' }, c.username[0].toUpperCase()),
        h('div', { class: 'meta' },
          h('div', { class: 'name' }, c.username),
          h('div', { class: 'status', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
            (c.mine ? 'You: ' : '') + c.body),
        ),
        h('div', { class: 'text-dim', style: 'font-size:0.78rem' },
          new Date(c.created_at).toLocaleDateString()),
      ));
    }
  } catch (e) {
    list.appendChild(h('p', { class: 'toast error' }, e.message));
  }
  return view;
});

route('/messages/:username', async (params) => {
  if (!state.user) { navigate('#/login'); return null; }
  const view = h('div');
  const username = params.username;
  view.appendChild(h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:20px' },
    h('a', { href: '#/messages', 'data-link': '', class: 'btn btn-ghost btn-sm' }, '← All'),
    h('h1', { style: 'margin:0' }, username),
  ));

  const conv = h('div', { class: 'side-card', style: 'display:flex;flex-direction:column;height:65vh' });
  const messagesEl = h('div', { class: 'dm-messages' });
  const inputEl = h('input', { placeholder: 'Type a message...', maxlength: '1000' });
  const formEl = h('form', { class: 'dm-input-row', onsubmit: async (e) => {
    e.preventDefault();
    const body = inputEl.value.trim();
    if (!body) return;
    try {
      const { message } = await api(`/api/friends/messages/${encodeURIComponent(username)}`, {
        method: 'POST', body: { body },
      });
      messagesEl.appendChild(renderDmMessage(message, true));
      messagesEl.scrollTop = messagesEl.scrollHeight;
      inputEl.value = '';
    } catch (err) { toast(err.message, 'error'); }
  }});
  formEl.appendChild(inputEl);
  formEl.appendChild(h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send'));
  conv.appendChild(messagesEl);
  conv.appendChild(formEl);
  view.appendChild(conv);

  try {
    const { messages } = await api('/api/friends/messages/' + encodeURIComponent(username));
    for (const m of messages) {
      const mine = m.from_id === state.user.id;
      messagesEl.appendChild(renderDmMessage(m, mine));
    }
    setTimeout(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }, 50);
  } catch (e) {
    messagesEl.appendChild(h('p', { class: 'toast error' }, e.message));
  }
  return view;
});

function renderDmMessage(m, mine) {
  return h('div', { class: 'dm-message' + (mine ? ' mine' : '') },
    h('div', {}, m.body),
    h('div', { class: 'time' }, new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
  );
}

// ANALYSIS (post-game review)
route('/analysis/:id', async (params) => {
  const view = h('div');
  view.appendChild(h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:20px' },
    h('a', { href: `#/game/${params.id}`, 'data-link': '', class: 'btn btn-ghost btn-sm' }, '← Game'),
    h('h1', { style: 'margin:0' }, 'Game review'),
  ));
  const loading = h('div', { class: 'loading' }, h('div', { class: 'spinner' }));
  view.appendChild(loading);
  try {
    const { game, analysis, queued } = await api(`/api/games/${params.id}/analysis`);
    view.removeChild(loading);

    // Summary
    const summary = h('div', { class: 'analysis-summary' });
    if (game.white_acpl != null || game.black_acpl != null) {
      const stats = computeMoveStats(analysis, 'white');
      const bstats = computeMoveStats(analysis, 'black');
      summary.appendChild(buildAnalysisStat(game.white_name || 'White', game.white_accuracy, game.white_acpl, stats));
      summary.appendChild(buildAnalysisStat(game.black_name || 'Black', game.black_accuracy, game.black_acpl, bstats));
    }
    view.appendChild(summary);

    if (queued || !analysis.length) {
      view.appendChild(h('p', { class: 'text-dim' },
        'Analysis is being processed in the background. Check back in a minute.'));
      return view;
    }

    // Move-by-move list
    const movesCard = h('div', { class: 'side-card', style: 'margin-top:20px' });
    movesCard.appendChild(h('div', { class: 'side-card-header' }, h('h4', {}, 'Move-by-move')));
    const movesBody = h('div', { class: 'side-card-body' });
    const tbl = h('table', { class: 'leaderboard-table', style: 'width:100%' });
    tbl.appendChild(h('thead', {}, h('tr', {},
      h('th', {}, '#'),
      h('th', {}, 'Played'),
      h('th', {}, 'Best'),
      h('th', {}, 'Eval before'),
      h('th', {}, 'Eval after'),
      h('th', {}, ''),
    )));
    const tbody = h('tbody');
    for (const m of analysis) {
      const cls = m.classification || '';
      tbody.appendChild(h('tr', {},
        h('td', {}, String(Math.ceil(m.ply / 2))),
        h('td', { class: 'mono' }, m.played_san),
        h('td', { class: 'mono', style: 'color:var(--ink-3)' }, m.best_move_san || '—'),
        h('td', { class: 'mono' }, formatEval(m.eval_before)),
        h('td', { class: 'mono' }, formatEval(m.eval_after)),
        h('td', { style: `color:${classColor(cls)};font-weight:600;text-transform:capitalize` }, cls),
      ));
    }
    tbl.appendChild(tbody);
    movesBody.appendChild(tbl);
    movesCard.appendChild(movesBody);
    view.appendChild(movesCard);
  } catch (e) {
    view.removeChild(loading);
    view.appendChild(h('p', { class: 'toast error' }, e.message));
  }
  return view;
});

function computeMoveStats(analysis, color) {
  const counts = { brilliant: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const m of analysis) {
    const isWhite = m.ply % 2 === 1; // ply 1 = white, 2 = black
    if ((color === 'white') !== isWhite) continue;
    if (counts[m.classification] != null) counts[m.classification]++;
  }
  return counts;
}

function buildAnalysisStat(name, accuracy, acpl, counts) {
  const card = h('div', { class: 'analysis-stat' });
  card.appendChild(h('div', { class: 'player-name' }, name));
  card.appendChild(h('div', { class: 'accuracy-value' }, accuracy != null ? `${Math.round(accuracy)}%` : '—'));
  card.appendChild(h('div', { class: 'accuracy-label' }, `Accuracy${acpl != null ? ` · ACPL ${Math.round(acpl)}` : ''}`));
  if (counts) {
    const grid = h('div', { class: 'move-counts' });
    grid.appendChild(h('div', { class: 'move-count-item good' },
      h('div', { class: 'num' }, String(counts.good)),
      h('div', {}, 'Good')));
    grid.appendChild(h('div', { class: 'move-count-item inaccuracy' },
      h('div', { class: 'num' }, String(counts.inaccuracy)),
      h('div', {}, '?!')));
    grid.appendChild(h('div', { class: 'move-count-item mistake' },
      h('div', { class: 'num' }, String(counts.mistake)),
      h('div', {}, '?')));
    grid.appendChild(h('div', { class: 'move-count-item blunder' },
      h('div', { class: 'num' }, String(counts.blunder)),
      h('div', {}, '??')));
    card.appendChild(grid);
  }
  return card;
}

function formatEval(e) {
  if (e == null) return '—';
  const n = Number(e);
  if (Math.abs(n) > 100) return n > 0 ? `M${Math.ceil(n - 100)}` : `-M${Math.ceil(-n - 100)}`;
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

function classColor(c) {
  return {
    brilliant: '#5fc6f2', good: 'var(--positive)',
    inaccuracy: 'var(--caution)', mistake: '#e09a5e', blunder: 'var(--negative)',
  }[c] || 'var(--ink-2)';
}

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
    return h('div', { class: 'toast error' }, e.message);
  }
});

function renderFinishedGame(game) {
  const view = h('div', { class: 'game-page' });
  const boardCol = h('div', { class: 'game-board-col' });

  // Parse moves
  let history = [];
  try {
    if (game.moves) history = JSON.parse(game.moves);
  } catch {}

  // Build chess instance with full game replayed
  const chess = new window.Chess();
  for (const m of history) chess.move(m);

  // Track current ply for navigation
  let currentPly = history.length; // start at end

  // Player strips with avatars
  const topStrip = h('div', { class: 'player-strip' },
    h('div', { class: 'player-info' },
      h('div', { class: 'avatar' }, (game.black_name || '?')[0].toUpperCase()),
      h('div', { class: 'name-block' },
        h('div', { class: 'name' }, game.black_name || 'Black'),
        h('div', { class: 'rating' }, String(game.black_rating_after || game.black_rating_before || '')),
      ),
    ),
    game.black_acpl != null ? h('div', { style: 'text-align:right' },
      h('div', { style: 'font-family:var(--font-mono);font-size:0.85rem;color:var(--accent)' },
        `${Math.round(game.black_accuracy || 0)}% acc`),
      h('div', { style: 'font-family:var(--font-mono);font-size:0.75rem;color:var(--ink-3)' },
        `ACPL ${Math.round(game.black_acpl)}`),
    ) : null,
  );
  const boardEl = h('div');
  const botStrip = h('div', { class: 'player-strip' },
    h('div', { class: 'player-info' },
      h('div', { class: 'avatar' }, (game.white_name || '?')[0].toUpperCase()),
      h('div', { class: 'name-block' },
        h('div', { class: 'name' }, game.white_name || 'White'),
        h('div', { class: 'rating' }, String(game.white_rating_after || game.white_rating_before || '')),
      ),
    ),
    game.white_acpl != null ? h('div', { style: 'text-align:right' },
      h('div', { style: 'font-family:var(--font-mono);font-size:0.85rem;color:var(--accent)' },
        `${Math.round(game.white_accuracy || 0)}% acc`),
      h('div', { style: 'font-family:var(--font-mono);font-size:0.75rem;color:var(--ink-3)' },
        `ACPL ${Math.round(game.white_acpl)}`),
    ) : null,
  );
  boardCol.appendChild(topStrip);
  boardCol.appendChild(boardEl);
  boardCol.appendChild(botStrip);

  // Replay control bar
  const controls = h('div', { class: 'replay-controls' },
    h('button', { class: 'btn btn-outline btn-sm', title: 'First move (Home)', onclick: () => goToPly(0) }, '⏮'),
    h('button', { class: 'btn btn-outline btn-sm', title: 'Previous (←)', onclick: () => goToPly(currentPly - 1) }, '◀'),
    h('button', { class: 'btn btn-outline btn-sm', title: 'Next (→)', onclick: () => goToPly(currentPly + 1) }, '▶'),
    h('button', { class: 'btn btn-outline btn-sm', title: 'Last move (End)', onclick: () => goToPly(history.length) }, '⏭'),
    h('div', { style: 'flex:1' }),
    h('button', { class: 'btn btn-primary btn-sm', onclick: () => navigate(`#/analysis/${game.id}`) }, '🔍 Analyze'),
  );
  boardCol.appendChild(controls);

  // Side col
  const sideCol = h('div', { class: 'game-side-col' });

  // Result card
  const resultCard = h('div', { class: 'side-card' });
  const winnerName = game.result === '1-0' ? game.white_name : (game.result === '0-1' ? game.black_name : null);
  resultCard.appendChild(h('div', { class: 'side-card-header' },
    h('h4', {}, winnerName ? `${winnerName} won` : (game.result === '1/2-1/2' ? 'Draw' : 'Game ended')),
    h('span', { style: 'font-family:var(--font-mono);font-size:0.78rem;color:var(--ink-3)' }, game.result || '?'),
  ));
  const resBody = h('div', { class: 'side-card-body' });
  resBody.appendChild(h('p', { style: 'margin:0 0 8px;color:var(--ink-2)' }, game.termination || ''));
  resBody.appendChild(h('p', { style: 'margin:0;font-size:0.85rem;color:var(--ink-3)' },
    `${game.category} · ${game.time_control}${game.rated ? ' · rated' : ' · casual'}`));
  if (game.white_rating_after && game.white_rating_before) {
    const wDiff = game.white_rating_after - game.white_rating_before;
    const bDiff = (game.black_rating_after || 0) - (game.black_rating_before || 0);
    resBody.appendChild(h('div', { style: 'margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.85rem' },
      h('div', {},
        h('div', { style: 'color:var(--ink-3)' }, game.white_name),
        h('div', { style: 'font-family:var(--font-mono)' },
          `${game.white_rating_before} → ${game.white_rating_after} `,
          h('span', { style: `color:${wDiff > 0 ? 'var(--positive)' : 'var(--negative)'}` },
            `${wDiff > 0 ? '+' : ''}${wDiff}`)),
      ),
      h('div', {},
        h('div', { style: 'color:var(--ink-3)' }, game.black_name),
        h('div', { style: 'font-family:var(--font-mono)' },
          `${game.black_rating_before} → ${game.black_rating_after} `,
          h('span', { style: `color:${bDiff > 0 ? 'var(--positive)' : 'var(--negative)'}` },
            `${bDiff > 0 ? '+' : ''}${bDiff}`)),
      ),
    ));
  }
  resultCard.appendChild(resBody);
  sideCol.appendChild(resultCard);

  // Moves card
  const movesCard = h('div', { class: 'side-card' });
  movesCard.appendChild(h('div', { class: 'side-card-header' }, h('h4', {}, `Moves (${history.length})`)));
  const movesEl = h('div', { class: 'move-list' }, h('div', { class: 'moves' }));
  movesCard.appendChild(movesEl);
  sideCol.appendChild(movesCard);

  view.appendChild(boardCol);
  view.appendChild(sideCol);

  // Build board
  const board = new Board(boardEl, { interactive: false });

  function goToPly(ply) {
    ply = Math.max(0, Math.min(history.length, ply));
    currentPly = ply;
    const c = new window.Chess();
    for (let i = 0; i < ply; i++) c.move(history[i]);
    board.chess = c;
    if (ply > 0) {
      const m = c.history({ verbose: true })[ply - 1];
      if (m) board.setLastMove(m.from, m.to);
    } else {
      board.setLastMove(null, null);
    }
    board.render();
    // Update move list highlights
    $$('.moves .move', movesEl).forEach((el, idx) => {
      el.classList.toggle('current', idx === ply - 1);
    });
    // Scroll current move into view
    const cur = movesEl.querySelector('.move.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  // Render move list with click-to-navigate
  const movesContainer = movesEl.querySelector('.moves');
  for (let i = 0; i < history.length; i += 2) {
    const pair = h('div', { class: 'move-pair' },
      h('div', { class: 'move-number' }, `${(i / 2) + 1}.`),
      h('div', { class: 'move', onclick: () => goToPly(i + 1) }, history[i] || ''),
      h('div', { class: 'move', onclick: () => goToPly(i + 2) }, history[i + 1] || ''),
    );
    movesContainer.appendChild(pair);
  }

  // Initial position = full game
  goToPly(history.length);

  // Keyboard nav
  const keyHandler = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); goToPly(currentPly - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); goToPly(currentPly + 1); }
    else if (e.key === 'Home') { e.preventDefault(); goToPly(0); }
    else if (e.key === 'End') { e.preventDefault(); goToPly(history.length); }
  };
  document.addEventListener('keydown', keyHandler);
  // Cleanup when view replaced
  state.cleanups = state.cleanups || [];
  state.cleanups.push(() => document.removeEventListener('keydown', keyHandler));

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

  const topStrip = h('div', { class: 'player-strip', id: 'strip-top' },
    h('div', { class: 'player-info' },
      h('div', { class: 'avatar' }, game[topPlayer][0].toUpperCase()),
      h('div', { class: 'name-block' },
        h('div', { class: 'name' }, game[topPlayer]),
        h('div', { class: 'rating' }, String(game[topPlayer + 'Rating'])),
      ),
    ),
    h('div', { class: 'clock', id: 'clock-top' }, fmtTime(game[topPlayer + 'Time'])),
  );
  boardCol.appendChild(topStrip);
  const boardEl = h('div');
  boardCol.appendChild(boardEl);
  const botStrip = h('div', { class: 'player-strip', id: 'strip-bot' },
    h('div', { class: 'player-info' },
      h('div', { class: 'avatar' }, game[botPlayer][0].toUpperCase()),
      h('div', { class: 'name-block' },
        h('div', { class: 'name' }, game[botPlayer]),
        h('div', { class: 'rating' }, String(game[botPlayer + 'Rating'])),
      ),
    ),
    h('div', { class: 'clock', id: 'clock-bot' }, fmtTime(game[botPlayer + 'Time'])),
  );
  boardCol.appendChild(botStrip);

  const sideCol = h('div', { class: 'game-side-col' });

  // Moves card
  const movesCard = h('div', { class: 'side-card' });
  movesCard.appendChild(h('div', { class: 'side-card-header' },
    h('h4', {}, 'Moves'),
    h('span', { style: 'font-family:var(--font-mono);font-size:0.78rem;color:var(--ink-3)' },
      `${game.category} · ${game.timeControl}${game.rated ? ' · rated' : ''}`),
  ));
  const movesEl = h('div', { class: 'move-list' }, h('div', { class: 'moves' }));
  movesCard.appendChild(movesEl);

  const isPlayer = state.playerColor !== null;
  if (isPlayer || !game.ended) {
    const actions = h('div', { class: 'game-actions' });
    if (isPlayer) {
      actions.appendChild(h('button', { class: 'btn btn-outline btn-sm', onclick: () => {
        if (confirm('Resign this game?')) sendWs({ type: 'resign' });
      }}, 'Resign'));
      actions.appendChild(h('button', { class: 'btn btn-outline btn-sm', onclick: () => {
        sendWs({ type: 'offerDraw' });
        toast('Draw offered');
      }}, 'Draw'));
      if (game.moves.length < 2) {
        actions.appendChild(h('button', { class: 'btn btn-outline btn-sm', onclick: () => {
          sendWs({ type: 'abort' });
        }}, 'Abort'));
      }
    }
    movesCard.appendChild(actions);
  }
  sideCol.appendChild(movesCard);

  // Chat card
  if (isPlayer) {
    const chatCard = h('div', { class: 'side-card' });
    chatCard.appendChild(h('div', { class: 'side-card-header' }, h('h4', {}, 'Chat')));
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
    chatCard.appendChild(chatBox);
    sideCol.appendChild(chatCard);
  }

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
  const topStrip = $('#strip-top');
  const botStrip = $('#strip-bot');
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
  if (topStrip) topStrip.classList.toggle('active-turn', game.turn === topPlayer && !game.ended);
  if (botStrip) botStrip.classList.toggle('active-turn', game.turn === botPlayer && !game.ended);
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
  const view = h('div', { class: 'settings-layout' });
  view.appendChild(h('span', { class: 'kicker' }, 'Your space'));
  view.appendChild(h('h1', {}, 'Settings'));
  view.appendChild(h('p', { class: 'lead' }, 'Make Mischess yours.'));

  // ===== Theme picker =====
  const themeSection = h('div', { class: "settings-section" });
  themeSection.appendChild(h('h3', {}, 'Theme'));
  themeSection.appendChild(h('p', { class: 'section-desc' }, 'Pick the vibe. Saved to your account if signed in.'));
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
  const audioSection = h('div', { class: "settings-section" });
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
    const profileSection = h('div', { class: "settings-section" });
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
  const accountSection = h('div', { class: "settings-section" });
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
