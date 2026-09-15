// Go Dojo controller: wires the game record, the opponent engine, the coach
// engine and the board view together.
import { BLACK, WHITE, EMPTY, PASS, POINTS, ptName } from './board.js';
import { Game, reasonText, colorName } from './game.js';
import { Engine } from './engine-client.js';
import { LEVELS, chooseMove, shouldPass, estimateDead, gradeMove, GRADES, explainMove, threats, describeScore } from './coach.js';
import { BoardView } from './view.js';
import { renderGraph } from './graph.js';
import { stoneSound } from './sound.js';

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STORE = 'goDojo.v1';

const TOGGLES = [
  ['liberties', 'Liberties', 'Number of liberties (empty neighbours) of each group. 1 means atari.', 'L'],
  ['atari', 'Atari alerts', 'Red rings on groups in atari, and a target on the point that captures or saves them.', 'A'],
  ['territory', 'Territory', 'Who the coach expects to own each point. A small square on a stone means it is probably dead.', 'T'],
  ['preview', 'Move preview', 'Hover a point: ✕ marks stones you would capture, orange rings show new ataris, the number is your stone\'s liberties.', 'V'],
  ['feedback', 'Grade moves', 'After every move the coach says how good it was and what it would have played.', 'G'],
  ['hints', 'Best moves', 'Always show the coach\'s favourite moves with win % and point lead. Press H for a one-off hint instead.', 'B'],
  ['numbers', 'Move numbers', 'Show the order the stones were played in.', 'N'],
];

const DEFAULTS = {
  human: BLACK,              // BLACK or WHITE vs the AI; 0 = study mode (you play both)
  level: 1,
  komi: 7,
  handicap: 0,
  coach: true,
  coachPlayouts: 16000,
  sound: true,
  show: { liberties: true, atari: true, territory: false, preview: true, feedback: true, hints: false, numbers: false },
};

let settings = structuredClone(DEFAULTS);
let game = null;
let mode = 'play';           // 'play' | 'score'
let scoring = null;          // { node, dead: Set, pending }
let resigned = 0;            // colour that resigned
let hoverPt = null;
let hintOn = false;
let better = null;           // { node, move, pv } — coach move shown on node's board
let flashMsg = null, flashTimer = 0;
let aiNode = null, aiToken = 0;
let coachNode = null;

const opponent = new Engine('opponent');
const coach = new Engine('coach');
const view = new BoardView($('#board'), { onClick, onHover });

// ------------------------------------------------------------------ helpers

const aiColor = () => settings.human ? 3 - settings.human : 0;
const level = () => LEVELS[settings.level];
const aiLabel = () => `AI (${level().name})`;
const who = c => !settings.human ? colorName(c) : c === settings.human ? 'You' : 'AI';
const whose = c => !settings.human ? colorName(c) : c === settings.human ? 'Your' : 'AI\'s';
const fmtK = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function isAITurn(node = game.current) {
  const ai = aiColor();
  return mode === 'play' && !resigned && ai && node.board.toPlay === ai && !game.isOver(node) && node.children.length === 0;
}

function flash(text, kind = '') {
  flashMsg = { text, kind };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashMsg = null; renderStatus(); }, 5000);
  renderStatus();
}

function pvStones(color, moves) {
  return moves.map((move, i) => ({ move, color: i % 2 ? 3 - color : color }));
}

// ------------------------------------------------------------------ game flow

function newGame() {
  cancelAI();
  game = new Game({ komi: settings.komi, handicap: settings.handicap });
  mode = 'play'; scoring = null; resigned = 0; better = null; hintOn = false;
  flashMsg = null;
  afterChange();
}

function afterChange() {
  if (aiNode && game.current !== aiNode) cancelAI();
  save();
  render();
  scheduleCoach();
  aiMove();
}

