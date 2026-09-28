// Teaching logic that sits on top of search results: AI strength levels,
// move choice, when to pass, dead stones, move grading and plain-language
// explanations. Pure functions — no DOM, testable in node.
import { BLACK, WHITE, PASS, POINTS, ptName } from './board.js';

// Every level plays with KataGo (`kata`: see chooseKataMove), weaker ones by
// reading less and choosing among its instincts more randomly. Calibrated in
// self-play (tools/levels.js): each level beat the one below in 7 to 9 games
// out of 10, and Pebble plays like the built-in Pebble. The built-in fields
// (playouts, temp, blunder) are the fallback where KataGo can't run.
export const LEVELS = [
  { name: 'Pebble', blurb: 'Just learned the rules. Misses captures: practise capturing.', playouts: 50, temp: 1, blunder: 0.3, kata: { visits: 1, temp: 2, floor: 0.001, miss: 0.5 } },
  { name: 'Seedling', blurb: 'Plays sensible-looking moves, but misses a lot.', playouts: 220, temp: 1.2, blunder: 0.14, kata: { visits: 1, temp: 1.5, floor: 0.002, miss: 0.25 } },
  { name: 'Sprout', blurb: 'Knows the basics, still leaves weaknesses.', playouts: 400, temp: 1.5, blunder: 0.1, kata: { visits: 1, temp: 1.2, floor: 0.005, miss: 0.12 } },
  { name: 'Reed', blurb: 'Fights back and punishes obvious mistakes.', playouts: 650, temp: 1.8, blunder: 0.08, kata: { visits: 1, temp: 0.9, floor: 0.01, miss: 0.03 } },
  { name: 'Stream', blurb: 'Plays good shape on instinct, but doesn\'t read ahead.', playouts: 2000, temp: 3, blunder: 0.03, kata: { visits: 1, temp: 0.45, floor: 0.05 } },
  { name: 'River', blurb: 'Reads a few moves ahead. Punishes loose play.', playouts: 5000, temp: 5, blunder: 0, kata: { visits: 12, temp: 0 } },
  { name: 'Mountain', blurb: 'Strong. Reads fights well.', playouts: 16000, temp: 0, blunder: 0, kata: { visits: 48, temp: 0.2, floor: 0.2 } },
  { name: 'Dragon', blurb: 'Very strong, and still quick.', playouts: 60000, temp: 0, blunder: 0, kata: { visits: 128, temp: 0 } },
  { name: 'Phoenix', blurb: 'Extra hard: KataGo thinking longer. For when Dragon isn\'t enough.', playouts: 60000, temp: 0, blunder: 0, kata: { visits: 600, temp: 0 }, maxTime: 10000 },
];

// KataGo positions per round for an AI level's move. Small reads depend on it
// (12 visits in one round of 16 is 11 moves read once each), so the app and
// the match tools use the batch the levels were calibrated with.
export const LEVEL_BATCH = 4;

const sign = c => c === BLACK ? 1 : -1;

// Picks the AI's move from finished search results.
// Weaker levels sample among the explored moves instead of taking the best.
export function chooseMove(results, level, rand = Math.random) {
  const moves = (results.allMoves || results.moves).filter(m => m.move !== PASS);
  if (!moves.length) return PASS;
  // Any mirror image of the chosen move will do; vary it so games don't repeat.
  const pick = m => m.twins ? [m.move, ...m.twins][(rand() * (m.twins.length + 1)) | 0] : m.move;
  const top = moves[0];
  if (level.blunder && rand() < level.blunder && moves.length > 3) {
    // An honest beginner blunder: any move the search looked at a little.
    const pool = moves.filter(m => m.visits >= 2);
    if (pool.length) return pick(pool[(rand() * pool.length) | 0]);
  }
  if (!level.temp) return pick(top);
  // Sample proportional to visits^temp among reasonable candidates.
  const pool = moves.filter(m => m.visits >= top.visits * 0.05);
  const weights = pool.map(m => Math.pow(m.visits, level.temp));
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) if ((r -= weights[i]) <= 0) return pick(pool[i]);
  return pick(top);
}

