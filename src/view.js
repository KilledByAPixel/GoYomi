// SVG board renderer. Stateless apart from animation bookkeeping: render(s)
// redraws every layer from a plain description of what to show.
import { BLACK, WHITE, EMPTY, PASS, POINTS, N, pt, ptX, ptY } from './board.js';

const CELL = 100, M = 72, S = M * 2 + CELL * (N - 1);
const X = p => M + ptX(p) * CELL, Y = p => M + ptY(p) * CELL;
const COLS = 'ABCDEFGHJ';
const R = 47.5;
const RED = '#e03131', ORANGE = '#f08c00', GREEN = '#2f9e61';

function woodGrain() {
  let s = 11;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let g = '';
  for (let i = 0; i < 34; i++) {
    const y = r() * S, amp = 5 + r() * 18, w = 1 + r() * 4;
    g += `<path d="M-10 ${y.toFixed(0)} C ${(S * 0.3).toFixed(0)} ${(y + amp).toFixed(0)}, ${(S * 0.65).toFixed(0)} ${(y - amp).toFixed(0)}, ${S + 10} ${(y + amp * 0.4).toFixed(0)}" stroke="#6b3f0f" stroke-opacity="${(0.03 + r() * 0.08).toFixed(3)}" stroke-width="${w.toFixed(1)}" fill="none"/>`;
  }
  return g;
}

const ink = c => c === BLACK ? '#f5f3ee' : '#1c1a17';

