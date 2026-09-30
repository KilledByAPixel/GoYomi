// What the coach says about a move, for the player's level: turns grades
// (coach.js) and move facts (explain.js) into sentences. Levels: 'beginner'
// (stones and liberties, no numbers), 'improving' (points, threats, purpose)
// and 'strong' (everything, tersely).
import { BLACK, WHITE, PASS, D4, ptName, ptX, ptY } from './board.js';
import { GRADES, threats } from './coach.js';
import { ladderCapture } from './ladder.js';
import { boardFacts, regionOf } from './explain.js';

export const COACH_FOR = [
  { key: 'auto', label: 'Match AI strength' },
  { key: 'beginner', label: 'Beginners' },
  { key: 'improving', label: 'Improving players' },
  { key: 'strong', label: 'Strong players' },
];

// 'auto' follows the AI level (index into LEVELS): Pebble to Sprout are for
// beginners, Reed and Stream for improving players, River and up for strong ones.
export function resolveLevel(coachFor, aiLevel) {
  if (coachFor !== 'auto') return coachFor;
  return aiLevel <= 2 ? 'beginner' : aiLevel <= 4 ? 'improving' : 'strong';
}

// The grade each level shows for each underlying grade.
const SHOWN = {
  beginner: { best: 'good', good: 'good', inaccuracy: 'good', mistake: 'mistake', blunder: 'blunder' },
  improving: { best: 'best', good: 'good', inaccuracy: 'good', mistake: 'mistake', blunder: 'blunder' },
  strong: { best: 'best', good: 'good', inaccuracy: 'inaccuracy', mistake: 'mistake', blunder: 'blunder' },
};
const BEGINNER_LABELS = { good: 'Good move', mistake: 'Mistake', blunder: 'Big mistake' };

export const gradeLabel = (key, level) => level === 'beginner' ? BEGINNER_LABELS[key] : GRADES[key].label;

// The grade as a level shows it. Flagged moves are the ones marked on the
// board, the graph and in the review.
export function levelGrade(g, level, facts = []) {
  let key = SHOWN[level][g.grade];
  // Beginners learn most from lost stones, even when few points are lost.
  if (level === 'beginner' && key === 'good' && g.grade !== 'best' && g.ptLoss >= 1 && facts.some(f => f.type === 'losesStones')) key = 'mistake';
  return { key, label: gradeLabel(key, level), color: GRADES[key].color, flagged: key !== 'best' && key !== 'good' };
}

// The sentence after the grade: how the move compares with the coach's choice.
export function verdict(g, level, shown) {
  if (g.grade === 'best') return 'Exactly the coach\'s choice.';
  const passed = g.bestMove === PASS;
  const best = passed ? '<b>passing</b>' : `<b>${ptName(g.bestMove)}</b>`;
  if (!shown.flagged) {
    return g.ptLoss < 0.5 && g.wrLoss < 0.02
      ? `About as good as the coach's choice, ${best}.`
      : `A fine move. The coach slightly preferred ${best}.`;
  }
  if (level === 'beginner') return passed ? 'The coach would have <b>passed</b>.' : `The coach would have played ${best}.`;
  if (g.ptLoss < 0.5) {
    return level === 'strong' ? `Keeps about the same score as ${best}, but the win chance drops ${Math.round(g.wrLoss * 100)}%.`
      : `About the same score as ${best}, but riskier.`;
  }
  const pts = `About <b>${g.ptLoss.toFixed(1)} points</b> worse than ${best}`;
  return level === 'strong' && g.wrLoss >= 0.01 ? `${pts} (win chance −${Math.round(g.wrLoss * 100)}%).` : `${pts}.`;
}

const colorName = c => c === BLACK ? 'Black' : 'White';
const cap = s => s[0].toUpperCase() + s.slice(1);
const count = n => n === 1 ? '1 stone' : `${n} stones`;

// Words for the players. ctx.you is the human's colour: the other side is "the
// AI" (0 in study mode, when both sides are named by colour).
const other = (c, ctx) => ctx.you ? 'the AI' : colorName(c);
function words(ctx) {
  const subj = c => c === ctx.you ? 'you' : other(c, ctx);
  const poss = c => c === ctx.you ? 'your' : `${other(c, ctx)}'s`;
  const verb = (c, plain, third) => c === ctx.you ? plain : third;
  // "White's stone at G4", "your 3 stones at C3".
  const stones = (c, list) => `${poss(c)} ${list.length === 1 ? 'stone' : `${list.length} stones`} at ${ptName(list[0])}`;
  return { subj, poss, verb, stones };
}

