// Teaching logic that sits on top of search results: AI strength levels,
// move choice, when to pass, dead stones, move grading and plain-language
// explanations. Pure functions — no DOM, testable in node.
import { BLACK, WHITE, EMPTY, EDGE, PASS, POINTS, D4, DIAG, N, ptX, ptY, ptName } from './board.js';

export const LEVELS = [
  { name: 'Pebble', blurb: 'Plays almost randomly nearby. Good for learning captures.', playouts: 120, temp: 1, blunder: 0.25 },
  { name: 'Sprout', blurb: 'Knows captures and simple shapes, misses a lot.', playouts: 400, temp: 1.5, blunder: 0.12 },
  { name: 'Stream', blurb: 'Casual player. Makes real mistakes.', playouts: 1500, temp: 2.5, blunder: 0.05 },
  { name: 'River', blurb: 'Solid club-level fighting on a small board.', playouts: 5000, temp: 5, blunder: 0 },
  { name: 'Mountain', blurb: 'Strong. Punishes overplays.', playouts: 16000, temp: 0, blunder: 0 },
  { name: 'Dragon', blurb: 'Full strength (thinks for several seconds).', playouts: 60000, temp: 0, blunder: 0 },
];

const sign = c => c === BLACK ? 1 : -1;

// Picks the AI's move from finished search results.
// Weaker levels sample among the explored moves instead of taking the best.
export function chooseMove(results, level, rand = Math.random) {
  const moves = (results.allMoves || results.moves).filter(m => m.move !== PASS);
  if (!moves.length) return PASS;
  const top = moves[0];
  if (level.blunder && rand() < level.blunder && moves.length > 3) {
    // An honest beginner blunder: any move the search looked at a little.
    const pool = moves.filter(m => m.visits >= 2);
    return pool[(rand() * pool.length) | 0].move;
  }
  if (!level.temp) return top.move;
  // Sample proportional to visits^temp among reasonable candidates.
  const pool = moves.filter(m => m.visits >= top.visits * 0.05);
  const weights = pool.map(m => Math.pow(m.visits, level.temp));
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) if ((r -= weights[i]) <= 0) return pool[i].move;
  return top.move;
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
  if (isSettled(board, own)) return true;
  if (board.lastMove === PASS && board.moveCount > 0) {
    // Opponent passed: pass too if we'd win the count as the board stands.
    // Also pass when the count as it stands already matches what the search
    // expects at the end — nothing left to gain (covers dame and seki).
    const s = game.score(estimateDead(board, own));
    const winning = s.winner === aiColor;
    if (winning && (isSettled(board, own, 0.5) || Math.abs(s.margin - results.score) < 2.5)) return true;
  }
  return false;
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

// Grades the move from `before` (analysis of the parent, mover to play) to
// `after` (analysis of the position after the move).
export function gradeMove(before, after, move) {
  if (!before || !after || !before.moves || !before.moves.length) return null;
  const mover = before.toPlay;
  const best = bestOf(before);
  const wrAfter = 1 - after.winrate;
  const scoreAfter = after.score * sign(mover);
  // Take the better of "as seen from before" and "as seen from after" for the
  // played move, so a move the first search barely looked at isn't unfairly judged.
  const seen = before.moves.find(m => m.move === move && m.visits >= 30);
  const wr = seen ? Math.max(wrAfter, Math.min(seen.winrate, wrAfter + 0.1)) : wrAfter;
  const sc = seen ? Math.max(scoreAfter, Math.min(seen.score * sign(mover), scoreAfter + 3)) : scoreAfter;
  const wrLoss = Math.max(0, best.winrate - wr);
  const ptLoss = Math.max(0, best.score - sc);
  let grade;
  if (move === best.move) grade = 'best';
  else if (ptLoss < 1.5 && wrLoss < 0.05) grade = 'good';
  else if (ptLoss < 4 && wrLoss < 0.12) grade = 'inaccuracy';
  else if (ptLoss < 10 && wrLoss < 0.3) grade = 'mistake';
  else grade = 'blunder';
  // A hopeless or totally won game: winrate barely moves; trust points more.
  if (grade !== 'best' && ptLoss < 1.5 && (best.winrate > 0.97 || best.winrate < 0.03)) grade = 'good';
  const alternatives = before.moves.slice(0, 3).filter(m => m.move !== move && m.visits >= before.moves[0].visits * 0.2);
  return { grade, wrLoss, ptLoss, bestMove: best.move, bestWinrate: best.winrate, winrate: wr, alternatives, mover };
}