function playMove(move) {
  const parent = game.current;
  const r = game.check(move);
  if (!r.ok) { flash(reasonText(r.reason), 'bad'); return false; }
  const node = game.play(move);
  if (!node.explain) node.explain = explainMove(parent.board, node.board, move);
  hintOn = false; better = null;
  if (settings.sound && move !== PASS) stoneSound(node.captured.length);
  tryGrade(node);
  if (game.isOver()) { save(); enterScoring(); return true; }
  afterChange();
  return true;
}

function onClick(p) {
  if (mode === 'score') { toggleDead(p); return; }
  if (aiNode) { flash('Hold on, the AI is thinking…'); return; }
  const node = game.current;
  if (game.isOver(node)) { flash('Both players passed. The game is over.'); return; }
  const ai = aiColor();
  if (ai && !resigned && node.board.toPlay === ai) {
    flash('It\'s the AI\'s turn in this position. Press "AI move" to let it play, or step back.');
    return;
  }
  playMove(p);
}

function onHover(p) {
  hoverPt = p;
  renderBoard();
  renderStatus();
}

function humanPass() {
  if (mode !== 'play' || aiNode || game.isOver()) return;
  if (aiColor() && !resigned && game.toPlay === aiColor()) return;
  flash(`${who(game.toPlay)} passed.`);
  playMove(PASS);
}

function takeBack() {
  if (mode === 'score') exitScoring();
  cancelAI();
  better = null; hintOn = false;
  if (!game.current.parent) return;
  game.undo();
  const ai = aiColor();
  if (ai && !resigned) while (game.current.parent && game.toPlay === ai) game.undo();
  render();
  save();
  scheduleCoach();
  // Back at the very start with the AI to move (you play White): let it move again.
  if (ai && !game.current.parent && game.toPlay === ai) aiMove(true);
}

function resignOrScore() {
  if (mode === 'score') return;
  if (game.isOver()) { enterScoring(); return; }
  if (!settings.human) { flash('In study mode there is no opponent to resign to.'); return; }
  if (resigned) return;
  cancelAI();
  resigned = settings.human;
  flash('You resigned. No shame in that — step back through the game to see where it turned.');
  afterChange();
}

// ------------------------------------------------------------------ AI opponent

function cancelAI() {
  aiToken++;
  if (aiNode) { opponent.cancel(); aiNode = null; }
}

async function aiMove(force = false) {
  const node = game.current;
  if (aiNode || mode !== 'play' || game.isOver(node)) return;
  if (!force && !isAITurn(node)) return;
  const token = ++aiToken;
  const color = node.board.toPlay;
  const lv = level();
  aiNode = node;
  render();
  const t0 = performance.now();
  let results = await opponent.search(game.recipe(node), { playouts: lv.playouts, maxTime: 15000, reportMs: 0 });
  if (token !== aiToken) return;
  // When the human has passed, decide about passing with a deeper look.
  let passInfo = results;
  if (results && node.board.lastMove === PASS && node.parent) {
    if (node.analysisDone && node.analysis.playouts > results.playouts) passInfo = node.analysis;
    else if (results.playouts < 4000) passInfo = await opponent.search(game.recipe(node), { playouts: 4000, reportMs: 0 });
    if (token !== aiToken) return;
  }
  const wait = 450 - (performance.now() - t0);
  if (wait > 0) await sleep(wait);
  if (token !== aiToken) return;
  aiNode = null;
  if (!results || !passInfo || game.current !== node) { render(); return; }
  if (!node.analysis && results.playouts >= 1500) node.analysis = results;
  let move = shouldPass(game, passInfo, color) ? PASS : chooseMove(results, lv);
  if (move !== PASS && !game.check(move).ok) {
    move = (results.allMoves || results.moves).map(m => m.move).find(m => m !== PASS && game.check(m).ok) ?? PASS;
  }
  if (move === PASS) {
    flash(node.board.lastMove === PASS ? `${aiLabel()} passes too.` : `${aiLabel()} passes. If you think the game is finished, pass as well.`);
  }
  playMove(move);
}

// ------------------------------------------------------------------ coach

