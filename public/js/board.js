import { PIECES } from './pieces.js';

const FILES = ['a','b','c','d','e','f','g','h'];
const RANKS = ['1','2','3','4','5','6','7','8'];

export class Board {
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
    this.animatingPieces = new Set();
    this.previousBoard = null;
    this._build();
    this._bindEvents();
    this.render();
  }

  _build() {
    this.el.classList.add('chess-board');
    this.el.innerHTML = '';
    this.squareEls = {};

    // Build squares in correct order for orientation.
    // White at bottom: iterate ranks 8->1, files a->h (reading order from white's view)
    // Black at bottom: iterate ranks 1->8, files h->a
    const ranks = this.orientation === 'white' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
    const files = this.orientation === 'white' ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];

    for (const r of ranks) {
      for (const f of files) {
        const algebraic = FILES[f] + RANKS[r];
        const sq = document.createElement('div');
        sq.className = 'square ' + ((f + r) % 2 === 0 ? 'dark' : 'light');
        sq.dataset.square = algebraic;

        // Coordinate labels - show on appropriate edge based on orientation
        const showFile = (this.orientation === 'white' ? r === 0 : r === 7);
        const showRank = (this.orientation === 'white' ? f === 0 : f === 7);
        if (showRank) {
          const rankLbl = document.createElement('span');
          rankLbl.className = 'square-coord rank';
          rankLbl.textContent = RANKS[r];
          sq.appendChild(rankLbl);
        }
        if (showFile) {
          const fileLbl = document.createElement('span');
          fileLbl.className = 'square-coord file';
          fileLbl.textContent = FILES[f];
          sq.appendChild(fileLbl);
        }
        this.el.appendChild(sq);
        this.squareEls[algebraic] = sq;
      }
    }
  }

  setOrientation(color) {
    this.orientation = color;
    this._build();
    this.render();
  }

  setPosition(fen) {
    const prevFen = this.chess.fen();
    this.chess.load(fen);
    this.selected = null;
    this.legalTargets = [];
    // Animate if this is a direct follow-up position
    if (prevFen && prevFen !== fen) {
      this._animateTransition(prevFen, fen);
    } else {
      this.render();
    }
  }

  _animateTransition(prevFen, newFen) {
    // Simple approach: render new position, then piece CSS transitions handle the rest.
    // For proper animation we'd need to track moved pieces. Keep it simple for now.
    this.render();
  }

  setLastMove(from, to) {
    this.lastMove = from && to ? { from, to } : null;
    this._refreshHighlights();
  }

  getFen() { return this.chess.fen(); }
  getTurn() { return this.chess.turn(); }

  _refreshHighlights() {
    for (const sq of Object.values(this.squareEls)) {
      sq.classList.remove('highlighted', 'move-from', 'move-to', 'legal', 'capture', 'check');
    }
    if (this.lastMove) {
      if (this.squareEls[this.lastMove.from]) this.squareEls[this.lastMove.from].classList.add('move-from');
      if (this.squareEls[this.lastMove.to]) this.squareEls[this.lastMove.to].classList.add('move-to');
    }
    if (this.chess.inCheck()) {
      const turn = this.chess.turn();
      const board = this.chess.board();
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const p = board[r][f];
          if (p && p.type === 'k' && p.color === turn) {
            this.squareEls[FILES[f] + RANKS[7 - r]].classList.add('check');
          }
        }
      }
    }
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

  render() {
    // Clear pieces
    for (const sq of Object.values(this.squareEls)) {
      const p = sq.querySelector('.piece');
      if (p) p.remove();
    }
    const board = this.chess.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = board[r][f];
        if (!p) continue;
        const sqName = FILES[f] + RANKS[7 - r];
        const sqEl = this.squareEls[sqName];
        if (!sqEl) continue;
        const pieceEl = document.createElement('div');
        pieceEl.className = 'piece';
        pieceEl.dataset.square = sqName;
        pieceEl.dataset.color = p.color;
        pieceEl.dataset.type = p.type;
        const key = (p.color === 'w' ? 'w' : 'b') + p.type.toUpperCase();
        pieceEl.style.backgroundImage = `url("${PIECES[key]}")`;
        sqEl.appendChild(pieceEl);
      }
    }
    this._refreshHighlights();
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
    const t = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
    return { x: t.clientX, y: t.clientY };
  }

  _squareFromPoint(x, y) {
    // Now that board is ordered correctly in DOM, we can use hit-testing directly.
    // Find which square element contains the point.
    for (const [name, el] of Object.entries(this.squareEls)) {
      const rect = el.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return name;
      }
    }
    return null;
  }

  _onPointerDown(ev) {
    if (!this.interactive) return;
    if (this.promotionPending) return;
    const pos = this._pointerPos(ev);
    const sqName = this._squareFromPoint(pos.x, pos.y);
    if (!sqName) return;
    const piece = this.chess.get(sqName);

    if (this.selected && this.legalTargets.some(t => t.to === sqName)) {
      this._attemptMove(this.selected, sqName);
      return;
    }

    if (piece && piece.color === this.chess.turn() && this._canPlayColor(piece.color)) {
      this.selected = sqName;
      this.legalTargets = this.chess.moves({ square: sqName, verbose: true });
      this._refreshHighlights();

      const pieceEl = this.squareEls[sqName].querySelector('.piece');
      if (pieceEl) {
        const squareRect = this.squareEls[sqName].getBoundingClientRect();
        this.dragState = {
          pieceEl,
          origin: sqName,
          width: squareRect.width,
        };
        pieceEl.classList.add('dragging');
        pieceEl.style.position = 'fixed';
        pieceEl.style.pointerEvents = 'none';
        pieceEl.style.width = `${squareRect.width * 0.95}px`;
        pieceEl.style.height = `${squareRect.height * 0.95}px`;
        pieceEl.style.zIndex = '1000';
        pieceEl.style.transition = 'none';
        this._moveDragEl(pos.x, pos.y);
      }
      if (ev.cancelable) ev.preventDefault();
    } else {
      this.selected = null;
      this.legalTargets = [];
      this._refreshHighlights();
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
    const w = this.dragState.width * 0.95;
    this.dragState.pieceEl.style.left = (x - w / 2) + 'px';
    this.dragState.pieceEl.style.top = (y - w / 2) + 'px';
  }

  _onPointerUp(ev) {
    if (!this.dragState) return;
    const pos = ev.changedTouches && ev.changedTouches[0]
      ? { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY }
      : this._pointerPos(ev);
    const target = this._squareFromPoint(pos.x, pos.y);

    const pieceEl = this.dragState.pieceEl;
    pieceEl.classList.remove('dragging');
    pieceEl.style.position = '';
    pieceEl.style.left = '';
    pieceEl.style.top = '';
    pieceEl.style.pointerEvents = '';
    pieceEl.style.width = '';
    pieceEl.style.height = '';
    pieceEl.style.zIndex = '';
    pieceEl.style.transition = '';
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
    if (this.playerColor === null || this.playerColor === undefined) return true;
    return (color === 'w' && this.playerColor === 'white') ||
           (color === 'b' && this.playerColor === 'black');
  }

  setPlayerColor(color) {
    this.playerColor = color;
    // If orientation doesn't match player color, flip the board
    if (color && this.orientation !== color) {
      this.setOrientation(color);
    }
  }
  setInteractive(b) { this.interactive = b; }

  _attemptMove(from, to) {
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
    this.onMove(moveObj);
    this.selected = null;
    this.legalTargets = [];
    this.render();
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
    const sqEl = this.squareEls[to];
    const rect = sqEl.getBoundingClientRect();
    const boardRect = this.el.getBoundingClientRect();
    picker.style.left = (rect.left - boardRect.left) + 'px';
    // Show below if promoting bottom pawn, above if top
    const isTopRow = (this.orientation === 'white' && color === 'w') ||
                     (this.orientation === 'black' && color === 'b');
    if (isTopRow) picker.style.top = (rect.top - boardRect.top) + 'px';
    else picker.style.top = (rect.top - boardRect.top - rect.height * 3) + 'px';
    this.el.appendChild(picker);
    this.promotionPending = { from, to };
  }
}