const REGION_NAMES = {
  beginner: ['top-left corner', 'top of the board', 'top-right corner', 'left side', 'middle', 'right side',
    'bottom-left corner', 'bottom of the board', 'bottom-right corner'],
  other: ['upper-left corner', 'upper side', 'upper-right corner', 'left side', 'centre', 'right side',
    'lower-left corner', 'lower side', 'lower-right corner'],
};

// A point's area of the board, worded for the coach level.
export const regionName = (p, level) => REGION_NAMES[level === 'beginner' ? 'beginner' : 'other'][regionOf(p)];

// After the AI's move (board: the position after it, the player to move): when
// the coach's best reply is somewhere else, the move needn't be answered. Names
// the area of the biggest move, not the point (Hint gives that). Silent when
// the reply is near the AI's stone or on a liberty of a chain touching it, when
// the AI's move left the player's stones in atari, or when the coach would pass.
export function ignoreNote(board, aiMove, an, level) {
  const top = an && an.moves && an.moves[0];
  if (!top || top.move === PASS || aiMove === PASS) return null;
  const player = board.toPlay, candidates = [top.move, ...(top.twins || [])];
  const near = q => Math.max(Math.abs(ptX(q) - ptX(aiMove)), Math.abs(ptY(q) - ptY(aiMove))) <= 2;
  if (candidates.some(near)) return null;
  for (const p of [aiMove, ...D4.map(d => aiMove + d)]) {
    const c = board.color[p];
    if (c !== BLACK && c !== WHITE) continue;
    const libs = board.chainLibs(p);
    if (c === player && libs.length === 1) return null;
    if (candidates.some(q => libs.includes(q))) return null;
  }
  return `You don't need to answer this directly. The biggest move now is around the ${regionName(top.move, level)}.`;
}

// Find it yourself: the explanation lines minus any that would give the answer
// away, i.e. that name one of `points` ("Otherwise White would play D7").
export function hideAnswer(lines, points) {
  const names = points.map(p => new RegExp(`\\b${ptName(p)}\\b`));
  return lines.filter(t => !names.some(re => re.test(t)));
}

// Why a hinted move is worth playing, when it has a tactical point: captures,
// saves, ataris, connects or cuts. Null for plain shape, which says little.
const HINT_FACTS = new Set(['capture', 'rescue', 'atari', 'connect', 'separates']);
export function hintReason(board, move, ctx) {
  if (move === PASS) return null;
  const after = board.clone();
  after.play(move);
  const facts = boardFacts(board, after, move).filter(f => HINT_FACTS.has(f.type));
  const line = facts.length ? describe(facts, { level: ctx.level, you: ctx.you, mover: board.toPlay, intent: true })[0] : null;
  return line ? `${ptName(move)}: ${line}` : null;
}

// One verb for regions of the same kind: "claims the upper side and the upper-left corner".
function regionPhrase(regions, level, w, mover) {
  const B = level === 'beginner', names = regions.map(r => REGION_NAMES[B ? 'beginner' : 'other'][r.region]);
  const the = names.join(' and the '), bare = names.join(' and ');
  const kind = regions[0].kind;
  if (kind === 'protects') return B ? `guards the ${the}` : `secures ${w.poss(mover)} ${bare}`;
  if (kind === 'reduces') return B ? `takes away some of ${w.poss(3 - mover)} area in the ${the}` : `reduces ${w.poss(3 - mover)} ${bare}`;
  return `claims the ${the}`;
}

const SHAPES = {
  contact: ['Attaches to an enemy stone (contact play).', 'Plays right next to an enemy stone.'],
  block: ['Plays against the opponent\'s stones.'],
  extend: ['Extends solidly from its own stones.'],
  diagonal: ['Diagonal move — flexible shape that is hard to cut.', 'A diagonal move: flexible and hard to cut.'],
  opening: ['Opening move staking out a big area.'],
  lowOpening: ['An opening move this low claims little space.'],
  open: ['Plays in open space.'],
};

const overlaps = (a, b) => !!a && !!b && a.some(p => b.includes(p));