function pickCoachTarget() {
  const cur = game.current;
  if (!cur.analysisDone) return cur;
  if (cur.parent && !cur.parent.analysisDone) return cur.parent;
  const line = game.line();
  const idx = line.indexOf(cur);
  for (let d = 1; d < line.length; d++) {
    const a = line[idx - d], b = line[idx + d];
    if (a && !a.analysisDone) return a;
    if (b && !b.analysisDone) return b;
  }
  return null;
}

function scheduleCoach() {
  if (!settings.coach || (scoring && scoring.pending)) return;
  const target = pickCoachTarget();
  if (!target) return;
  if (coachNode && (coachNode === target || target !== game.current)) return;
  coachNode = target;
  coach.search(game.recipe(target), {
    playouts: settings.coachPlayouts,
    maxTime: 120000,
    onProgress: (res, done) => {
      target.analysis = res;
      if (done) target.analysisDone = true;
      onAnalysis(target);
    },
  }).then(res => {
    if (coachNode === target) coachNode = null;
    if (res) scheduleCoach();
  });
}

function tryGrade(node) {
  const parent = node.parent;
  if (!parent || node.grade || !parent.analysisDone || !node.analysisDone) return;
  node.grade = gradeMove(parent.analysis, node.analysis, node.move);
  node.explain = explainMove(parent.board, node.board, node.move, parent.analysis.ownership, node.analysis.ownership);
}

let analysisRenderPending = false;
function onAnalysis(node) {
  tryGrade(node);
  for (const ch of node.children) tryGrade(ch);
  if (analysisRenderPending) return;
  analysisRenderPending = true;
  requestAnimationFrame(() => { analysisRenderPending = false; render(); });
}

// ------------------------------------------------------------------ scoring

async function enterScoring() {
  const node = game.current;
  cancelAI();
  mode = 'score';
  scoring = { node, dead: new Set(), pending: true };
  render();
  let an = node.analysisDone ? node.analysis : null;
  if (!an) {
    coach.cancel();
    coachNode = null;
    an = await coach.search(game.recipe(node), { playouts: 8000, reportMs: 0 });
    if (an) { node.analysis = an; node.analysisDone = true; tryGrade(node); }
  }
  if (!scoring || scoring.node !== node) return;
  scoring.dead = an ? estimateDead(node.board, an.ownership) : new Set();
  scoring.pending = false;
  render();
  scheduleCoach();
}

function exitScoring() { mode = 'play'; scoring = null; }

function toggleDead(p) {
  if (!scoring || scoring.pending) return;
  const b = scoring.node.board;
  if (b.color[p] !== BLACK && b.color[p] !== WHITE) return;
  const on = !scoring.dead.has(p);
  for (const s of b.chainStones(p)) on ? scoring.dead.add(s) : scoring.dead.delete(s);
  render();
}

function resumeFromScoring() {
  exitScoring();
  game.undo();
  const ai = aiColor();
  if (ai) while (game.current.parent && (game.toPlay === ai || game.current.move === PASS && game.current.parent.move === PASS)) game.undo();
  afterChange();
}

// ------------------------------------------------------------------ navigation

function goTo(node) {
  cancelAI();
  if (mode === 'score') exitScoring();
  better = null; hintOn = false;
  game.goTo(node);
  save(); render(); scheduleCoach();
}

function nav(where) {
  const cur = game.current;
  if (where === 'first') goTo(game.root);
  else if (where === 'prev' && cur.parent) goTo(cur.parent);
  else if (where === 'next') { const n = cur.lastChild || cur.children[0]; if (n) goTo(n); }
  else if (where === 'last') { const line = game.line(); goTo(line[line.length - 1]); }
}

function showBetter(node) {
  const g = node.grade, parent = node.parent;
  if (!g || !parent) return;
  goTo(parent);
  const m = parent.analysis && parent.analysis.moves.find(x => x.move === g.bestMove);
  better = { node: parent, move: g.bestMove, pv: pvStones(parent.board.toPlay, [g.bestMove, ...((m && m.pv) || [])]) };
  flash(`Coach's choice: ${ptName(g.bestMove)}. Numbered stones show how it expects play to go on. Click to try it, or ▶ to go back.`);
  render();
}

