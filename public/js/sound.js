/**
 * SoundManager - all UI and game audio.
 * Uses Web Audio API synthesis so there are no external audio files to load.
 * Sounds are generated on the fly from oscillators with envelopes.
 * Respects a user setting (persisted in localStorage).
 */

const STORAGE_KEY = 'mischess:audio-enabled';

class SoundManager {
  constructor() {
    this.ctx = null;
    this.enabled = this._loadPref();
    this.masterGain = null;
    this.searchLoop = null;  // active matchmaking loop node
    this._initialized = false;
  }

  _loadPref() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === null ? true : v === '1';
    } catch { return true; }
  }

  _savePref() {
    try { localStorage.setItem(STORAGE_KEY, this.enabled ? '1' : '0'); } catch {}
  }

  /** Must be called from a user gesture (click). Browsers block AudioContext otherwise. */
  _ensureCtx() {
    if (this._initialized) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.35;
      this.masterGain.connect(this.ctx.destination);
      this._initialized = true;
    } catch (e) { /* no audio, silently no-op */ }
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._savePref();
    if (!this.enabled) this.stopSearch();
  }

  isEnabled() { return this.enabled; }

  /**
   * Core synth: play a note with a frequency envelope and amplitude envelope.
   */
  _tone({ freq = 440, freqEnd = null, duration = 0.1, attack = 0.005, decay = 0.08,
          type = 'sine', gain = 0.25, delay = 0 } = {}) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + duration);
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  _noise({ duration = 0.05, gain = 0.15, highpass = 1200, delay = 0 } = {}) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const bufferSize = Math.max(256, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const biquad = this.ctx.createBiquadFilter();
    biquad.type = 'highpass';
    biquad.frequency.value = highpass;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(biquad); biquad.connect(g); g.connect(this.masterGain);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  // --- Public sound effects ---

  /** Soft pop/click for buttons. */
  click() {
    this._ensureCtx();
    this._tone({ freq: 880, freqEnd: 520, duration: 0.06, type: 'sine', gain: 0.18 });
    this._noise({ duration: 0.02, gain: 0.05, highpass: 2000 });
  }

  /** Slightly heavier UI confirm (modal action, large button). */
  confirm() {
    this._ensureCtx();
    this._tone({ freq: 660, freqEnd: 990, duration: 0.12, type: 'triangle', gain: 0.22 });
  }

  /** Trigger haptic feedback if available (mobile only) */
  _haptic(pattern) {
    try {
      if (this.hapticDisabled) return;
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(pattern);
      }
    } catch {}
  }

  /** Chess move — a wooden "clack". */
  move() {
    this._ensureCtx();
    this._tone({ freq: 180, freqEnd: 90, duration: 0.08, type: 'square', gain: 0.12 });
    this._noise({ duration: 0.03, gain: 0.08, highpass: 1500 });
    this._haptic(8);
  }

  /** Capture — slightly sharper, includes noise burst. */
  capture() {
    this._ensureCtx();
    this._tone({ freq: 140, freqEnd: 70, duration: 0.1, type: 'square', gain: 0.15 });
    this._noise({ duration: 0.06, gain: 0.12, highpass: 800 });
    this._haptic(15);
  }

  /** Check — alert ping. */
  check() {
    this._ensureCtx();
    this._tone({ freq: 880, duration: 0.1, type: 'triangle', gain: 0.22 });
    this._tone({ freq: 1320, duration: 0.15, type: 'triangle', gain: 0.18, delay: 0.08 });
    this._haptic([10, 30, 10]);
  }

  /** Game over — descending melody. */
  gameEnd() {
    this._ensureCtx();
    this._tone({ freq: 660, duration: 0.2, type: 'triangle', gain: 0.25 });
    this._tone({ freq: 495, duration: 0.2, type: 'triangle', gain: 0.22, delay: 0.15 });
    this._tone({ freq: 330, duration: 0.35, type: 'triangle', gain: 0.2, delay: 0.3 });
  }

  /** Victory fanfare. */
  victory() {
    this._ensureCtx();
    this._tone({ freq: 523.25, duration: 0.15, type: 'triangle', gain: 0.25 });
    this._tone({ freq: 659.25, duration: 0.15, type: 'triangle', gain: 0.25, delay: 0.12 });
    this._tone({ freq: 783.99, duration: 0.15, type: 'triangle', gain: 0.25, delay: 0.24 });
    this._tone({ freq: 1046.5, duration: 0.3, type: 'triangle', gain: 0.3, delay: 0.36 });
  }

  /** Error / illegal move. */
  error() {
    this._ensureCtx();
    this._tone({ freq: 200, freqEnd: 140, duration: 0.12, type: 'sawtooth', gain: 0.15 });
  }

  /** Match found — bright two-tone chime. */
  matchFound() {
    this._ensureCtx();
    this._tone({ freq: 880, duration: 0.15, type: 'sine', gain: 0.28 });
    this._tone({ freq: 1320, duration: 0.22, type: 'sine', gain: 0.3, delay: 0.12 });
    this._tone({ freq: 1760, duration: 0.3, type: 'sine', gain: 0.25, delay: 0.24 });
  }

  /** Incoming chat / notification. */
  notify() {
    this._ensureCtx();
    this._tone({ freq: 720, duration: 0.08, type: 'sine', gain: 0.18 });
    this._tone({ freq: 960, duration: 0.1, type: 'sine', gain: 0.18, delay: 0.06 });
  }

  /** Tick - clock low warning (called each second in last 10s). */
  tick() {
    this._ensureCtx();
    this._tone({ freq: 1000, duration: 0.04, type: 'sine', gain: 0.08 });
  }

  /**
   * Start the ambient "searching" loop while matchmaking is active.
   * Rhythmic low pulse + occasional high ping.
   */
  startSearch() {
    this._ensureCtx();
    this.stopSearch();
    if (!this.enabled || !this.ctx) return;
    let beat = 0;
    const tick = () => {
      if (!this.searchLoop) return;
      this._tone({ freq: 220, duration: 0.06, type: 'sine', gain: 0.12 });
      if (beat % 4 === 0) {
        this._tone({ freq: 660, duration: 0.1, type: 'sine', gain: 0.08, delay: 0.2 });
      }
      beat++;
    };
    this.searchLoop = setInterval(tick, 700);
    tick();
  }

  stopSearch() {
    if (this.searchLoop) {
      clearInterval(this.searchLoop);
      this.searchLoop = null;
    }
  }
}

export const sound = new SoundManager();

/**
 * Attach a click sound to every button/anchor via event delegation.
 * Call once during app boot.
 */
export function installClickSounds(root = document) {
  root.addEventListener('pointerdown', (e) => {
    const target = e.target.closest('button, .btn, a[data-link], .tc-card, .lb-tab');
    if (!target) return;
    if (target.classList.contains('no-sound')) return;
    // Small, subtle pop on any UI element
    sound.click();
  }, true);
}
