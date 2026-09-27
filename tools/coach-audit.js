// Measures how often the coach's move grades are wrong, against a much deeper
// "oracle" search. Games, oracle reads and coach reads are cached in local/.
//   node tools/coach-audit.js --gen      play the test games (levels mixed so there are real mistakes)
//   node tools/coach-audit.js --oracle   deep-search every position and the oracle's preferred sibling
//   node tools/coach-audit.js            grade every move with each coach config and score the grades
//   ... --referee                        settle every disputed move (coach and oracle disagree in any
//                                        config) with two fresh 300k reads of each candidate position
// Options: --workers 7  --oracle-playouts 100000  --configs name,name  --verbose
//   --engine katago    the oracle (and referee) read with KataGo's network instead, at
//                      --oracle-visits (default 1600); its files end in -katago. The
//                      configs named kata* grade with KataGo reads, the rest with the
//                      built-in engine, so both can be scored against the same oracle.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { BLACK, PASS, ptName } from '../src/board.js';
import { Search, seed, rand } from '../src/mcts.js';
import { Game } from '../src/game.js';
import { LEVELS, chooseMove, shouldPass, gradeMove, reviewNeeded, GRADING } from '../src/coach.js';
import { mergeResults } from '../src/engine-client.js';
import { buildPosition } from '../src/recipe.js';
import { KataSearch } from '../src/katago/search.js';
import { Evaluator } from '../src/katago/evaluator.js';
import { loadNet } from './katago-node.js';

const DIR = new URL('../local/', import.meta.url);
const file = name => new URL(name, DIR);
const load = name => existsSync(file(name)) ? JSON.parse(readFileSync(file(name), 'utf8')) : null;
const store = (name, data) => { mkdirSync(DIR, { recursive: true }); writeFileSync(file(name), JSON.stringify(data)); };

// ------------------------------------------------------------------ worker side

function gameAt(moves) {
  const game = new Game({ komi: 7 });
  for (const m of moves) game.play(m);
  return game;
}

// One read of a position: `trees` independent searches of playouts/trees each, root stats merged
// (exactly what the app's coach pool does).
function read(moves, playouts, trees, s) {
  const game = gameAt(moves);
  const list = [];
  for (let t = 0; t < trees; t++) {
    seed(s * 31 + t + 1);
    const search = new Search(game.board, { komi: 7, forbidden: p => !game.check(p).ok });
    search.run(Math.ceil(playouts / trees));
    list.push(search.results(60));
  }
  const r = mergeResults(list);
  const slim = m => ({ move: m.move, visits: m.visits, winrate: m.winrate, score: m.score });
  return { toPlay: r.toPlay, playouts: r.playouts, winrate: r.winrate, score: r.score, moves: (r.allMoves || r.moves).map(slim) };
}

// The same with KataGo at `visits` (one tree; its random symmetries seeded from s).
let net = null;
async function readKata(moves, visits, s) {
  net = net || (await loadNet()).net;
  const game = gameAt(moves);
  let r = s >>> 0 || 1;
  const rand = () => { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; return (r >>> 0) / 4294967296; };
  const search = new KataSearch(buildPosition(game.recipe()), { komi: 7, evaluator: new Evaluator(net, { rand, cacheSize: 0 }), batch: 4 });
  await search.run(visits);
  const res = search.results(60);
  const slim = m => ({ move: m.move, visits: m.visits, winrate: m.winrate, score: m.score });
  return { toPlay: res.toPlay, playouts: res.playouts, engine: 'katago', winrate: res.winrate, score: res.score, moves: res.allMoves.map(slim) };
}

function playGame(la, lb, s) {
  seed(s);
  const game = new Game({ komi: 7 });
  while (!game.isOver() && game.current.depth < 120) {
    const lv = LEVELS[game.toPlay === BLACK ? la : lb];
    const search = new Search(game.board, { komi: 7, forbidden: p => !game.check(p).ok });
    search.run(lv.playouts);
    const r = search.results(60);
    if (game.current.depth > 20 && r.winrate < 0.03) break;
    let move = shouldPass(game, r, game.toPlay) ? PASS : chooseMove(r, lv, rand);
    if (move !== PASS && !game.check(move).ok) move = PASS;
    game.play(move);
  }
  const moves = [];
  for (let n = game.current; n.parent; n = n.parent) moves.unshift(n.move);
  return moves;
}

if (!isMainThread) {
  parentPort.on('message', async job => {
    const out = job.type === 'game' ? playGame(job.la, job.lb, job.seed)
      : job.visits ? await readKata(job.moves, job.visits, job.seed)
      : read(job.moves, job.playouts, job.trees, job.seed);
    parentPort.postMessage({ id: job.id, out });
  });
}