// The coach's explanation of a graded move: one sentence per fact, worded for
// ctx.level. ctx.shown is the grade as shown (levelGrade), once known.
export function describe(facts, ctx) {
  const { level, mover } = ctx, opp = 3 - mover, w = words(ctx);
  const B = level === 'beginner', S = level === 'strong';
  const find = t => facts.find(f => f.type === t);
  const threat = find('threat'), init = find('initiative'), purpose = find('purpose');
  const dead = find('deadTarget'), capture = find('capture'), atari = find('atari');
  const sente = !!(init && init.sente);
  // Lines that criticise the move wait for a grade that agrees (ctx.shown).
  const flagged = !!(ctx.shown && ctx.shown.flagged);
  // A move with a tactical point isn't described by its shape.
  const tactical = !!(capture || atari || threat || find('rescue'));
  const out = [];
  for (const f of facts) {
    switch (f.type) {
      case 'pass': out.push('Passes.'); break;
      case 'capture': {
        const already = flagged && overlaps(f.stones, dead && dead.stones) ? ` that ${f.stones.length === 1 ? 'was' : 'were'} already dead` : '';
        out.push(f.ko ? 'Takes the ko.' : `Captures ${count(f.stones.length)}${already}.`);
        break;
      }
      case 'rescue': {
        if (find('hopelessRescue')) break;
        const n = f.stones.length, it = n === 1 ? 'it' : 'they', thing = n === 1 ? 'a stone' : `${n} stones`;
        if (f.libs >= 3 || (f.libs === 2 && !f.ladder)) out.push(`Saves ${thing} from atari.${B ? ` ${cap(it)} now ${n === 1 ? 'has' : 'have'} ${f.libs} liberties.` : ''}`);
        else if (f.libs === 2) out.push(`Runs from atari, but with only 2 liberties ${it} can still be chased down in a ladder.`);
        else out.push(`Tries to save ${thing}, but ${it} ${n === 1 ? 'is' : 'are'} still in atari.`);
        break;
      }
      case 'hopelessRescue':
        if (flagged) out.push(`Tries to save ${count(f.stones.length)}, but the coach expects ${f.stones.length === 1 ? 'it' : 'them'} to be captured anyway.`);
        break;
      case 'atari': {
        if (overlaps(f.stones, dead && dead.stones)) break; // the deadTarget line says it
        if (f.double) { out.push('Double atari! Threatens two groups at once.'); break; }
        if (!B && threat && overlaps(threat.what.stones, f.stones)) break; // the threat line says it
        const n = f.stones.length;
        const esc = f.trapped === 'ladder' ? ' Running away won\'t work: it\'s a ladder.' : f.trapped ? ` ${n === 1 ? 'It' : 'They'} can't escape.` : '';
        out.push(B ? `Puts ${w.stones(opp, f.stones)} in atari: ${n === 1 ? 'it has' : 'they have'} only 1 liberty left.${esc}`
          : `Atari: threatens to capture ${count(n)} next move.${esc}`);
        break;
      }
      case 'deadTarget': {
        if (overlaps(f.stones, capture && capture.stones)) break; // the capture line says it
        if (!ctx.shown || !ctx.shown.flagged) break; // a fine move needn't be told off for it
        const n = f.stones.length, it = n === 1 ? 'it' : 'them', was = n === 1 ? 'was' : 'were';
        out.push(B ? `${cap(w.stones(opp, f.stones))} ${was} already trapped, so capturing ${it} can wait. Look for a bigger move.`
          : `${cap(w.stones(opp, f.stones))} ${was} already dead: attacking ${it} gains little.`);
        break;
      }
      case 'connect': out.push(`Connects ${f.groups} groups into one.`); break;
      case 'alreadyConnected': {
        if (!ctx.shown || tactical) break; // a needless connection or a solid one depends on the grade
        const bamboo = f.via === 'bamboo';
        if (!ctx.shown.flagged) out.push(bamboo ? 'Makes the bamboo joint solid.' : 'Makes the diagonal connection solid.');
        else if (B) {
          const how = bamboo ? `: there were two gaps between them, and if ${w.subj(opp)} ${w.verb(opp, 'play', 'plays')} in one, ${w.subj(mover)} can fill the other` : ' diagonally';
          out.push(`${cap(w.poss(mover))} stones were already safely connected${how}. Filling in between them makes a clumsy shape called an empty triangle.`);
        } else out.push(`${cap(w.poss(mover))} stones were already connected ${bamboo ? 'by a bamboo joint' : 'diagonally'}, so connecting here makes an empty triangle.`);
        break;
      }
      case 'emptyTriangle':
        if (!flagged || tactical || find('alreadyConnected')) break;
        out.push(B ? 'Makes an empty triangle: three stones bunched in an L. It\'s a slow shape with few liberties.'
          : 'Makes an empty triangle, an inefficient shape.');
        break;
      case 'cut': out.push(B ? `Cuts ${w.poss(opp)} stones into separate groups, which makes them weaker.` : `Cuts ${w.poss(opp)} stones apart.`); break;
      case 'stoneLost': {
        if (!ctx.shown) break; // sacrifice or loss depends on the grade
        const it = f.stones > 1 ? 'group' : 'stone';
        if (!ctx.shown.flagged) out.push(B ? `This ${it} will probably be captured, but giving it up helps elsewhere (a sacrifice).` : `Sacrifices this ${it}: it will be captured, but it gains elsewhere.`);
        else out.push(B ? `${cap(w.subj(opp))} can capture this ${it}.` : `This ${it} is likely to be captured.`);
        break;
      }
      case 'losesStones':
        if (!ctx.shown) break; // sacrifice or loss depends on the grade
        if (!flagged) out.push(`Gives up ${w.stones(mover, f.stones)}${B ? ', but it gains more elsewhere' : ' as a sacrifice'}.`);
        else out.push(B ? `${cap(w.subj(opp))} can now capture ${w.stones(mover, f.stones)}.` : `Leaves ${w.stones(mover, f.stones)} to be captured.`);
        break;
      case 'selfAtari': {
        if (ctx.intent) break; // "careful" is advice for the mover, not about the opponent's idea
        const it = f.stones > 1 ? 'group' : 'stone';
        out.push(B ? `Careful: this ${it} now has only 1 liberty, so it can be captured.` : `Careful: this ${it} is now in atari — it can be captured.`);
        break;
      }
      case 'fewLibs': if (!ctx.intent) out.push(B ? `${cap(w.poss(mover))} group now has 2 liberties. Careful.` : 'The group has only 2 liberties — watch out for atari.'); break;
      case 'ownEye': if (!ctx.intent) out.push(B ? 'Fills its own eye. A group needs two eyes to live, so this can kill it.'
        : `Fills its own eye — usually a waste, and can kill ${mover === ctx.you ? 'your' : 'its'} own group.`); break;
      case 'separates': if (ctx.intent) out.push(`Aims to cut ${w.poss(opp)} stones apart.`); break;
      case 'shape': {
        const badShape = find('emptyTriangle') && flagged; // don't call it solid as well
        if (!threat && !purpose && !find('cut') && !(ctx.intent && find('separates')) && !badShape) out.push(SHAPES[f.shape][B ? SHAPES[f.shape].length - 1 : 0]);
        break;
      }
      case 'firstLine': if (flagged) out.push('First-line moves are usually small this early in the game.'); break;
      case 'threat': {
        const t = f.what;
        const what = t.type === 'capture' ? `capture ${w.stones(opp, t.stones)}`
          : t.type === 'atari' ? `put ${w.stones(opp, t.stones)} in atari` : `cut at ${ptName(f.move)}`;
        if (!B) out.push(`${S && sente ? 'Sente: t' : 'T'}hreatens to ${what}.`);
        else if (atari && overlaps(t.stones, atari.stones)) {
          if (sente) out.push(`${cap(w.subj(opp))} ${w.verb(opp, 'have', 'has')} to save ${atari.stones.length === 1 ? 'it' : 'them'}.`);
        } else out.push(`Threatens to ${what}${sente ? `, so ${w.subj(opp)} ${w.verb(opp, 'have', 'has')} to answer` : ''}.`);
        break;
      }
      case 'initiative':
        if (!f.sente && !B) out.push(S ? `Gote: ${w.subj(opp)} can play elsewhere.` :`${cap(w.subj(opp))} can play elsewhere without answering (gote).`);
        else if (f.sente && !purpose && level === 'improving') {
          out.push(`${cap(w.subj(opp))} ${w.verb(opp, 'have', 'has')} to answer, so ${w.subj(mover)} ${w.verb(mover, 'keep', 'keeps')} the initiative (sente).`);
        }
        break;
      case 'purpose': {
        const kinds = [...new Set(f.regions.map(r => r.kind))];
        const what = kinds.map(k => regionPhrase(f.regions.filter(r => r.kind === k), level, w, mover)).join(' and ');
        const size = B || f.value < 2 ? '' : S ? ` (+${Math.round(f.value)})` : ` (worth about ${Math.round(f.value)} points)`;
        const answered = sente && init.reply !== PASS;
        if (B) out.push(answered ? `After ${w.subj(opp)} ${w.verb(opp, 'answer', 'answers')}, this ${what}.` : `This ${what}.`);
        else if (S) out.push(answered ? `After ${ptName(init.reply)} it ${what}${size}.` : `It ${what}${size}.`);
        else out.push(answered
          ? `Once ${w.subj(opp)} ${w.verb(opp, 'answer', 'answers')} at ${ptName(init.reply)}, it ${what}${size}, and ${w.subj(mover)} ${w.verb(mover, 'get', 'gets')} to play elsewhere next (sente).`
          : `It ${what}${size}.`);
        break;
      }
      case 'otherwise':
        if (!B) out.push(S ? `Otherwise ${w.subj(opp)} ${w.verb(opp, 'play', 'plays')} ${ptName(f.move)}.` :`Otherwise ${w.subj(opp)} would play ${ptName(f.move)}.`);
        break;
    }
  }
  return out;
}