// Picks a KataGo level's move. A move's share is its visits when the level
// searched, else the network's prior (its instinct, results.policy). Passing
// is shouldPass's decision (it passes when passing is the top move of the read
// it's given, deeper after the opponent passes), so this only plays stones:
// the candidates are moves with at least `floor` times the top share, drawn with
// weight share^(1/temp); temp 0 plays the top move. With chance `miss`, any
// legal move is drawn by prior at temperature 3: the lowest levels' real
// mistakes (a missed capture, a stone left in atari).
export function chooseKataMove(results, kata, rand = Math.random) {
  const pick = m => m.twins ? [m.move, ...m.twins][(rand() * (m.twins.length + 1)) | 0] : m.move;
  const draw = (pool, t) => {
    const w = pool.map(m => Math.pow(m.share, 1 / t));
    let r = rand() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) if ((r -= w[i]) <= 0) return pick(pool[i]);
    return pick(pool[0]);
  };
  const byPrior = (results.policy || []).filter(m => m.move !== PASS && m.prior > 0).map(m => ({ ...m, share: m.prior }));
  const list = (kata.visits > 1 ? (results.allMoves || results.moves || []).filter(m => m.move !== PASS).map(m => ({ ...m, share: m.visits }))
    : byPrior).sort((a, b) => b.share - a.share);
  if (!list.length) return PASS;
  if (kata.miss && rand() < kata.miss && byPrior.length) return draw(byPrior, 3);
  if (!kata.temp) return pick(list[0]);
  return draw(list.filter(m => m.share >= list[0].share * (kata.floor ?? 0.05)), kata.temp);
}

// Average ownership over each chain; chains owned by the other side are dead.
export function estimateDead(board, ownership, threshold = 0.35) {
  const dead = new Set();
  const seen = new Set();
  for (let i = 0; i < POINTS.length; i++) {
    const p = POINTS[i], c = board.color[p];
    if ((c !== BLACK && c !== WHITE) || seen.has(p)) continue;
    const stones = board.chainStones(p);
    let sum = 0;
    for (const s of stones) { seen.add(s); sum += ownership[POINTS.indexOf(s)]; }
    const avg = sum / stones.length * sign(c);
    if (avg < -threshold) for (const s of stones) dead.add(s);
  }
  return dead;
}

// Every point's owner is clear, so further moves can't change the score.
export function isSettled(board, ownership, clear = 0.7) {
  for (let i = 0; i < POINTS.length; i++) {
    if (Math.abs(ownership[i]) < clear) return false;
  }
  return true;
}

// Should the AI pass instead of moving?
export function shouldPass(game, results, aiColor) {
  const board = game.board;
  // A 1-visit KataGo read visits no moves: its instinct (the top prior) stands in.
  const best = (results.allMoves || results.moves)[0]
    || (results.policy || []).reduce((a, m) => !a || m.prior > a.prior ? m : a, null);
  if (!best || best.move === PASS) return true;
  const own = results.ownership;
  const count = game.score(estimateDead(board, own));
  if (board.lastMove === PASS && board.moveCount > 0) {
    // Opponent passed: pass too if we win the count as the board stands and
    // the search expects about the same result from playing on.
    return count.winner === aiColor && Math.abs(count.margin - results.score) < 3;
  }
  // Otherwise only when nothing is left to decide: no neutral points (dame or
  // open borders) and every point's owner is very clear.
  const closed = POINTS.every(p => count.owner[p] !== 0);
  return closed && isSettled(board, own, 0.9);
}

// Winrate / score of the best move in a finished analysis, for the side to move.
function bestOf(an) {
  const m = an.moves && an.moves[0];
  if (!m) return { winrate: an.winrate, score: an.score * sign(an.toPlay), move: PASS };
  return { winrate: m.winrate, score: m.score * sign(an.toPlay), move: m.move };
}

export const GRADES = {
  best: { label: 'Best move', color: '#2f9e61' },
  good: { label: 'Good', color: '#4f9fd6' },
  inaccuracy: { label: 'Inaccuracy', color: '#d9b43a' },
  mistake: { label: 'Mistake', color: '#e07b2c' },
  blunder: { label: 'Blunder', color: '#d2413a' },
};

