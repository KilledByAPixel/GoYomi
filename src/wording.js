// What the coach says about a move, for the player's level: turns grades
// (coach.js) and move facts (explain.js) into sentences. Levels: 'beginner'
// (stones and liberties, no numbers), 'improving' (points, threats, purpose)
// and 'strong' (everything, tersely).
import { BLACK, PASS, ptName } from './board.js';
import { GRADES } from './coach.js';

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
  if (level === 'beginner' && key === 'good' && facts.some(f => f.type === 'losesStones')) key = 'mistake';
  return { key, label: gradeLabel(key, level), color: GRADES[key].color, flagged: key !== 'best' && key !== 'good' };
}

// The sentence after the grade: how the move compares with the coach's choice.
export function verdict(g, level, shown) {
  if (g.grade === 'best') return 'Exactly the coach\'s choice.';
  const best = `<b>${ptName(g.bestMove)}</b>`;
  if (!shown.flagged) {
    return g.ptLoss < 0.5 && g.wrLoss < 0.02
      ? `About as good as the coach's choice, ${best}.`
      : `A fine move. The coach slightly preferred ${best}.`;
  }
  if (level === 'beginner') return `The coach would have played ${best}.`;
  const pts = `About <b>${g.ptLoss.toFixed(1)} points</b> worse than ${best}`;
  return level === 'strong' && g.wrLoss >= 0.01 ? `${pts} (win chance −${Math.round(g.wrLoss * 100)}%).` : `${pts}.`;
}

const colorName = c => c === BLACK ? 'Black' : 'White';
const cap = s => s[0].toUpperCase() + s.slice(1);
const count = n => n === 1 ? '1 stone' : `${n} stones`;

// Words for the players. ctx.you is the human's colour (0 in study mode, when
// both sides are named by colour).
function words(ctx) {
  const subj = c => c === ctx.you ? 'you' : colorName(c);
  const poss = c => c === ctx.you ? 'your' : `${colorName(c)}'s`;
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

function regionPhrase(r, level, w, mover) {
  const B = level === 'beginner', name = REGION_NAMES[B ? 'beginner' : 'other'][r.region];
  if (r.kind === 'protects') return B ? `guards the ${name}` : `secures ${w.poss(mover)} ${name}`;
  if (r.kind === 'reduces') return B ? `takes away some of ${w.poss(3 - mover)} area in the ${name}` : `reduces ${w.poss(3 - mover)} ${name}`;
  return `claims the ${name}`;
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
  const out = [];
  for (const f of facts) {
    switch (f.type) {
      case 'pass': out.push('Passes.'); break;
      case 'capture': {
        const already = overlaps(f.stones, dead && dead.stones) ? ` that ${f.stones.length === 1 ? 'was' : 'were'} already dead` : '';
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
        out.push(`Tries to save ${count(f.stones.length)}, but the coach expects ${f.stones.length === 1 ? 'it' : 'them'} to be captured anyway.`);
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
        const n = f.stones.length, it = n === 1 ? 'it' : 'them', was = n === 1 ? 'was' : 'were';
        out.push(B ? `${cap(w.stones(opp, f.stones))} ${was} already trapped, so capturing ${it} can wait. Look for a bigger move.`
          : `${cap(w.stones(opp, f.stones))} ${was} already dead: attacking ${it} gains little.`);
        break;
      }
      case 'connect': out.push(`Connects ${f.groups} groups into one.`); break;
      case 'cut': out.push(B ? `Cuts ${w.poss(opp)} stones into separate groups, which makes them weaker.` : `Cuts ${w.poss(opp)} stones apart.`); break;
      case 'stoneLost': {
        if (!ctx.shown) break; // sacrifice or loss depends on the grade
        const it = f.stones > 1 ? 'group' : 'stone';
        if (!ctx.shown.flagged) out.push(B ? `This ${it} will probably be captured, but giving it up helps elsewhere (a sacrifice).` : `Sacrifices this ${it}: it will be captured, but it gains elsewhere.`);
        else out.push(B ? `${cap(w.subj(opp))} can capture this ${it}.` : `This ${it} is likely to be captured.`);
        break;
      }
      case 'losesStones':
        out.push(B ? `${cap(w.subj(opp))} can now capture ${w.stones(mover, f.stones)}.` : `Leaves ${w.stones(mover, f.stones)} to be captured.`);
        break;
      case 'selfAtari': {
        const it = f.stones > 1 ? 'group' : 'stone';
        out.push(B ? `Careful: this ${it} now has only 1 liberty, so it can be captured.` : `Careful: this ${it} is now in atari — it can be captured.`);
        break;
      }
      case 'fewLibs': out.push(B ? `${cap(w.poss(mover))} group now has 2 liberties. Careful.` : 'The group has only 2 liberties — watch out for atari.'); break;
      case 'ownEye': out.push(B ? 'Fills its own eye. A group needs two eyes to live, so this can kill it.' : 'Fills its own eye — usually a waste, and can kill your own group.'); break;
      case 'shape': if (!threat && !purpose && !find('cut')) out.push(SHAPES[f.shape][B ? SHAPES[f.shape].length - 1 : 0]); break;
      case 'firstLine': out.push('First-line moves are usually small this early in the game.'); break;
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
        if (!f.sente && !B) out.push(S ? `Gote: ${colorName(opp)} can play elsewhere.` : `${cap(w.subj(opp))} can play elsewhere without answering (gote).`);
        else if (f.sente && !purpose && level === 'improving') {
          out.push(`${cap(w.subj(opp))} ${w.verb(opp, 'have', 'has')} to answer, so ${w.subj(mover)} ${w.verb(mover, 'keep', 'keeps')} the initiative (sente).`);
        }
        break;
      case 'purpose': {
        const what = f.regions.map(r => regionPhrase(r, level, w, mover)).join(' and ');
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
        if (!B) out.push(S ? `Otherwise ${colorName(opp)} plays ${ptName(f.move)}.` : `Otherwise ${w.subj(opp)} would play ${ptName(f.move)}.`);
        break;
    }
  }
  return out;
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