// Of describe's lines for a flagged move, the ones that say what went wrong:
// those the move's faults add (lines about shape or tactics can change with
// them, like "extends solidly" becoming "makes an empty triangle").
const FAULTS = new Set(['losesStones', 'selfAtari', 'ownEye', 'fewLibs', 'hopelessRescue', 'deadTarget', 'firstLine', 'emptyTriangle']);
export function mistakeLines(facts, ctx) {
  const plain = new Set(describe(facts.filter(f => !FAULTS.has(f.type)), ctx));
  return describe(facts, ctx).filter(t => !plain.has(t));
}

// A short note on an ungraded (AI) move: only what the player must react to.
export function describeNote(facts, ctx) {
  const opp = 3 - ctx.mover, w = words(ctx), out = [];
  for (const f of facts) {
    if (f.type === 'capture') out.push(f.ko ? 'Takes the ko.' : `Captures ${w.stones(opp, f.stones)}.`);
    else if (f.type === 'atari') out.push(f.double ? `Double atari on ${w.poss(opp)} stones!` : `${cap(w.stones(opp, f.stones))} ${f.stones.length === 1 ? 'is' : 'are'} now in atari.`);
    else if (f.type === 'cut') out.push(`Cuts ${w.poss(opp)} stones apart.`);
  }
  return out;
}