function tryInstead(node) {
  const g = node.grade;
  if (!g || !node.parent) return;
  goTo(node.parent);
  playMove(g.bestMove);
}

// ------------------------------------------------------------------ rendering

function render() {
  renderBoard();
  renderPlayers();
  renderCoach();
  renderScorePanel();
  renderNav();
  renderStatus();
  renderGraph($('#graph'), game.line(), game.current, goTo);
}

function moveNumbers(node) {
  const map = new Map();
  const path = [];
  for (let n = node; n.parent; n = n.parent) path.unshift(n);
  for (const n of path) if (n.move !== PASS) map.set(n.move, n.depth);
  for (const p of [...map.keys()]) if (node.board.color[p] === EMPTY) map.delete(p);
  return map;
}

function hintList(an) {
  const ms = an.moves.filter(m => m.move !== PASS);
  if (!ms.length) return [];
  const top = ms[0];
  const sgn = an.toPlay === BLACK ? 1 : -1;
  return ms.filter(m => m.visits >= Math.max(8, top.visits * 0.06)).slice(0, 6).map((m, rank) => {
    const loss = top.winrate - m.winrate;
    const color = rank === 0 ? '#2f9e61' : loss < 0.04 ? '#3b82c4' : loss < 0.1 ? '#b8901c' : '#cf6a1d';
    const lead = m.score * sgn;
    return { move: m.move, rank, color, label: `${Math.round(m.winrate * 100)}%`, sub: `${lead >= 0 ? '+' : ''}${lead.toFixed(1)}` };
  });
}

function hoverInfo() {
  const p = hoverPt, node = game.current, b = node.board;
  if (p === null || mode !== 'play' || aiNode || game.isOver(node) || b.color[p] !== EMPTY) return null;
  if (aiColor() && !resigned && b.toPlay === aiColor()) return null;
  const c = b.toPlay, r = game.check(p);
  if (!r.ok) return { p, color: c, ok: false, reason: r.reason };
  const info = { p, color: c, ok: true, detail: settings.show.preview };
  if (info.detail) {
    const t = b.clone();
    t.play(p);
    info.captures = POINTS.filter(q => b.color[q] === 3 - c && t.color[q] === EMPTY);
    info.libs = t.libCount(p);
    info.ataris = POINTS.filter(q => t.color[q] === 3 - c && t.inAtari(t.head[q]) && !b.inAtari(b.head[q]));
  }
  return info;
}

function renderBoard() {
  const node = game.current, b = node.board, an = node.analysis, sh = settings.show;
  const s = {
    board: b, nodeId: node.id,
    lastMove: node.parent ? node.move : PASS,
    captured: node.captured, capturedColor: 3 - node.color,
    liberties: sh.liberties,
  };
  if (sh.numbers) s.numbers = moveNumbers(node);
  if (sh.atari && mode === 'play') s.threats = threats(b).filter(t => t.libs.length === 1);
  if (sh.territory && an && mode === 'play') s.ownership = an.ownership;
  if (scoring) { s.dead = scoring.dead; if (!scoring.pending) s.scoreOwner = game.score(scoring.dead, node).owner; }
  const hintsVisible = mode === 'play' && an && (hintOn || sh.hints) && !game.isOver(node) && !(aiColor() && !resigned && b.toPlay === aiColor() && node.children.length === 0);
  if (hintsVisible) {
    s.hints = hintList(an);
    const m = hoverPt !== null && an.moves.find(x => x.move === hoverPt);
    if (m && m.pv) s.pv = pvStones(b.toPlay, [m.move, ...m.pv]);
  }
  if (better && better.node === node) { s.better = better.move; s.pv = better.pv; }
  if (sh.feedback && node.grade && ['mistake', 'blunder'].includes(node.grade.grade)) s.grade = GRADES[node.grade.grade].color;
  if (!s.pv) s.hover = hoverInfo();
  view.render(s);
}