// ------------------------------------------------------------------ main side

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes('--' + k);
const KATA = arg('engine') === 'katago';
const ORACLE = KATA ? 'audit-oracle-katago.json' : 'audit-oracle.json';
const REFEREE = KATA ? 'audit-referee-katago.json' : 'audit-referee.json';
// The read job for a deep oracle or referee read (tag keeps seeds apart).
const deepRead = (moves, tag, scale = 1) => KATA
  ? { type: 'read', moves, visits: +arg('oracle-visits', 1600) * scale, seed: keySeed(tag + posKey(moves)) }
  : { type: 'read', moves, playouts: +arg('oracle-playouts', 100000) * scale, trees: 1, seed: keySeed(tag + posKey(moves)) };

function pool(n) {
  const workers = Array.from({ length: n }, () => new Worker(new URL(import.meta.url)));
  const queue = [], waiting = new Map();
  let nextId = 1;
  const pump = w => {
    const job = queue.shift();
    if (!job) { w.idle = true; return; }
    w.idle = false;
    w.postMessage(job);
  };
  for (const w of workers) {
    w.idle = true;
    w.on('message', ({ id, out }) => { waiting.get(id)(out); waiting.delete(id); pump(w); });
  }
  return {
    run(job) {
      return new Promise(resolve => {
        job.id = nextId++;
        waiting.set(job.id, resolve);
        queue.push(job);
        const w = workers.find(x => x.idle);
        if (w) pump(w);
      });
    },
    close() { for (const w of workers) w.terminate(); },
  };
}