const KO = new Set(['ko', 'superko']);

// Warnings about chains in atari, checked against the rules: a capture or an
// escape that ko forbids right now is explained instead of recommended.
export function atariWarnings(board, check, names) {
  const me = board.toPlay, out = [];
  const subj = c => names.who(c) === 'You' ? 'you' : names.who(c) === 'AI' ? 'the AI' : names.who(c);
  for (const t of threats(board)) {
    if (t.libs.length !== 1) continue;
    const n = t.stones.length, where = ptName(t.stones[0]), lib = ptName(t.libs[0]);
    const stones = n > 1 ? `${n} stones at ${where} are` : `stone at ${where} is`;
    const r = check(t.libs[0]), ko = !r.ok && KO.has(r.reason);
    if (t.color === me && subj(me) === 'the AI') {
      // The AI's own stones on its turn: say what it can do, don't advise it.
      if (ko) out.push({ kind: 'warn', text: `${names.whose(t.color)} ${stones} in atari, and it can't run at ${lib} right now because of ko.` });
      else if (ladderCapture(board, t.stones[0])) out.push({ kind: 'warn', text: `${names.whose(t.color)} ${stones} in atari and can't escape: running at ${lib} leads to capture.` });
      else out.push({ kind: 'warn', text: `${names.whose(t.color)} ${stones} in atari: the AI can run at ${lib}, or capture a neighbour.` });
    } else if (t.color === me) {
      if (ko) out.push({ kind: 'warn', text: `${names.whose(t.color)} ${stones} in atari, and ${subj(me)} can't run at ${lib} right now because of ko.` });
      else if (ladderCapture(board, t.stones[0])) out.push({ kind: 'warn', text: `${names.whose(t.color)} ${stones} in atari and can't escape: running at ${lib} just leads to capture (a ladder or a dead end). Often it's better to play elsewhere.` });
      else out.push({ kind: 'warn', text: `${names.whose(t.color)} ${stones} in atari. Run at ${lib}, or capture a neighbour, to save ${n > 1 ? 'them' : 'it'}.` });
    } else if (ko) {
      const them = subj(t.color), does = them === 'you' ? 'don\'t' : 'doesn\'t';
      out.push({ kind: 'chance', text: `${names.whose(t.color)} ${stones} in atari, but ${subj(me)} can't capture at ${lib} right away because of ko. Play a strong move somewhere else first (a ko threat); if ${them} ${does} answer it, ${subj(me)} can take then.` });
    } else {
      out.push({ kind: 'chance', text: `${names.whose(t.color)} ${stones} in atari: ${subj(me)} can capture at ${lib}.` });
    }
  }
  return out;
}
