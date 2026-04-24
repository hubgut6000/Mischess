import { PIECES } from './pieces.js';

const FILES = ['a','b','c','d','e','f','g','h'];
const RANKS = ['1','2','3','4','5','6','7','8'];

export class Board {
  /**
   * @param {HTMLElement} el - container element
   * @param {object} opts - { orientation, onMove, interactive }
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.orientation = opts.orientation || 'white';
    this.onMove = opts.onMove || (() => {});
    this.interactive = opts.interactive !== false;
    this.chess = new window.Chess();
    this.selected = null;
    this.legalTargets = [];
    this.lastMove = null;
    this.dragState = null;
    this.promotionPending = null;
    this.squareEls = {};
    this._build();
    this._bindEvents();
    this.render();
  }

  _build() {
    this.el.classList.add('chess-board');
    this.el.innerHTML = '';
    this._applyOrientation();

    const squares = [];
    for (let r = 7; r >= 0; r--) {
      for (let f = 0; f < 8; f++) {
        squares.push({ file: f, rank: r });
      }
    }
    for (const { file, rank } of squares) {
      const algebraic = FILES[file] + RANKS[rank];
      const sq = document.createElement('div');
      sq.className = 'square ' + ((file + rank) % 2 === 0 ? 'dark' : 'light');
      sq.dataset.square = algebraic;

      if (file === 0) {
        const rankLbl = document.createElement('span');
        rankLbl.className = 'square-coord rank';
        rankLbl.textContent = RANKS[rank];
        sq.appendChild(rankLbl);
      }
      if (rank === 0) {
        const fileLbl = document.createElement('span');
        fileLbl.className = 'square-coord file';
        fileLbl.textContent = FILES[file];
        sq.appendChild(fileLbl);
      }
      this.el.appendChild(sq);
      this.squareEls[algebraic] = sq;
    }
  }

  _applyOrientation() {
    if (this.orientation === 'black') this.el.classList.add('flipped');
    else this.el.classList.remove('flipped');
  }

  setOrientation(color) {
    this.orientation = color;
    this._applyOrientation();
  }

  setPosition(fen) {
    this.chess.load(fen);
    this.selected = null;
    this.legalTargets = [];
    this.render();
  }

  setLastMove(from, to) {
    this.lastMove = from && to ? { from, to } : null;
    this.render();
  }

  getFen() { return this.chess.fen(); }
  getTurn() { return this.chess.turn(); }

  render() {
    // Clear square state classes
    for (const sq of Object.values(this.squareEls)) {
      sq.classList.remove('highlighted', 'move-from', 'move-to', 'legal', 'capture', 'check');
      const piece = sq.querySelector('.piece');
      if (piece) piece.remove();
    }
    // Place pieces
    const board = this.chess.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = board[r][f];
        if (!p) continue;
        const sqName = FILES[f] + RANKS[7 - r];
        const sqEl = this.squareEls[sqName];
        const pieceEl = document.createElement('div');
        pieceEl.className = 'piece';
        pieceEl.dataset.square = sqName;
        pieceEl.dataset.color = p.color;
        pieceEl.dataset.type = p.type;
        const key = (p.color === 'w' ? 'w' : 'b') + p.type.toUpperCase();
        pieceEl.style.backgroundImage = `url("${PIECES[key]}")`;
        // Counter-rotate pieces when board is flipped
        if (this.orientation === 'black') {
          pieceEl.style.transform = 'rotate(180deg)';
        }
        sqEl.appendChild(pieceEl);
      }
    }
    // Last move
    if (this.lastMove) {
      if (this.squareEls[this.lastMove.from]) this.squareEls[this.lastMove.from].classList.add('move-from');
      if (this.squareEls[this.lastMove.to]) this.squareEls[this.lastMove.to].classList.add('move-to');
    }
    // Check
    if (this.chess.inCheck()) {
      const turn = this.chess.turn();
      // Find king
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const p = board[r][f];
          if (p && p.type === 'k' && p.color === turn) {
            this.squareEls[FILES[f] + RANKS[7 - r]].classList.add('check');
          }
        }
      }
    }
    // Selected + legal
    if (this.selected) {
      this.squareEls[this.selected]?.classList.add('highlighted');
      for (const t of this.legalTargets) {
        const el = this.squareEls[t.to];
        if (!el) continue;
        el.classList.add('legal');
        if (t.flags & 2 || t.flags & 8) el.classList.add('capture');
      }
    }
  }

  _bindEvents() {
    this.el.addEventListener('mousedown', this._onPointerDown.bind(this));
    this.el.addEventListener('touchstart', this._onPointerDown.bind(this), { passive: false });
    window.addEventListener('mousemove', this._onPointerMove.bind(this));
    window.addEventListener('touchmove', this._onPointerMove.bind(this), { passive: false });
    window.addEventListener('mouseup', this._onPointerUp.bind(this));
    window.addEventListener('touchend', this._onPointerUp.bind(this));
    this.el.addEventListener('contextmenu', e => e.preventDefault());
  }

  _pointerPos(ev) {
    const t = ev.touches ? ev.touches[0] : ev;
    return { x: t.clientX, y: t.clientY };
  }

  _squareFromPoint(x, y) {
    const rect = this.el.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    let relX = (x - rect.left) / rect.width;
    let relY = (y - rect.top) / rect.height;
    if (this.orientation === 'black') { relX = 1 - relX; relY = 1 - relY; }
    const file = Math.floor(relX * 8);
    const rank = 7 - Math.floor(relY * 8);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return FILES[file] + RANKS[rank];
  }

  _onPointerDown(ev) {
    if (!this.interactive) return;
    if (this.promotionPending) return;
    const pos = this._pointerPos(ev);
    const sqName = this._squareFromPoint(pos.x, pos.y);
    if (!sqName) return;
    const piece = this.chess.get(sqName);

    // If we have a selected piece and this square is a legal target
    if (this.selected && this.legalTargets.some(t => t.to === sqName)) {
      this._attemptMove(this.selected, sqName);
      return;
    }

    if (piece && piece.color === this.chess.turn() && this._canPlayColor(piece.color)) {
      this.selected = sqName;
      this.legalTargets = this.chess.moves({ square: sqName, verbose: true });
      this.render();

      // Begin drag
      const pieceEl = this.squareEls[sqName].querySelector('.piece');
      if (pieceEl) {
        this.dragState = {
          pieceEl,
          origin: sqName,
          width: this.el.getBoundingClientRect().width / 8,
        };
        pieceEl.classList.add('dragging');
        pieceEl.style.position = 'fixed';
        pieceEl.style.pointerEvents = 'none';
        pieceEl.style.width = `${this.dragState.width * 0.92}px`;
        pieceEl.style.height = `${this.dragState.width * 0.92}px`;
        pieceEl.style.zIndex = '1000';
        // Counter-rotate when board is flipped so piece appears right-side up
        pieceEl.style.transform = this.orientation === 'black' ? 'rotate(180deg)' : '';
        this._moveDragEl(pos.x, pos.y);
      }
      if (ev.cancelable) ev.preventDefault();
    } else {
      this.selected = null;
      this.legalTargets = [];
      this.render();
    }
  }

  _onPointerMove(ev) {
    if (!this.dragState) return;
    const pos = this._pointerPos(ev);
    this._moveDragEl(pos.x, pos.y);
    if (ev.cancelable && ev.touches) ev.preventDefault();
  }

  _moveDragEl(x, y) {
    if (!this.dragState) return;
    const w = this.dragState.width * 0.92;
    // Always use raw screen coordinates for the dragged piece — it's position:fixed
    // so it follows the actual cursor regardless of board orientation/CSS transform.
    this.dragState.pieceEl.style.left = (x - w / 2) + 'px';
    this.dragState.pieceEl.style.top = (y - w / 2) + 'px';
  }

  _onPointerUp(ev) {
    if (!this.dragState) return;
    const pos = ev.changedTouches ? { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY } : this._pointerPos(ev);
    const target = this._squareFromPoint(pos.x, pos.y);

    // Reset drag piece styles
    const pieceEl = this.dragState.pieceEl;
    pieceEl.classList.remove('dragging');
    pieceEl.style.position = '';
    pieceEl.style.left = '';
    pieceEl.style.top = '';
    pieceEl.style.pointerEvents = '';
    pieceEl.style.width = '';
    pieceEl.style.height = '';
    pieceEl.style.zIndex = '';
    pieceEl.style.transform = '';

    const origin = this.dragState.origin;
    this.dragState = null;

    if (target && target !== origin && this.legalTargets.some(t => t.to === target)) {
      this._attemptMove(origin, target);
    } else {
      this.render();
    }
  }

  _canPlayColor(color) {
    if (!this.interactive) return false;
    if (this.playerColor === null || this.playerColor === undefined) return true; // local game
    return (color === 'w' && this.playerColor === 'white') ||
           (color === 'b' && this.playerColor === 'black');
  }

  setPlayerColor(color) { this.playerColor = color; }
  setInteractive(b) { this.interactive = b; }

  _attemptMove(from, to) {
    // Check for promotion
    const piece = this.chess.get(from);
    const needsPromotion = piece && piece.type === 'p' &&
      ((piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1'));

    if (needsPromotion) {
      this._showPromotion(from, to, piece.color);
      return;
    }
    this._dispatchMove({ from, to });
  }

  _dispatchMove(moveObj) {
    const res = this.onMove(moveObj);
    if (res === false) {
      // Move rejected, revert
      this.selected = null;
      this.legalTargets = [];
      this.render();
    } else {
      this.selected = null;
      this.legalTargets = [];
      this.render();
    }
  }

  _showPromotion(from, to, color) {
    const existing = this.el.querySelector('.promo-picker');
    if (existing) existing.remove();

    const picker = document.createElement('div');
    picker.className = 'promo-picker';
    const pieces = ['q', 'r', 'b', 'n'];
    for (const p of pieces) {
      const opt = document.createElement('div');
      opt.className = 'promo-option';
      const key = (color === 'w' ? 'w' : 'b') + p.toUpperCase();
      opt.style.backgroundImage = `url("${PIECES[key]}")`;
      opt.onclick = () => {
        picker.remove();
        this.promotionPending = null;
        this._dispatchMove({ from, to, promotion: p });
      };
      picker.appendChild(opt);
    }
    // Position over target square
    const sqEl = this.squareEls[to];
    const rect = sqEl.getBoundingClientRect();
    const boardRect = this.el.getBoundingClientRect();
    picker.style.left = (rect.left - boardRect.left) + 'px';
    const aboveBoard = (color === 'w' && this.orientation === 'white') || (color === 'b' && this.orientation === 'black');
    if (aboveBoard) picker.style.top = (rect.top - boardRect.top) + 'px';
    else picker.style.top = (rect.top - boardRect.top - (rect.height * 3)) + 'px';
    this.el.appendChild(picker);
    this.promotionPending = { from, to };
  }
}