function renderPlayers() {
  const b = game.board;
  for (const c of [BLACK, WHITE]) {
    const el = $(c === BLACK ? '#pBlack' : '#pWhite');
    el.querySelector('.pname').textContent = !settings.human ? colorName(c) : c === settings.human ? 'You' : aiLabel();
    el.querySelector('.caps').textContent = b.captures[c];
    el.classList.toggle('turn', mode === 'play' && !game.isOver() && b.toPlay === c);
    el.classList.toggle('thinking', !!aiNode && aiNode.board.toPlay === c);
  }
}

function openingTip() {
  if (!settings.human) return 'Study mode: you place stones for both colours. Turn on <b>Best moves</b> to compare your ideas with the coach.';
  if (game.handicap) return `Handicap game: Black starts with ${game.handicap} stones and White moves first. Use your head start: build territory and stay connected.`;
  if (settings.human === BLACK) return 'Welcome to the dojo! You are Black and move first. Click an intersection to place a stone. The centre (E5) or points like C3, G7, C7 or G3 are great starts. Take back any move with <kbd>U</kbd>.';
  return 'You are White. The AI moves first. White gets komi (bonus points) for going second.';
}

function renderCoach() {
  const node = game.current, an = node.analysis;
  $('#coachStatus').textContent = !settings.coach ? 'off' :
    an ? (node.analysisDone ? `${fmtK(an.playouts)} sims` : `reading… ${fmtK(an.playouts)}`) : 'reading…';
  const bw = an ? an.blackWinrate : 0.5;
  $('#winB').style.width = `${(bw * 100).toFixed(1)}%`;
  $('#winLabelB').textContent = an ? `Black ${Math.round(bw * 100)}%` : 'Black';
  $('#winLabelW').textContent = an ? `${Math.round((1 - bw) * 100)}% White` : 'White';
  $('#scoreEst').innerHTML = an ? `Expected result: <b>${describeScore(an.score)}</b> <span class="muted">(incl. komi ${game.komi})</span>` : '&nbsp;';

  const fb = $('#feedback');
  let html = '';
  if (!node.parent) html = `<p class="tip">${openingTip()}</p>`;
  else if (node.move === PASS) html = `<p><b>${who(node.color)}</b> passed.</p>`;
  else if (settings.show.feedback) {
    const g = node.grade;
    const head = pill => `<div class="fb-head">${pill} <span><b>${who(node.color)}</b> played <b>${ptName(node.move)}</b></span></div>`;
    if (!g) html = head('<span class="pill pending">grading…</span>');
    else {
      const G = GRADES[g.grade];
      html = head(`<span class="pill" style="--pill:${G.color}">${G.label}</span>`);
      if (g.grade === 'best') html += '<p>Exactly the coach\'s choice.</p>';
      else if (g.grade === 'good') html += `<p>A fine move. The coach slightly preferred <b>${ptName(g.bestMove)}</b>.</p>`;
      else html += `<p>About <b>${g.ptLoss.toFixed(1)} points</b> worse than <b>${ptName(g.bestMove)}</b>${g.wrLoss >= 0.01 ? ` (win chance −${Math.round(g.wrLoss * 100)}%)` : ''}.</p>`;
      if (g.grade !== 'best' && g.bestMove !== PASS) {
        html += `<div class="fb-actions"><button data-act="show">Show ${ptName(g.bestMove)}</button><button data-act="try">Try ${ptName(g.bestMove)} instead</button></div>`;
      }
    }
  } else {
    html = `<div class="fb-head"><span><b>${who(node.color)}</b> played <b>${ptName(node.move)}</b></span></div>`;
  }
  fb.innerHTML = html;
  fb.onclick = e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'show') showBetter(node);
    if (act === 'try') tryInstead(node);
  };

  const ex = $('#explain');
  ex.innerHTML = node.parent && node.explain ? node.explain.map(t => `<li>${t}</li>`).join('') : '';

  // Live warnings about the position on the board.
  const b = node.board, me = b.toPlay;
  let warn = '';
  if (settings.show.atari && mode === 'play' && !game.isOver(node)) {
    for (const t of threats(b)) {
      if (t.libs.length !== 1) continue;
      const n = t.stones.length, where = ptName(t.stones[0]), lib = ptName(t.libs[0]);
      const stones = n > 1 ? `${n} stones at ${where} are` : `stone at ${where} is`;
      if (t.color === me) warn += `<li class="warn">${whose(t.color)} ${stones} in atari. Extending at ${lib} only helps if it gains liberties.</li>`;
      else warn += `<li class="chance">${whose(t.color)} ${stones} in atari: ${who(me) === 'You' ? 'you' : colorName(me)} can capture at ${lib}.</li>`;
    }
  }
  $('#warnings').innerHTML = warn;
}

