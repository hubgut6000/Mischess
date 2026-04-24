/**
 * Client-side anti-cheat telemetry.
 *
 * Detects and reports (via WebSocket) suspicious client-side behavior during
 * rated games. These signals are soft evidence — combined with server-side
 * ACPL analysis, they strengthen flag confidence.
 *
 * Signals collected:
 *  - devtools_open: user opened browser devtools during a game
 *  - paste_during_game: clipboard paste in the window during a game
 *  - multi_tab: another tab of Mischess is open (via BroadcastChannel)
 *  - visibility_change: tab hidden/shown correlated with move times
 *  - rapid_idle: no mouse activity for >30s followed by a move
 *  - zero_mouse_drift: moves with literally zero mouse movement between clicks
 */

export class AntiCheatTelemetry {
  constructor(sendFn) {
    this.send = sendFn; // function to emit event to server
    this.active = false;
    this.gameId = null;
    this.mouseX = 0;
    this.mouseY = 0;
    this.lastMouseAt = Date.now();
    this.mouseSamples = [];
    this.devtoolsWasOpen = false;
    this.lastVisibility = document.visibilityState;
    this.channel = null;
    this._bindListeners();
    this._startDevtoolsWatcher();
  }

  activate(gameId) {
    this.gameId = gameId;
    this.active = true;
    // Announce to other tabs that a game is active on this account
    try {
      this.channel = new BroadcastChannel('mischess-game');
      this.channel.postMessage({ type: 'game-start', gameId });
      this.channel.onmessage = (ev) => {
        if (ev.data?.type === 'game-start' && ev.data.gameId !== gameId) {
          this._report('multi_tab_game', { other: ev.data.gameId });
        }
      };
    } catch {}
  }

  deactivate() {
    this.active = false;
    this.gameId = null;
    if (this.channel) { try { this.channel.close(); } catch {} this.channel = null; }
  }

  _bindListeners() {
    // Paste during game (clipboard access is suspicious mid-game)
    document.addEventListener('paste', (e) => {
      if (!this.active) return;
      this._report('paste_during_game', {});
    });

    // Context menu / right-click on board (unusual)
    document.addEventListener('visibilitychange', () => {
      if (!this.active) return;
      const state = document.visibilityState;
      if (state !== this.lastVisibility) {
        this._report(state === 'hidden' ? 'blur' : 'focus', {});
        this.lastVisibility = state;
      }
    });

    // Mouse tracking
    document.addEventListener('mousemove', (e) => {
      const now = Date.now();
      const dx = e.clientX - this.mouseX;
      const dy = e.clientY - this.mouseY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.lastMouseAt = now;
      if (this.active && this.mouseSamples.length < 2000) {
        this.mouseSamples.push({ t: now, d: dist });
      }
    });

    // Blur / focus (window-level, separate from visibility)
    window.addEventListener('blur', () => {
      if (this.active) this._report('window_blur', {});
    });
    window.addEventListener('focus', () => {
      if (this.active) this._report('window_focus', {});
    });

    // Keyboard during game - Alt-Tab, Cmd-Tab often trigger meta keys
    document.addEventListener('keydown', (e) => {
      if (!this.active) return;
      // F12, Ctrl+Shift+I, Cmd+Opt+I = devtools
      if (e.key === 'F12' ||
          ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j'))) {
        this._report('devtools_shortcut', {});
      }
    });
  }

  /**
   * Devtools detection via dimension heuristic. Not bulletproof but catches
   * most casual uses (opening devtools changes window.outerWidth - window.innerWidth).
   */
  _startDevtoolsWatcher() {
    const threshold = 160;
    setInterval(() => {
      if (!this.active) return;
      const widthDiff = window.outerWidth - window.innerWidth;
      const heightDiff = window.outerHeight - window.innerHeight;
      const isOpen = widthDiff > threshold || heightDiff > threshold;
      if (isOpen && !this.devtoolsWasOpen) {
        this._report('devtools_open', {});
        this.devtoolsWasOpen = true;
      } else if (!isOpen && this.devtoolsWasOpen) {
        this.devtoolsWasOpen = false;
      }
    }, 2000);

    // Secondary technique: debugger timing (throws if devtools open)
    setInterval(() => {
      if (!this.active) return;
      const start = performance.now();
      debugger; // only pauses if devtools open
      const elapsed = performance.now() - start;
      if (elapsed > 100 && !this.devtoolsWasOpen) {
        this._report('devtools_open', { method: 'debugger_timing' });
        this.devtoolsWasOpen = true;
      }
    }, 4000);
  }

  /**
   * Called when the user makes a move. Provides pre-move mouse pattern data.
   */
  onBeforeMove() {
    if (!this.active) return null;
    // Look at mouse activity in the last 5 seconds
    const now = Date.now();
    const recent = this.mouseSamples.filter(s => now - s.t < 5000);
    const totalDist = recent.reduce((a, b) => a + b.d, 0);
    const idleMs = now - this.lastMouseAt;
    this.mouseSamples = recent;
    if (idleMs > 30000 && recent.length < 5) {
      this._report('zero_mouse_drift', { idleMs, samples: recent.length });
    }
    return { totalDist, idleMs, samples: recent.length };
  }

  _report(type, data) {
    if (!this.active || !this.gameId) return;
    try {
      this.send({ type: 'telemetry', event: type, data, gameId: this.gameId, t: Date.now() });
    } catch {}
  }
}
