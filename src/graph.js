// Win-rate / score graph along the current line of play.
import { GRADES } from './coach.js';

const W = 600, H = 150, PAD = 6;

export function renderGraph(el, line, current, onPick) {
  const n = Math.max(line.length - 1, 12);
  const x = i => PAD + (i / n) * (W - 2 * PAD);
  const yWr = v => PAD + (1 - v) * (H - 2 * PAD);
  const yScore = s => PAD + (0.5 - Math.max(-30, Math.min(30, s)) / 60) * (H - 2 * PAD);
  let wr = '', sc = '', dots = '';
  let penWr = false, penSc = false;
  line.forEach((node, i) => {
    const an = node.analysis;
    if (!an) { penWr = penSc = false; return; }
    wr += `${penWr ? 'L' : 'M'}${x(i).toFixed(1)} ${yWr(an.blackWinrate).toFixed(1)} `;
    sc += `${penSc ? 'L' : 'M'}${x(i).toFixed(1)} ${yScore(an.score).toFixed(1)} `;
    penWr = penSc = true;
    const g = node.grade;
    if (g && (g.grade === 'mistake' || g.grade === 'blunder' || g.grade === 'inaccuracy')) {
      dots += `<circle cx="${x(i)}" cy="${yWr(an.blackWinrate)}" r="${g.grade === 'inaccuracy' ? 3.5 : 5.5}" fill="${GRADES[g.grade].color}" stroke="#fff" stroke-width="1.5"/>`;
    }
  });
  const ci = line.indexOf(current);
  el.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="graph-svg">
  <rect x="0" y="0" width="${W}" height="${H / 2}" class="g-black"/>
  <rect x="0" y="${H / 2}" width="${W}" height="${H / 2}" class="g-white"/>
  <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="g-mid"/>
  ${ci >= 0 ? `<line x1="${x(ci)}" x2="${x(ci)}" y1="0" y2="${H}" class="g-cur"/>` : ''}
  <path d="${sc}" class="g-score" vector-effect="non-scaling-stroke"/>
  <path d="${wr}" class="g-wr" vector-effect="non-scaling-stroke"/>
  ${dots}
</svg>`;
  el.onclick = e => {
    const r = el.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width * W - PAD) / (W - 2 * PAD) * n);
    const node = line[Math.max(0, Math.min(line.length - 1, i))];
    if (node) onPick(node);
  };
}