function renderScorePanel() {
  const el = $('#scorePanel');
  if (!scoring && !resigned) { el.hidden = true; return; }
  el.hidden = false;
  if (resigned && !scoring) {
    el.innerHTML = `<h2>${colorName(resigned)} resigned</h2><p class="big">${resigned === settings.human ? 'The AI wins this one.' : 'You win!'}</p>
      <div class="fb-actions"><button data-act="new" class="primary">New game</button></div>`;
  } else if (scoring.pending) {
    el.innerHTML = '<h2>Counting…</h2><p class="muted">The coach is working out which stones are dead.</p>';
  } else {
    const s = game.score(scoring.dead, scoring.node);
    const winText = !s.winner ? 'A draw!' : !settings.human ? `${colorName(s.winner)} wins.` :
      s.winner === settings.human ? 'You win! 🎉' : 'The AI wins this one.';
    const tm = s.territory.margin;
    el.innerHTML = `<h2>Game over · ${s.text}</h2>
      <p class="big">${winText}</p>
      <table class="score-table">
        <tr><th></th><th>Black</th><th>White</th></tr>
        <tr><td>Stones + surrounded area</td><td>${s.black}</td><td>${s.white}</td></tr>
        <tr><td>Komi</td><td></td><td>${s.komi}</td></tr>
        <tr class="total"><td>Total</td><td>${s.black}</td><td>${s.white + s.komi}</td></tr>
      </table>
      <p class="muted">Area scoring (Chinese rules). Counting territory + prisoners instead (Japanese style) gives ${tm === 0 ? 'a draw' : (tm > 0 ? 'B+' : 'W+') + Math.abs(tm)}.</p>
      <p class="muted">Squares show who owns each point. Don't agree about a dead group? Click it to switch between dead and alive.</p>
      <div class="fb-actions"><button data-act="resume">Resume play</button><button data-act="review">Review the game</button><button data-act="new" class="primary">New game</button></div>`;
  }
  el.onclick = e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'resume') resumeFromScoring();
    if (act === 'review') { exitScoring(); goTo(game.root); flash('Review: step through with ◀ ▶ or click the graph. Dots mark mistakes.'); }
    if (act === 'new') openNewGame();
  };
}

function renderNav() {
  const node = game.current;
  $('#moveLabel').textContent = node.parent ? `Move ${node.depth} · ${colorName(node.color)} ${ptName(node.move)}` : 'Start';
  $('[data-nav=first]').disabled = $('[data-nav=prev]').disabled = !node.parent;
  $('[data-nav=next]').disabled = $('[data-nav=last]').disabled = !node.children.length;
  const humanTurn = mode === 'play' && !aiNode && !game.isOver() && !(aiColor() && !resigned && game.toPlay === aiColor());
  $('#btnPass').disabled = !humanTurn;
  $('#btnUndo').disabled = !node.parent;
  $('#btnAI').disabled = !!aiNode || mode !== 'play' || game.isOver();
  $('#btnResign').textContent = game.isOver() ? 'Count' : 'Resign';
  $('#btnResign').disabled = mode === 'score' || (!game.isOver() && (!settings.human || !!resigned));
  $('#btnHint').classList.toggle('on', hintOn);

  let html = '';
  const sibs = node.parent ? node.parent.children : [];
  if (sibs.length > 1) {
    html += `<span class="muted">Variations:</span>` + sibs.map((s, i) =>
      `<button class="chip${s === node ? ' on' : ''}" data-id="${s.id}">${i === 0 ? '★ ' : ''}${ptName(s.move)}</button>`).join('');
  }
  if (node.children.length > 1) {
    html += `<span class="muted">Continue with:</span>` + node.children.map(s =>
      `<button class="chip" data-id="${s.id}">${ptName(s.move)}</button>`).join('');
  }
  const v = $('#variations');
  v.innerHTML = html;
  v.onclick = e => {
    const id = +(e.target.dataset && e.target.dataset.id);
    const target = [...sibs, ...node.children].find(n => n.id === id);
    if (target) goTo(target);
  };
}