// ------------------------------------------------------------ explanations

function chainLibsAfterMove(b, p) { return b.libCount(p); }

// Describes what a move does tactically, comparing the board before and after.
// before/after are Board objects; returns an array of short sentences.
export function explainMove(before, after, move, ownBefore, ownAfter) {
  const out = [];
  if (move === PASS) return ['Passes.'];
  const c = before.toPlay, o = 3 - c;
  const who = c === BLACK ? 'Black' : 'White';
  const x = ptX(move), y = ptY(move);
  const height = Math.min(x, y, N - 1 - x, N - 1 - y);

  const captured = POINTS.filter(p => before.color[p] === o && after.color[p] === EMPTY);
  const wasKo = captured.length === 1 && after.ko;
  if (captured.length) out.push(wasKo ? 'Takes the ko.' : `Captures ${captured.length} stone${captured.length > 1 ? 's' : ''}.`);

  // Friendly chains that were in atari next to the move.
  const rescued = new Set();
  for (const d of D4) {
    const q = move + d;
    if (before.color[q] === c && before.inAtari(before.head[q])) rescued.add(before.head[q]);
  }
  const newLibs = chainLibsAfterMove(after, move);
  if (rescued.size) {
    const n = [...rescued].reduce((s, h) => s + before.size[h], 0);
    out.push(newLibs >= 2 ? `Saves ${n} stone${n > 1 ? 's' : ''} that were in atari.` :
      `Tries to save ${n} stone${n > 1 ? 's' : ''} in atari, but they are still in atari.`);
  }

  // Enemy chains now in atari (that weren't before).
  const seen = new Set();
  let atariCount = 0, atariStones = 0;
  for (const d of D4) {
    const q = move + d;
    if (after.color[q] !== o) continue;
    const h = after.head[q];
    if (seen.has(h)) continue;
    seen.add(h);
    if (after.inAtari(h) && !before.inAtari(before.head[q])) { atariCount++; atariStones += after.size[h]; }
  }
  if (atariCount) {
    out.push(atariCount > 1 ? `Double atari! Threatens two groups at once.` :
      `Atari: threatens to capture ${atariStones} stone${atariStones > 1 ? 's' : ''} next move.`);
  }

  // Connections and cuts.
  const friendHeads = new Set(), enemyHeads = new Set();
  for (const d of D4) {
    const q = move + d;
    if (before.color[q] === c) friendHeads.add(before.head[q]);
    if (before.color[q] === o) enemyHeads.add(before.head[q]);
  }
  if (friendHeads.size >= 2) out.push(`Connects ${friendHeads.size} groups into one.`);
  if (enemyHeads.size >= 2 && !captured.length) out.push('Keeps two enemy groups apart (a cut).');

  if (newLibs === 1 && !captured.length) out.push(`Careful: this ${after.size[after.head[move]] > 1 ? 'group' : 'stone'} is now in atari — it can be captured.`);
  else if (newLibs === 2 && after.size[after.head[move]] >= 3 && !rescued.size) out.push('The group has only 2 liberties — watch out for atari.');

  if (before.isEyeish(move, c)) out.push('Fills its own eye — usually a waste, and can kill your own group.');

  if (!out.length) {
    if (enemyHeads.size && !friendHeads.size) out.push('Attaches to an enemy stone (contact play).');
    else if (friendHeads.size && enemyHeads.size) out.push('Blocks / pushes against the opponent.');
    else if (friendHeads.size) out.push('Extends solidly from its own stones.');
    else {
      let diagFriend = false;
      for (const d of DIAG) if (before.color[move + d] === c) diagFriend = true;
      if (diagFriend) out.push('Diagonal move — flexible shape that is hard to cut.');
      else if (before.moveCount < 6) out.push(height >= 2 ? 'Opening move staking out a big area.' : 'An opening move this low claims little space.');
      else out.push('Plays in open space.');
    }
  }
  if (height === 0 && before.moveCount < 20 && !captured.length && !rescued.size && !atariCount) {
    out.push('First-line moves are usually small this early in the game.');
  }

  if (ownBefore && ownAfter) {
    let gain = 0;
    for (let i = 0; i < POINTS.length; i++) gain += (ownAfter[i] - ownBefore[i]) * sign(c);
    // Ownership totals count both sides, so the swing in points is about half the sum.
    const pts = gain / 2;
    if (pts >= 3) out.push(`Swings about ${pts.toFixed(0)} points of area to ${who}.`);
  }
  return out;
}

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
