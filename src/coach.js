// Teaching logic that sits on top of search results: AI strength levels,
// move choice, when to pass, dead stones, move grading and plain-language
// explanations. Pure functions — no DOM, testable in node.
import { BLACK, WHITE, PASS, POINTS, ptName } from './board.js';

// Each level beat the one below it clearly in self-play (tools/levels.js).
export const LEVELS = [
  { name: 'Pebble', blurb: 'Plays almost at random. Practise capturing.', playouts: 50, temp: 1, blunder: 0.3 },
  { name: 'Seedling', blurb: 'Grabs captures, wanders a lot.', playouts: 220, temp: 1.2, blunder: 0.14 },
  { name: 'Sprout', blurb: 'Knows simple shapes, still misses plenty.', playouts: 400, temp: 1.5, blunder: 0.1 },
  { name: 'Reed', blurb: 'Fights back, but leaves weaknesses.', playouts: 650, temp: 1.8, blunder: 0.08 },
  { name: 'Stream', blurb: 'Casual player. Makes real mistakes.', playouts: 2000, temp: 3, blunder: 0.03 },
  { name: 'River', blurb: 'Solid fighting on a small board.', playouts: 5000, temp: 5, blunder: 0 },
  { name: 'Mountain', blurb: 'Strong. Punishes overplays.', playouts: 16000, temp: 0, blunder: 0 },
  { name: 'Dragon', blurb: 'Full strength. Thinks for several seconds.', playouts: 60000, temp: 0, blunder: 0 },
];

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
  const best = (results.allMoves || results.moves)[0];
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

// The position a coach read looks at, as a Game recipe, for node's move:
// 'pos' node's position; 'check' the parent position after `move` (to check
// node's grade against); 'threat' node's position with the opponent passing;
// 'baseline' the parent position with the mover passing (explain.js).
export function readRecipe(game, node, kind, move) {
  if (kind === 'pos') return game.recipe(node);
  const recipe = game.recipe(kind === 'threat' ? node : node.parent);
  const extra = kind === 'check' ? [move, node.color] : [PASS, kind === 'threat' ? 3 - node.color : node.color];
  recipe.moves = [...recipe.moves, extra];
  // An imagined pass must not end the game after a real one.
  if (kind !== 'check') recipe.resetPasses = true;
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