function renderStatus() {
  const el = $('#message');
  let text = '', kind = '';
  const node = game.current;
  const h = mode === 'play' && hoverPt !== null ? hoverInfo() : null;
  if (h && !h.ok) { text = reasonText(h.reason); kind = 'bad'; }
  else if (flashMsg) { text = flashMsg.text; kind = flashMsg.kind; }
  else if (scoring) text = scoring.pending ? 'Counting…' : 'Click groups to mark them dead or alive.';
  else if (aiNode) text = `${aiLabel()} is thinking…`;
  else if (resigned) text = `${colorName(resigned)} resigned.`;
  else if (game.isOver(node)) text = 'Both players passed. The game is over.';
  else if (!settings.human) text = `${colorName(node.board.toPlay)} to play.`;
  else if (node.board.toPlay === settings.human) text = `Your move (${colorName(settings.human)}).`;
  else text = 'Viewing an earlier position. It\'s the AI\'s turn here: press "AI move", or ▶ to step forward.';
  el.textContent = text;
  el.className = `message ${kind}`;
}

// ------------------------------------------------------------------ persistence

function save() {
  try {
    const path = [];
    for (let n = game.current; n.parent; n = n.parent) path.unshift(n.parent.children.indexOf(n));
    localStorage.setItem(STORE, JSON.stringify({ settings, sgf: game.toSGF(), path, resigned }));
  } catch { /* storage unavailable */ }
}

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE));
    if (!d) return false;
    settings = { ...structuredClone(DEFAULTS), ...d.settings, show: { ...DEFAULTS.show, ...(d.settings && d.settings.show) } };
    settings.level = Math.min(LEVELS.length - 1, Math.max(0, settings.level | 0));
    game = Game.fromSGF(d.sgf);
    let n = game.root;
    for (const i of d.path || []) { if (!n.children[i]) break; n = n.children[i]; }
    game.goTo(n);
    resigned = d.resigned || 0;
    return true;
  } catch (e) {
    console.warn('Could not restore saved game', e);
    return false;
  }
}