// The search entry for a move, including when the move is a mirror image
// (twin) of a searched one on a symmetric board.
export const entryFor = (an, move) => an.moves.find(m => m.move === move || (m.twins && m.twins.includes(move)));

// How a check read's loss combines with the first estimate: 'avg' (the two are
// equally noisy reads, so average them) or 'min' (only count what both see).
// tools/coach-audit.js measured 'avg' as missing fewer real mistakes for the
// same number of false alarms.
export const GRADING = { combine: 'avg' };

function classify(ptLoss, wrLoss, bestWinrate) {
  let grade;
  if (ptLoss < 1.5 && wrLoss < 0.05) grade = 'good';
  else if (ptLoss < 4 && wrLoss < 0.12) grade = 'inaccuracy';
  else if (ptLoss < 10 && wrLoss < 0.3) grade = 'mistake';
  else grade = 'blunder';
  // A hopeless or totally won game: winrate barely moves; trust points more.
  if (ptLoss < 1.5 && (bestWinrate > 0.97 || bestWinrate < 0.03)) grade = 'good';
  return grade;
}

// Grades the move from `before` (analysis of the parent, mover to play) to
// `after` (analysis of the position after the move).
// `check` = { move, analysis } is an equally deep analysis of the position
// after another move (see reviewNeeded), so the two can be compared like with
// like: after the coach's best move, the side-by-side loss is combined with the
// first estimate (GRADING.combine); after the runner-up to a move the coach
// agreed with, the move loses its "best" when the runner-up turns out clearly better.
export function gradeMove(before, after, move, check = null) {
  if (!before || !after || !before.moves || !before.moves.length) return null;
  const mover = before.toPlay;
  let best = bestOf(before);
  const entry = entryFor(before, move);
  const isBest = !!entry && entry.move === best.move;
  const wrAfter = 1 - after.winrate;
  const scoreAfter = after.score * sign(mover);
  // Take the better of "as seen from before" and "as seen from after" for the
  // played move, so a move the first search barely looked at isn't unfairly judged.
  const seen = entry && entry.visits >= 30 ? entry : null;
  const wr = seen ? Math.max(wrAfter, Math.min(seen.winrate, wrAfter + 0.1)) : wrAfter;
  const sc = seen ? Math.max(scoreAfter, Math.min(seen.score * sign(mover), scoreAfter + 3)) : scoreAfter;
  let wrLoss = Math.max(0, best.winrate - wr);
  let ptLoss = Math.max(0, best.score - sc);
  // Checked side by side: the other move's score and winrate after it, minus ours.
  const cmp = check && { pt: check.analysis.score * sign(mover) - scoreAfter, wr: (1 - check.analysis.winrate) - wrAfter };
  let grade = isBest ? 'best' : null;
  if (cmp && !isBest) {
    const mix = (a, b) => GRADING.combine === 'min' ? Math.min(a, b) : (a + b) / 2;
    wrLoss = mix(wrLoss, Math.max(0, cmp.wr));
    ptLoss = mix(ptLoss, Math.max(0, cmp.pt));
  } else if (cmp && (cmp.pt >= 1.5 || cmp.wr >= 0.05)) {
    best = { move: check.move, winrate: 1 - check.analysis.winrate, score: check.analysis.score * sign(mover) };
    wrLoss = Math.max(0, cmp.wr);
    ptLoss = Math.max(0, cmp.pt);
    grade = null;
  }
  grade = grade || classify(ptLoss, wrLoss, best.winrate);
  // How far the read after the move fell short of what the read before it
  // expected from the best move. Large when the first search missed something.
  const surprise = { pt: best.score - scoreAfter, wr: best.winrate - wrAfter };
  const alternatives = before.moves.slice(0, 3).filter(m => m !== entry && m.visits >= before.moves[0].visits * 0.2);
  return { grade, wrLoss, ptLoss, bestMove: best.move, bestWinrate: best.winrate, winrate: wr, alternatives, mover, checked: !!check, surprise };
}