// Seeds that don't depend on job order, so every run is reproducible.
const keySeed = key => { let h = 2166136261; for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const posKey = moves => moves.join(',');

// Level pairs (0-based) chosen to give a spread of blunders, mistakes and fine moves.
const PAIRS = [[2, 4], [3, 5], [4, 6], [2, 5], [5, 6], [3, 6], [4, 7], [6, 7]];

async function gen(p) {
  const games = await Promise.all(PAIRS.map(([la, lb], i) => p.run({ type: 'game', la, lb, seed: 1000 + i })));
  store('audit-games.json', games.map((moves, i) => ({ black: PAIRS[i][0], white: PAIRS[i][1], moves })));
  console.log(`${games.length} games, ${games.reduce((s, g) => s + g.length, 0)} moves`);
}

// Every move of every game: parent position, the move and its player's view.
function* allMoves(games) {
  for (const [gi, g] of games.entries()) {
    for (let i = 0; i < g.moves.length; i++) {
      if (g.moves[i] === PASS) continue;
      yield { gi, i, parent: g.moves.slice(0, i), move: g.moves[i] };
    }
  }
}

async function oracle(p, games) {
  const cache = load(ORACLE) || {};
  const get = moves => {
    const k = posKey(moves), job = deepRead(moves, 'oracle');
    if (cache[k] && cache[k].playouts >= (job.visits || job.playouts)) return cache[k];
    return p.run(job).then(r => {
      cache[k] = r;
      if (Object.keys(cache).length % 20 === 0) { store(ORACLE, cache); process.stdout.write('.'); }
      return r;
    });
  };
  const list = [...allMoves(games)];
  // Pass 1: every position on the game lines. Pass 2: the oracle's best alternative to each move.
  await Promise.all(list.flatMap(m => [get(m.parent), get([...m.parent, m.move])]));
  await Promise.all(list.map(m => {
    const best = cache[posKey(m.parent)].moves[0].move;
    return best === m.move || best === PASS ? null : get([...m.parent, best]);
  }));
  store(ORACLE, cache);
  console.log(`\n${Object.keys(cache).length} oracle positions`);
}

// The oracle's point loss for a move: its best sibling vs the played move, both read deeply after the move.
function oracleLoss(cache, m) {
  const parent = cache[posKey(m.parent)];
  const best = parent.moves[0].move;
  const sgn = parent.toPlay === BLACK ? 1 : -1;
  const played = cache[posKey([...m.parent, m.move])];
  const alt = best === m.move || best === PASS ? played : cache[posKey([...m.parent, best])];
  if (!played || !alt) return null;
  return { loss: Math.max(0, (alt.score - played.score) * sgn), wrLoss: Math.max(0, played.winrate - alt.winrate), decided: parent.winrate > 0.97 || parent.winrate < 0.03 };
}

// Grading as the app does it: the read before and after the move, plus the
// second read reviewNeeded asks for (counted in m.checks).
async function checkedGrade(m, get) {
  const before = await get(m.parent), after = await get([...m.parent, m.move]);
  const g = gradeMove(before, after, m.move);
  const other = reviewNeeded(g, before);
  if (other == null) return g;
  m.checks = (m.checks || 0) + 1;
  return gradeMove(before, after, m.move, { move: other, analysis: await get([...m.parent, other]) });
}

// Coach configurations to compare. grade(m, get) returns a gradeMove result;
// combine is GRADING.combine for the check read ('min' unless given).
// Refereed results with all configs run together (the referee settles moves
// disputed in any of them), 8 test games: 317 moves in live games, 40 real
// mistakes of 4+ points, as false accusations / harsh / missed / mean error:
//   before      1 / 4 / 15 / 1.00      single24k    2 / 8 / 8 / 0.91
//   beforeMin   0 / 2 / 15 / 0.96      single24kAvg 2 / 6 / 9 / 0.89
//   oldDeep     1 / 4 /  9 / 0.94      single48k    1 / 5 / 6 / 0.73
//   app         1 / 3 /  6 / 0.74
const CONFIGS = {
  // What the app did before: 4 root-parallel trees merged, 24k playouts in all.
  before: { playouts: 24000, trees: 4 },
  beforeMin: { playouts: 24000, trees: 4, grade: checkedGrade },
  beforeAvg: { playouts: 24000, trees: 4, grade: checkedGrade, combine: 'avg' },
  // The old "Deep" setting.
  oldDeep: { playouts: 80000, trees: 4 },
  oldDeepAvg: { playouts: 80000, trees: 4, grade: checkedGrade, combine: 'avg' },
  single24k: { playouts: 24000, trees: 1 },
  single24kMin: { playouts: 24000, trees: 1, grade: checkedGrade },
  single24kAvg: { playouts: 24000, trees: 1, grade: checkedGrade, combine: 'avg' },
  single48k: { playouts: 48000, trees: 1 },
  // What the app does now ("Normal"): one 48k tree per position, averaged checks.
  app: { playouts: 48000, trees: 1, grade: checkedGrade, combine: 'avg' },
  // KataGo's network at the app's Quick / Normal / Deep visits.
  kataQuick: { visits: 133, grade: checkedGrade, combine: 'avg' },
  kataNormal: { visits: 400, grade: checkedGrade, combine: 'avg' },
  kataDeep: { visits: 1000, grade: checkedGrade, combine: 'avg' },
};

async function audit(p, games) {
  const cache = load(ORACLE);
  if (!cache) { console.log('Run --oracle first.'); return; }
  const names = arg('configs', Object.keys(CONFIGS).join(',')).split(',');
  const reads = load('audit-coach.json') || {};
  const list = [...allMoves(games)];
  const results = [];
  for (const name of names) {
    const cfg = CONFIGS[name];
    const tag = cfg.visits ? `katago:${cfg.visits}` : `${cfg.playouts}/${cfg.trees}`;
    const memo = reads[tag] = reads[tag] || {};
    const get = moves => {
      const k = posKey(moves);
      if (memo[k]) return memo[k];
      const job = cfg.visits ? { type: 'read', moves, visits: cfg.visits, seed: keySeed(tag + k) }
        : { type: 'read', moves, playouts: cfg.playouts, trees: cfg.trees, seed: keySeed(tag + k) };
      return memo[k] = p.run(job).then(r => memo[k] = r);
    };
    GRADING.combine = cfg.combine || 'min';
    const grade = cfg.grade || (async m => gradeMove(await get(m.parent), await get([...m.parent, m.move]), m.move));
    const rows = await Promise.all(list.map(async m0 => {
      const m = { ...m0 }, g = await grade(m, get);
      return { m, g, o: oracleLoss(cache, m) };
    }));
    store('audit-coach.json', reads);
    results.push({ name, rows: rows.filter(r => r.g && r.o) });
  }
  if (flag('referee')) await referee(p, results);
  for (const { name, rows } of results) report(name, rows);
}

// The oracle is one 150k read per position, which can still be several points
// off. For each disputed move, read every candidate (played, oracle's best, each
// config's best) twice more at 300k, and replace the oracle loss with that.
async function referee(p, results) {
  const disputed = r => { const f = r.g.grade === 'best' || r.g.grade === 'good'; return f ? r.o.loss >= 4 : r.o.loss < 1.5; };
  const byMove = new Map();
  for (const { rows } of results) for (const r of rows) {
    if (r.o.decided || !disputed(r)) continue;
    const k = posKey([...r.m.parent, r.m.move]);
    if (!byMove.has(k)) byMove.set(k, { m: r.m, cands: new Set([r.m.move]) });
  }
  const oracle = load(ORACLE);
  for (const { rows } of results) for (const r of rows) {
    const d = byMove.get(posKey([...r.m.parent, r.m.move]));
    if (!d) continue;
    d.cands.add(oracle[posKey(r.m.parent)].moves[0].move);
    d.cands.add(r.g.bestMove);
  }
  // Unfinished reads are saved as {} (a pending promise); drop them.
  const cache = Object.fromEntries(Object.entries(load(REFEREE) || {}).filter(([, v]) => v.score !== undefined));
  const get = moves => {
    const k = posKey(moves);
    if (cache[k]) return cache[k];
    // Twice as deep as the oracle (3x for the built-in engine), read twice.
    return cache[k] = Promise.all(['ref1', 'ref2'].map(t => p.run(deepRead(moves, t, KATA ? 2 : 3))))
      .then(rs => { cache[k] = { score: (rs[0].score + rs[1].score) / 2, spread: Math.abs(rs[0].score - rs[1].score) }; store(REFEREE, cache); return cache[k]; });
  };
  const loss = new Map();
  await Promise.all([...byMove].map(async ([k, d]) => {
    const sgn = oracle[posKey(d.m.parent)].toPlay === BLACK ? 1 : -1;
    const vals = await Promise.all([...d.cands].filter(c => c !== PASS).map(async c => ({ c, v: (await get([...d.m.parent, c])).score * sgn })));
    const played = vals.find(x => x.c === d.m.move).v;
    loss.set(k, Math.max(0, Math.max(...vals.map(x => x.v)) - played));
  }));
  console.log(`referee: ${byMove.size} disputed moves settled`);
  for (const { rows } of results) for (const r of rows) {
    const k = posKey([...r.m.parent, r.m.move]);
    if (loss.has(k)) r.o = { ...r.o, loss: loss.get(k), refereed: true };
  }
}

function report(name, rows) {
  const bad = g => g.grade === 'mistake' || g.grade === 'blunder';
  const fine = g => g.grade === 'best' || g.grade === 'good';
  const live = rows.filter(r => !r.o.decided);
  const n = live.length;
  const falseAcc = live.filter(r => bad(r.g) && r.o.loss < 1.5);
  const harsh = live.filter(r => !fine(r.g) && r.o.loss < 1);
  const missed = live.filter(r => fine(r.g) && r.o.loss >= 4);
  const realBad = live.filter(r => r.o.loss >= 4).length;
  const mae = live.reduce((s, r) => s + Math.abs(r.g.ptLoss - r.o.loss), 0) / n;
  const pct = (a, b) => `${a}/${b} (${(100 * a / Math.max(1, b)).toFixed(0)}%)`;
  console.log(`\n== ${name}  (${n} moves in undecided games)`);
  console.log(`  false accusations (mistake/blunder, oracle loss < 1.5): ${pct(falseAcc.length, live.filter(r => bad(r.g)).length)}`);
  console.log(`  harsh (any criticism, oracle loss < 1):                 ${pct(harsh.length, live.filter(r => !fine(r.g)).length)}`);
  console.log(`  missed (best/good, oracle loss >= 4):                   ${pct(missed.length, realBad)}`);
  console.log(`  mean |coach loss - oracle loss|:                        ${mae.toFixed(2)} pts`);
  console.log(`  extra reads for checks:                                 ${rows.reduce((s, r) => s + (r.m.checks || 0), 0)} for ${rows.length} moves`);
  if (flag('verbose')) {
    for (const r of [...falseAcc, ...missed]) {
      console.log(`    game ${r.m.gi} move ${r.m.i + 1} ${ptName(r.m.move)}: coach ${r.g.grade} -${r.g.ptLoss.toFixed(1)} (best ${ptName(r.g.bestMove)}), ${r.o.refereed ? 'referee' : 'oracle'} -${r.o.loss.toFixed(1)}`);
    }
  }
}

if (isMainThread) {
  const p = pool(+arg('workers', Math.max(1, cpus().length - 1)));
  const t = performance.now();
  try {
    if (flag('gen')) await gen(p);
    else {
      const games = load('audit-games.json');
      if (!games) console.log('Run --gen first.');
      else if (flag('oracle')) await oracle(p, games);
      else await audit(p, games);
    }
  } finally {
    p.close();
    console.log(`(${((performance.now() - t) / 1000).toFixed(0)} s)`);
  }
}