function exportSGF() {
  const name = c => !settings.human ? colorName(c) : c === settings.human ? 'Human' : `GoDojo ${level().name}`;
  const text = game.toSGF({ black: name(BLACK), white: name(WHITE), result: resigned ? `${resigned === BLACK ? 'W' : 'B'}+R` : '' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-go-sgf' }));
  a.download = `go-dojo-${new Date().toISOString().slice(0, 10)}.sgf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function importSGF(text) {
  try {
    const g = Game.fromSGF(text);
    cancelAI();
    game = g;
    settings.human = 0;
    mode = 'play'; scoring = null; resigned = 0; better = null;
    syncOptions();
    flash('Game loaded in study mode (you play both colours). Step through it and watch the coach.');
    afterChange();
  } catch (e) {
    flash(`Could not load that SGF: ${e.message}`, 'bad');
  }
}

// ------------------------------------------------------------------ dialogs & controls

function openNewGame() {
  const dlg = $('#newGameDlg'), f = dlg.querySelector('form');
  f.elements.color.value = String(settings.human);
  f.elements.level.value = String(settings.level);
  f.elements.handicap.value = String(settings.handicap);
  f.elements.komi.value = String(settings.komi);
  dlg.showModal();
}

function setupDialog() {
  $('#levelList').innerHTML = LEVELS.map((l, i) =>
    `<label class="level"><input type="radio" name="level" value="${i}"><span><b>${i + 1} · ${l.name}</b><small>${l.blurb}</small></span></label>`).join('');
  const dlg = $('#newGameDlg'), f = dlg.querySelector('form');
  f.elements.handicap.onchange = () => { f.elements.komi.value = +f.elements.handicap.value ? '0.5' : '7'; };
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    settings.human = +f.elements.color.value;
    settings.level = +f.elements.level.value;
    settings.handicap = +f.elements.handicap.value;
    settings.komi = parseFloat(f.elements.komi.value) || 0;
    syncOptions();
    newGame();
  });
}

function syncOptions() {
  $('#optLevel').value = String(settings.level);
  $('#optCoach').value = String(settings.coachPlayouts);
  $('#optSound').checked = settings.sound;
  $('#toggles').querySelectorAll('input').forEach(i => { i.checked = !!settings.show[i.dataset.key]; });
}

function setupControls() {
  $('#toggles').innerHTML = TOGGLES.map(([key, label, help, k]) =>
    `<label class="toggle"><input type="checkbox" data-key="${key}"><span class="sw" aria-hidden="true"></span>` +
    `<span class="tl">${label} <kbd>${k}</kbd></span><small>${help}</small></label>`).join('');
  $('#toggles').addEventListener('change', e => {
    const key = e.target.dataset.key;
    if (!key) return;
    settings.show[key] = e.target.checked;
    save(); render();
  });
  $('#optLevel').innerHTML = LEVELS.map((l, i) => `<option value="${i}">${i + 1} · ${l.name}</option>`).join('');
  $('#optLevel').onchange = e => { settings.level = +e.target.value; save(); render(); };
  $('#optCoach').onchange = e => {
    settings.coachPlayouts = +e.target.value;
    // Re-read positions at the new depth.
    for (const n of game.line()) n.analysisDone = false;
    coach.cancel(); coachNode = null;
    save(); scheduleCoach();
  };
  $('#optSound').onchange = e => { settings.sound = e.target.checked; save(); };

  $('#btnPass').onclick = humanPass;
  $('#btnUndo').onclick = takeBack;
  $('#btnHint').onclick = () => {
    hintOn = !hintOn;
    if (hintOn && !game.current.analysis) flash('The coach is still reading this position…');
    render();
  };
  $('#btnAI').onclick = () => aiMove(true);
  $('#btnResign').onclick = resignOrScore;
  $('#btnNew').onclick = openNewGame;
  $('#btnExport').onclick = exportSGF;
  $('#btnImport').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = async e => {
    const file = e.target.files[0];
    if (file) importSGF(await file.text());
    e.target.value = '';
  };
  document.querySelectorAll('[data-nav]').forEach(btn => { btn.onclick = () => nav(btn.dataset.nav); });

  const toggleKey = { l: 'liberties', a: 'atari', t: 'territory', v: 'preview', g: 'feedback', b: 'best', n: 'numbers' };
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest('input, select, textarea, dialog')) return;
    const k = e.key.toLowerCase();
    if (e.key === 'ArrowLeft') nav('prev');
    else if (e.key === 'ArrowRight') nav('next');
    else if (e.key === 'Home') nav('first');
    else if (e.key === 'End') nav('last');
    else if (k === 'u' || e.key === 'Backspace') takeBack();
    else if (k === 'h') $('#btnHint').click();
    else if (k === 'p') humanPass();
    else if (e.key === 'Escape') { better = null; hintOn = false; render(); }
    else if (toggleKey[k]) {
      const key = toggleKey[k] === 'best' ? 'hints' : toggleKey[k];
      settings.show[key] = !settings.show[key];
      syncOptions(); save(); render();
    } else return;
    e.preventDefault();
  });
}

// ------------------------------------------------------------------ boot

setupControls();
setupDialog();
if (!load()) game = new Game({ komi: settings.komi, handicap: settings.handicap });
syncOptions();
afterChange();

// Handy for debugging from the console.
window.dojo = { get game() { return game; }, settings, render, aiMove, coach, opponent };