// A second read that should happen before a grade is shown, as the move whose
// resulting position to analyse (passed back to gradeMove as `check`), or null
// when the grade can stand:
// - the move is graded worse than the coach's choice: read after that choice too;
// - the move is the coach's choice, but the position after it looks much worse
//   than the first read expected: read after the runner-up to see whether the
//   first read missed a problem with the move.
export function reviewNeeded(g, before) {
  if (!g || g.checked) return null;
  if (g.grade === 'best') {
    if (g.surprise.pt < 4 && g.surprise.wr < 0.15) return null;
    const rival = before.moves.find(m => m.move !== g.bestMove && m.move !== PASS);
    return rival ? rival.move : null;
  }
  return g.grade !== 'good' && g.bestMove !== PASS ? g.bestMove : null;
}

// Under area scoring a move inside your own settled territory (say, capturing
// stones that are already dead) costs nothing, so the search can rate it best.
// As advice it's useless when a real move is as good: put the runner-up first.
// Mutates and returns the analysis.
export function preferUsefulMove(an) {
  const ms = an && an.moves;
  if (!ms || ms.length < 2 || ms[0].move === PASS || ms[1].move === PASS) return an;
  const [a, b] = ms, s = sign(an.toPlay);
  if (an.ownership[POINTS.indexOf(a.move)] * s < 0.8) return an;
  if ((a.score - b.score) * s > 0.5 || a.winrate - b.winrate > 0.02) return an;
  ms[0] = b; ms[1] = a;
  const all = an.allMoves;
  if (all && all !== ms) {
    const i = all.indexOf(a), j = all.indexOf(b);
    if (i >= 0 && j >= 0) { all[i] = b; all[j] = a; }
  }
  return an;
}

// Coach work items: { kind: 'root', node } reads the root position;
// { kind: 'after', base, move } the position after `move` from `base` (a
// node's own read, a check read and a pre-read are all this, and share one
// key); { kind: 'threat' | 'baseline', node } node's position with the
// opponent passing, or its parent's with the mover passing (explain.js).
export const workKey = w => w.kind === 'after' ? `${w.base.id}:after:${w.move}` : `${w.node.id}:${w.kind}`;

// The position a work item reads, as a Game recipe.
export function readRecipe(game, w) {
  if (w.kind === 'root') return game.recipe(w.node);
  if (w.kind === 'after') {
    const recipe = game.recipe(w.base);
    // The child's own colour when it exists: imported SGFs can hold variations by either side.
    const ch = w.base.children.find(c => c.move === w.move);
    recipe.moves = [...recipe.moves, [w.move, ch ? ch.color : w.base.board.toPlay]];
    // A second pass ends the game: read it played out, as Game.recipe does.
    recipe.resetPasses = w.move === PASS && w.base.board.passes >= 1;
    return recipe;
  }
  const node = w.node;
  const recipe = game.recipe(w.kind === 'threat' ? node : node.parent);
  recipe.moves = [...recipe.moves, [PASS, w.kind === 'threat' ? 3 - node.color : node.color]];
  // An imagined pass must not end the game after a real one.
  recipe.resetPasses = true;
  return recipe;
}

// Which moves the coach grades: the player's, the AI's only when asked, and
// both sides in study mode (human === 0).
export const gradesMove = (node, human, gradeAI) => !!node.parent && (!human || node.color === human || gradeAI);

// Chains in atari and with 2 liberties — for warning overlays.
export function threats(board) {
  const seen = new Set(), list = [];
  for (const p of POINTS) {
    const c = board.color[p];
    if ((c !== BLACK && c !== WHITE)) continue;
    const h = board.head[p];
    if (seen.has(h)) continue;
    seen.add(h);
    const libs = board.chainLibs(p);
    if (libs.length <= 2) list.push({ color: c, stones: board.chainStones(p), libs });
  }
  return list;
}

export function describeScore(score) {
  if (Math.abs(score) < 0.5) return 'Even';
  return `${score > 0 ? 'B' : 'W'}+${Math.abs(score).toFixed(1)}`;
}

export { ptName };
