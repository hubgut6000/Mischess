import { getPieceSet } from './pieces.js';

const FILES = ['a','b','c','d','e','f','g','h'];
const RANKS = ['1','2','3','4','5','6','7','8'];

export class Board {
  constructor(el, opts = {}) {
    this.el = el;
    this.orientation = opts.orientation || 'white';
    this.pieceSet = opts.pieceSet || 'classic';
    this.pieces = getPieceSet(this.pieceSet);
    this.onMove = opts.onMove || (() => {});
    this.interactive = opts.interactive !== false;
    this.moveDuration = opts.moveDuration ?? 580;
    this.chess = new window.Chess();
    this.selected = null;
    this.legalTargets = [];
    this.lastMove = null;
    this.dragState = null;
    this.promotionPending = null;
    this.squareEls = {};
    this.animating = false;
    this._build();
    this._bindEvents();
    this.render();
  }

  _build() {
    this.el.classList.add('chess-board');
    this.el.innerHTML = '';
    this.squareEls = {};

    const ranks = this.orientation === 'white' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
    const files = this.orientation === 'white' ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];

    for (const r of ranks) {
      for (const f of files) {
        const algebraic = FILES[f] + RANKS[r];
        const sq = document.createElement('div');
        sq.className = 'square ' + ((f + r) % 2 === 0 ? 'dark' : 'light');
        sq.dataset.square = algebraic;

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

  setPieceSet(name) {
    this.pieceSet = name || 'classic';
    this.pieces = getPieceSet(this.pieceSet);
    this.render();
  }

  setPosition(fen, opts = {}) {
    const prevFen = this.chess.fen();
    const instant = opts.instant === true;
    const animate = opts.animate !== false && !instant && prevFen && prevFen !== fen;

    if (animate) {
      const move = this._detectMove(prevFen, fen);
      if (move) {
        this._playMoveAnimation(move, fen);
        return;
      }
    }

    this.chess.load(fen);
    this.selected = null;
    this.legalTargets = [];
    this.render();
  }

  _detectMove(fromFen, toFen) {
    try {
      const probe = new window.Chess(fromFen);
      for (const m of probe.moves({ verbose: true })) {
        const trial = new window.Chess(fromFen);
        trial.move(m);
        if (trial.fen() === toFen) return m;
      }
    } catch {}
    return null;
  }

  _playMoveAnimation(move, targetFen) {
    if (this.animating) {
      this.chess.load(targetFen);
      this.render();
      return;
    }

    const { from, to, captured, flags } = move;
    const isCastle = flags.includes('k') || flags.includes('q');
    const castleRook = isCastle ? this._castleRookSquares(from, to, flags) : null;

    const fromEl = this.squareEls[from];
    const pieceEl = fromEl?.querySelector('.piece');
    if (!pieceEl) {
      this.chess.load(targetFen);
      this.render();
      return;
    }

    this.animating = true;
    this.el.classList.add('board-animating');

    const duration = this.moveDuration;
    const easing = 'cubic-bezier(0.25, 0.85, 0.35, 1)';

    const capEl = captured ? this.squareEls[to]?.querySelector('.piece') : null;
    if (capEl && capEl !== pieceEl) {
      capEl.classList.add('piece-capture');
    }

    const slides = [{ el: pieceEl, from, to }];

    if (castleRook) {
      const rookEl = this.squareEls[castleRook.from]?.querySelector('.piece');
      if (rookEl) slides.push({ el: rookEl, from: castleRook.from, to: castleRook.to });
    }

    let done = 0;
    const onSlideEnd = () => {
      done++;
      if (done < slides.length) return;
      this.animating = false;
      this.el.classList.remove('board-animating');
      this.chess.load(targetFen);
      this.render();
      this._animateLastMove();
    };

    for (const { el, from: f, to: t } of slides) {
      this._slidePiece(el, f, t, duration, easing, onSlideEnd);
    }
  }

  _castleRookSquares(kingFrom, _kingTo, flags) {
    const rank = kingFrom[1];
    if (flags.includes('k')) return { from: 'h' + rank, to: 'f' + rank };
    if (flags.includes('q')) return { from: 'a' + rank, to: 'd' + rank };
    return null;
  }

  _slidePiece(pieceEl, from, to, duration, easing, onDone) {
    const fromRect = this.squareEls[from].getBoundingClientRect();
    const toRect = this.squareEls[to].getBoundingClientRect();
    const dx = toRect.left - fromRect.left;
    const dy = toRect.top - fromRect.top;

    pieceEl.classList.add('piece-sliding');
    pieceEl.style.transition = `transform ${duration}ms ${easing}`;
    pieceEl.style.zIndex = '50';
    pieceEl.style.willChange = 'transform';

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pieceEl.style.transform = `translate(${dx}px, ${dy}px)`;
      });
    });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pieceEl.removeEventListener('transitionend', finish);
      pieceEl.classList.remove('piece-sliding');
      pieceEl.style.transition = '';
      pieceEl.style.transform = '';
      pieceEl.style.zIndex = '';
      pieceEl.style.willChange = '';
      onDone();
    };
    pieceEl.addEventListener('transitionend', finish);
    setTimeout(finish, duration + 100);
  }

  setLastMove(from, to, opts = {}) {
    this.lastMove = from && to ? { from, to, captured: !!opts.captured } : null;
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
        pieceEl.style.backgroundImage = `url("${this.pieces[key]}")`;
        sqEl.appendChild(pieceEl);
      }
    }
    this._refreshHighlights();
    if (!this.animating) this._animateLastMove();
  }

  _animateLastMove() {
    if (!this.lastMove?.to || this.animating) return;
    const sq = this.squareEls[this.lastMove.to];
    if (!sq) return;
    const piece = sq.querySelector('.piece');
    if (!piece) return;
    piece.classList.remove('piece-arrive');
    void piece.offsetWidth;
    piece.classList.add('piece-arrive');
    piece.addEventListener('animationend', () => piece.classList.remove('piece-arrive'), { once: true });
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
    for (const [name, el] of Object.entries(this.squareEls)) {
      const rect = el.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return name;
      }
    }
    return null;
  }

  _onPointerDown(ev) {
    if (!this.interactive || this.animating) return;
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
    const result = this.onMove(moveObj);
    this.selected = null;
    this.legalTargets = [];
    if (result === false) this.render();
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
      opt.style.backgroundImage = `url("${this.pieces[key]}")`;
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
    const isTopRow = (this.orientation === 'white' && color === 'w') ||
                     (this.orientation === 'black' && color === 'b');
    if (isTopRow) picker.style.top = (rect.top - boardRect.top) + 'px';
    else picker.style.top = (rect.top - boardRect.top - rect.height * 3) + 'px';
    this.el.appendChild(picker);
    this.promotionPending = { from, to };
  }
}