export class BoardView {
  constructor(el, { onClick, onHover }) {
    this.el = el;
    let grid = '';
    for (let i = 0; i < N; i++) {
      const a = M + i * CELL;
      grid += `<line x1="${M}" y1="${a}" x2="${S - M}" y2="${a}"/><line x1="${a}" y1="${M}" x2="${a}" y2="${S - M}"/>`;
    }
    const stars = [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]]
      .map(([x, y]) => `<circle cx="${M + x * CELL}" cy="${M + y * CELL}" r="9"/>`).join('');
    let coords = '';
    for (let i = 0; i < N; i++) {
      const a = M + i * CELL;
      coords += `<text x="${a}" y="${M * 0.4}">${COLS[i]}</text><text x="${a}" y="${S - M * 0.4}">${COLS[i]}</text>`;
      coords += `<text x="${M * 0.4}" y="${a}">${N - i}</text><text x="${S - M * 0.4}" y="${a}">${N - i}</text>`;
    }
    el.innerHTML = `
<svg class="board-svg" viewBox="0 0 ${S} ${S}" role="img" aria-label="Go board">
  <defs>
    <linearGradient id="gWood" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e8c178"/><stop offset="0.5" stop-color="#dcb066"/><stop offset="1" stop-color="#cf9f55"/>
    </linearGradient>
    <radialGradient id="gB" cx="36%" cy="32%" r="72%">
      <stop offset="0" stop-color="#6e6e6e"/><stop offset="0.3" stop-color="#2c2c2c"/><stop offset="1" stop-color="#060606"/>
    </radialGradient>
    <radialGradient id="gW" cx="36%" cy="32%" r="78%">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#eeede8"/><stop offset="1" stop-color="#bdb9ae"/>
    </radialGradient>
    <filter id="fShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="3" dy="5" stdDeviation="3.5" flood-color="#2b1a05" flood-opacity="0.4"/>
    </filter>
  </defs>
  <rect width="${S}" height="${S}" rx="16" fill="url(#gWood)"/>
  <g>${woodGrain()}</g>
  <g stroke="#3a2710" stroke-width="3" stroke-linecap="square">${grid}</g>
  <rect x="${M}" y="${M}" width="${S - 2 * M}" height="${S - 2 * M}" fill="none" stroke="#3a2710" stroke-width="5"/>
  <g fill="#3a2710">${stars}</g>
  <g class="coords" fill="#5e4220" font-size="30" text-anchor="middle" dominant-baseline="central">${coords}</g>
  <g class="l-terr"></g>
  <g class="l-stones" filter="url(#fShadow)"></g>
  <g class="l-marks"></g>
  <g class="l-hints"></g>
  <g class="l-hover" pointer-events="none"></g>
</svg>`;
    this.svg = el.querySelector('svg');
    this.layers = {
      terr: el.querySelector('.l-terr'), stones: el.querySelector('.l-stones'), marks: el.querySelector('.l-marks'),
      hints: el.querySelector('.l-hints'), hover: el.querySelector('.l-hover'),
    };
    this.animId = null;
    this.hoverPt = null;
    const pointAt = e => {
      const r = this.svg.getBoundingClientRect();
      const gx = ((e.clientX - r.left) / r.width * S - M) / CELL;
      const gy = ((e.clientY - r.top) / r.height * S - M) / CELL;
      const x = Math.round(gx), y = Math.round(gy);
      if (x < 0 || y < 0 || x >= N || y >= N) return null;
      if (Math.hypot(gx - x, gy - y) > 0.55) return null;
      return pt(x, y);
    };
    this.svg.addEventListener('pointermove', e => {
      const p = pointAt(e);
      if (p !== this.hoverPt) { this.hoverPt = p; onHover(p); }
    });
    this.svg.addEventListener('pointerleave', () => { this.hoverPt = null; onHover(null); });
    this.svg.addEventListener('click', e => { const p = pointAt(e); if (p !== null) onClick(p); });
  }

  render(s) {
    const b = s.board;
    const animate = s.nodeId !== this.animId;
    this.animId = s.nodeId;

    // ---- territory / ownership
    let terr = '';
    if (s.ownership) {
      POINTS.forEach((p, i) => {
        const v = s.ownership[i], a = Math.min(1, Math.abs(v));
        if (a < 0.2) return;
        const size = CELL * (0.5 + 0.44 * a);
        terr += `<rect x="${X(p) - size / 2}" y="${Y(p) - size / 2}" width="${size}" height="${size}" rx="8" fill="${v > 0 ? '#000' : '#fff'}" fill-opacity="${(a * (v > 0 ? 0.38 : 0.62)).toFixed(2)}"/>`;
      });
    }
    this.layers.terr.innerHTML = terr;

    // ---- stones
    let stones = '';
    for (const p of POINTS) {
      const c = b.color[p];
      if (c !== BLACK && c !== WHITE) continue;
      const cls = ['stone'];
      if (animate && p === s.lastMove) cls.push('fresh');
      if (s.dead && s.dead.has(p)) cls.push('dead');
      stones += `<circle class="${cls.join(' ')}" cx="${X(p)}" cy="${Y(p)}" r="${R}" fill="url(#${c === BLACK ? 'gB' : 'gW'})"/>`;
    }
    if (animate && s.captured) {
      for (const p of s.captured) {
        stones += `<circle class="stone vanish" cx="${X(p)}" cy="${Y(p)}" r="${R}" fill="url(#${s.capturedColor === BLACK ? 'gB' : 'gW'})"/>`;
      }
    }
    this.layers.stones.innerHTML = stones;

    // ---- marks
    let marks = '';
    const libMap = new Map();
    if (s.liberties) {
      for (const p of POINTS) {
        const c = b.color[p];
        if (c !== BLACK && c !== WHITE) continue;
        const h = b.head[p];
        if (!libMap.has(h)) libMap.set(h, b.libCount(p));
      }
    }
    if (s.ownership && !s.dead) {
      // Stones the coach thinks are dead get a small square of the owner's colour.
      POINTS.forEach((p, i) => {
        const c = b.color[p], v = s.ownership[i];
        if ((c === BLACK && v < -0.4) || (c === WHITE && v > 0.4)) {
          marks += `<rect x="${X(p) - 17}" y="${Y(p) - 17}" width="34" height="34" fill="${c === BLACK ? '#fff' : '#000'}" stroke="${c === BLACK ? '#000' : '#fff'}" stroke-width="3" opacity="0.85"/>`;
        }
      });
    }
    if (s.scoreOwner) {
      for (const p of POINTS) {
        const o = s.scoreOwner[p];
        if (!o || (b.color[p] !== EMPTY && !s.dead.has(p))) continue;
        marks += `<rect x="${X(p) - 19}" y="${Y(p) - 19}" width="38" height="38" fill="${o === BLACK ? '#111' : '#fafafa'}" stroke="${o === BLACK ? '#fafafa' : '#111'}" stroke-width="3"/>`;
      }
    }
    if (s.threats) {
      for (const t of s.threats) {
        for (const p of t.stones) marks += `<circle class="pulse" cx="${X(p)}" cy="${Y(p)}" r="${R + 1}" fill="none" stroke="${RED}" stroke-width="7" stroke-dasharray="18 10"/>`;
        for (const l of t.libs) marks += `<circle cx="${X(l)}" cy="${Y(l)}" r="20" fill="none" stroke="${RED}" stroke-width="6"/><circle cx="${X(l)}" cy="${Y(l)}" r="6" fill="${RED}"/>`;
      }
    }
    for (const p of POINTS) {
      const c = b.color[p];
      if (c !== BLACK && c !== WHITE) continue;
      const num = s.numbers && s.numbers.get(p);
      if (num) {
        const fill = p === s.lastMove ? RED : ink(c);
        marks += `<text x="${X(p)}" y="${Y(p) + 2}" class="stone-num" fill="${fill}" font-size="${num >= 100 ? 32 : 40}">${num}</text>`;
      } else if (s.liberties) {
        const n = libMap.get(b.head[p]);
        const fill = n === 1 ? RED : n === 2 ? ORANGE : ink(c);
        const op = n <= 2 ? 1 : 0.6;
        marks += `<text x="${X(p)}" y="${Y(p) + 2}" class="stone-num" fill="${fill}" fill-opacity="${op}" font-size="${n <= 2 ? 44 : 36}">${n}</text>`;
      }
      if (p === s.lastMove && !num) {
        marks += `<circle cx="${X(p)}" cy="${Y(p)}" r="${s.liberties ? R - 7 : 17}" fill="none" stroke="${s.liberties ? RED : ink(c)}" stroke-width="${s.liberties ? 5 : 6}"/>`;
      }
    }
    if (s.better) {
      const p = s.better;
      marks += `<circle cx="${X(p)}" cy="${Y(p)}" r="44" fill="${GREEN}" fill-opacity="0.18" stroke="${GREEN}" stroke-width="9"/>`;
    }
    if (s.grade && s.lastMove !== PASS && s.lastMove != null) {
      const p = s.lastMove;
      marks += `<circle cx="${X(p)}" cy="${Y(p)}" r="${R + 5}" fill="none" stroke="${s.grade}" stroke-width="7"/>`;
    }
    this.layers.marks.innerHTML = marks;

    // ---- hints and expected continuations
    let hints = '';
    if (s.hints) {
      for (const h of s.hints) {
        if (h.move === PASS) continue;
        hints += `<g class="hint"><circle cx="${X(h.move)}" cy="${Y(h.move)}" r="42" fill="${h.color}" fill-opacity="0.9" stroke="${h.rank === 0 ? '#fff6cc' : '#fff'}" stroke-width="${h.rank === 0 ? 8 : 3}"/>` +
          `<text x="${X(h.move)}" y="${Y(h.move) - 6}" class="hint-main">${h.label}</text>` +
          `<text x="${X(h.move)}" y="${Y(h.move) + 22}" class="hint-sub">${h.sub}</text></g>`;
      }
    }
    if (s.threat) {
      hints += `<circle cx="${X(s.threat)}" cy="${Y(s.threat)}" r="${R + 4}" fill="none" stroke="${RED}" stroke-width="9" stroke-dasharray="16 9"/>`;
    }
    if (s.pv) {
      const shown = new Set();
      s.pv.forEach((mv, i) => {
        // Later moves can land where a stone was captured along the way; keep the first.
        if (mv.move === PASS || b.color[mv.move] !== EMPTY || shown.has(mv.move)) return;
        shown.add(mv.move);
        hints += `<circle cx="${X(mv.move)}" cy="${Y(mv.move)}" r="${R}" fill="url(#${mv.color === BLACK ? 'gB' : 'gW'})" opacity="0.72"/>` +
          `<text x="${X(mv.move)}" y="${Y(mv.move) + 2}" class="stone-num" fill="${i === 0 ? (s.pvAccent || GREEN) : ink(mv.color)}" font-size="42">${i + 1}</text>`;
      });
    }
    this.layers.hints.innerHTML = hints;

    // ---- hover preview
    let hov = '';
    const h = s.hover;
    if (h) {
      const x = X(h.p), y = Y(h.p);
      if (!h.ok) {
        hov += `<circle cx="${x}" cy="${y}" r="${R}" fill="url(#${h.color === BLACK ? 'gB' : 'gW'})" opacity="0.25"/>` +
          `<path d="M${x - 24} ${y - 24} L${x + 24} ${y + 24} M${x + 24} ${y - 24} L${x - 24} ${y + 24}" stroke="${RED}" stroke-width="10" stroke-linecap="round"/>`;
      } else {
        hov += `<circle cx="${x}" cy="${y}" r="${R}" fill="url(#${h.color === BLACK ? 'gB' : 'gW'})" opacity="0.55"/>`;
        if (h.detail) {
          for (const q of h.captures) {
            hov += `<path d="M${X(q) - 22} ${Y(q) - 22} L${X(q) + 22} ${Y(q) + 22} M${X(q) + 22} ${Y(q) - 22} L${X(q) - 22} ${Y(q) + 22}" stroke="${RED}" stroke-width="9" stroke-linecap="round"/>`;
          }
          for (const q of h.ataris) hov += `<circle cx="${X(q)}" cy="${Y(q)}" r="${R + 1}" fill="none" stroke="${ORANGE}" stroke-width="7" stroke-dasharray="14 8"/>`;
          const fill = h.libs === 1 ? RED : h.libs === 2 ? ORANGE : ink(h.color);
          hov += `<text x="${x}" y="${y + 2}" class="stone-num" fill="${fill}" font-size="40">${h.libs}</text>`;
        }
      }
    }
    this.layers.hover.innerHTML = hov;
  }
}
