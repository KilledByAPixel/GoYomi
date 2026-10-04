// GoYomi controller: wires the game record, the opponent engine, the coach
// engine and the board view together.
import { BLACK, WHITE, EMPTY, PASS, POINTS, ptName } from './board.js';
import { Game, reasonText, colorName } from './game.js';
import { Engine, EnginePool, KataWorker, KataEngine, KataPool, MIN_RATE, effort } from './engine-client.js';
import { LEVELS, LEVEL_BATCH, nextLevel, keyMoments, skippedPoint, topChoices, earlyPass, chooseMove, chooseKataMove, shouldPass, estimateDead, gradeMove, reviewNeeded, entryFor, preferUsefulMove, readRecipe, workKey, gradesMove, GRADES, threats, describeScore } from './coach.js';
import { boardFacts, cachedFacts } from './explain.js';
import { COACH_FOR, resolveLevel, gradeLabel, levelGrade, verdict, describe, describeNote, atariWarnings, ignoreNote, hintReason, regionName, hideAnswer, mistakeLines, missedLine } from './wording.js';
import { BoardView } from './view.js';
import { linkPoints, pointReadout, movePhrase, plainText, positionPhrase, resultPhrase } from './access.js';
import { initAnnouncer, announce, speak, hush, setSpeech, repeatLast, speechAvailable } from './announce.js';
import { renderGraph } from './graph.js';
import { safeStorage } from './storage.js';
import { stoneSound, playSound, setSoundEnabled, SOUNDS, ZZFXSound } from './sound.js';

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STORE = 'goYomi.v1';
const OLD_STORE = 'goDojo.v1'; // autosaves from before the rename
// Every save and load goes through this: in memory when the browser's storage is blocked.
const storage = safeStorage(() => localStorage);

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
  level: 2,
  komi: 7,
  handicap: 0,
  coach: true,
  coachPlayouts: 48000,
  coachEngine: 'katago',     // 'katago' or 'builtin'
  gradeAI: false,
  findYourself: false,
  ladder: true,              // after each game against the AI, move its level up for a win, down for a loss
  lastHuman: BLACK,          // how the player played before loading a game into study mode (0: study)
  studyFromImport: false,    // study mode came from loading a game, not from New game
  coachFor: 'auto',
  speak: false,
  sound: true,
  show: { liberties: true, atari: true, territory: false, preview: true, feedback: true, hints: false, numbers: false },
};

let settings = structuredClone(DEFAULTS);
let game = null;
let mode = 'play';           // 'play' | 'score'
let scoring = null;          // { node, dead: Set, pending }
let resigned = 0;            // colour that resigned
let hoverPt = null;
let hoverByKey = false;      // hoverPt is the keyboard cursor, whose readout already says why a point can't be played
let hintOn = false;
let warningsSaid = null;     // the position and atari warnings last read out
let passWarned = null;       // the position whose too-early pass was warned about: Pass now reads "Pass anyway"
let peek = null;             // { node, move, pv } — the coach's move previewed from a Try button (hover or focus)
let armed = null;            // the graded move whose Try was clicked once: its preview stays, the button says Play
let swallowClick = false;    // a board click that only ended an armed preview
let lastPointer = '';        // the last pointer used (mouse, touch, pen), or '' after a key
let ending = false;          // ending a preview: the redraw's focus restore mustn't start it again
let flashMsg = null, flashTimer = 0;
let aiNode = null, aiToken = 0;
let aiBest = false;          // the current AI search is the "AI move" button's full-strength move
let aiForce = false;         // ...and was asked for even though it isn't the AI's turn
let coachJobs = [];          // per coach engine: the work item it is reading (see coachQueue)
let restoreScoring = null;   // a counting screen to reopen after loading
let locatePt = null;         // a point the player is hovering in the coach's text
let threat = null;           // { node, pending | none | move, pv, facts, cost } — opponent's idea

const COACHES = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
const builtin = {
  opponent: new Engine('opponent'),
  // Coach engines, one position each; pooled (root stats merged) only for the quick dead-stone read.
  coach: new EnginePool('coach', COACHES),
  // Answers "what would the opponent play if I passed?"
  scout: new Engine('scout'),
};
// The KataGo network, in one worker shared by its engines; started when first wanted.
const kata = { state: 'off', host: null, opponent: null, coach: null, scout: null, info: null };
// The engines the coach reads with: KataGo's once it's ready (if chosen), else the built-in ones.
let coach = builtin.coach, scout = builtin.scout;
Engine.onError = (name, msg) => flash(`The ${name} engine stopped working (${msg}). It restarts by itself on the next move (press AI move to try again); if it keeps happening, reload the page or try a current Chrome, Firefox or Safari.`, 'bad');
const view = new BoardView($('#board'), { onClick, onHover, onCursor });

// The keyboard cursor moved: say what's there.
function onCursor(p) {
  announce(pointReadout(game.current.board, p, q => game.check(q), mode === 'score' && scoring ? scoring.dead : null), { cursor: true });
}

// ------------------------------------------------------------------ helpers

const aiColor = () => settings.human ? 3 - settings.human : 0;
const level = () => LEVELS[settings.level];
const aiLabel = () => `AI (${level().name})`;
const who = c => !settings.human ? colorName(c) : c === settings.human ? 'You' : 'AI';
const whose = c => !settings.human ? `${colorName(c)}'s` : c === settings.human ? 'Your' : 'AI\'s';
const fmtK = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
const plural = (n, w) => `${n} ${n === 1 ? w : w.replace(/y$/, 'ie') + 's'}`;
const cap = s => s[0].toUpperCase() + s.slice(1);
const coachLevel = () => resolveLevel(settings.coachFor, settings.level);

function isAITurn(node = game.current) {
  const ai = aiColor();
  return mode === 'play' && !resigned && ai && node.board.toPlay === ai && !game.isOver(node) && node.children.length === 0;
}

function flash(text, kind = '') {
  flashMsg = { text, kind };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashMsg = null; renderStatus(); }, 5000);
  renderStatus();
  speak(text);
}

// ------------------------------------------------------------------ engines

const coachKind = () => coach === kata.coach ? 'katago' : 'builtin';
const kindOf = results => results && results.engine === 'katago' ? 'katago' : 'builtin';
// The coach waits for KataGo while it loads; resolves once it's settled either way.
const kataSettled = () => settings.coachEngine === 'katago' && kata.state === 'loading' ? kata.host.ready : null;

// A failure's reason in plain words, without file names or web addresses.
function plainReason(message = '') {
  if (/fetch|import|HTTP|network file|load/i.test(message)) return 'a file it needs didn\'t download';
  if (/too long/i.test(message)) return 'it took too long to start';
  return message.replace(/\s*\(?https?:\/\/\S+\)?/g, '').trim() || 'an unknown error';
}

function startKata() {
  if (kata.state !== 'off') return;
  kata.state = 'loading';
  kata.host = new KataWorker();
  // The AI's move outranks the coach's background reads on the shared network.
  kata.opponent = new KataEngine('kopponent', kata.host, { priority: 1 });
  kata.host.onFail = message => {
    kata.state = 'failed';
    kata.info = kata.host.info;
    flash(`KataGo stopped working (${plainReason(message)}), so the AI and coach use GoYomi's own engine, which is much weaker and slower.`);
    useCoachEngine();
    // A move KataGo was thinking about is played by the built-in engine instead.
    // Same request (the "AI move" button's too), if the position hasn't changed.
    if (aiNode) {
      const node = aiNode, force = aiForce, best = aiBest;
      cancelAI();
      setTimeout(() => { if (game.current === node) aiMove(force, best); }, 0);
    }
  };
  kata.coach = new KataPool('kcoach', COACHES, kata.host);
  kata.scout = new KataEngine('kscout', kata.host);
  kata.host.load().then(info => {
    kata.info = info;
    // Too slow to read positions in a few seconds: the built-in engine coaches better.
    kata.state = info.ok && info.rate >= MIN_RATE ? 'ready' : 'failed';
    if (kata.state === 'failed') {
      flash(info.ok ? `KataGo runs too slowly on this device (${Math.round(info.rate)} positions a second), so the AI and coach use GoYomi's own engine, which is much weaker and slower.`
        : `KataGo couldn't start here (${plainReason(info.message)}), so the AI and coach use GoYomi's own engine, which is much weaker and slower. On a slow connection, reloading the page may fix it.`);
    }
    useCoachEngine();
  });
  renderEngineInfo();
}

// Points the coach at the engine the settings ask for. Reads from the other
// engine are dropped: grades compare two reads, which must come from one engine.
function useCoachEngine() {
  startKata(); // every AI level plays with KataGo, so it always loads
  const want = settings.coachEngine === 'katago' && kata.state === 'ready' ? kata : builtin;
  if (want.coach !== coach) {
    stopCoach();
    scout.cancel();
    threat = null;
    coach = want.coach; scout = want.scout;
    rereadAll();
  }
  renderEngineInfo();
  scheduleCoach();
  render();
}

// Forgets the coach's reads so every position is read again.
function rereadAll() {
  const reset = n => { n.analysisDone = false; n.analysis = null; n.after = null; n.reads = null; n.checkMove = null; n.grade = null; n.children.forEach(reset); };
  reset(game.root);
}

function renderEngineInfo() {
  const el = $('#engineInfo');
  if (!el) return;
  const i = kata.info;
  el.textContent = settings.coachEngine !== 'katago'
    ? `The coach uses GoYomi's own Monte-Carlo engine. ${kata.state === 'ready' ? 'The AI plays with KataGo.' : kata.state === 'loading' ? 'Loading KataGo for the AI…' : 'The AI uses it too: KataGo isn\'t available here.'}`
    : kata.state === 'loading' ? 'Loading KataGo…'
    : kata.state === 'ready' ? `KataGo on ${i.backend.toUpperCase()}, ${Math.round(i.rate)} positions a second.`
    : kata.state === 'failed' ? (i && i.ok ? `KataGo is too slow here (${Math.round(i.rate)} positions a second); using the built-in engine.` : 'KataGo isn\'t available here; using the built-in engine.')
    : '';
}

function pvStones(color, moves) {
  return moves.map((move, i) => ({ move, color: i % 2 ? 3 - color : color }));
}

// ------------------------------------------------------------------ game flow

function newGame() {
  passWarned = null; // any change of position ends a pass warning
  resetCoachHeight();
  cancelAI();
  stopCoach();
  game = new Game({ komi: settings.komi, handicap: settings.handicap });
  mode = 'play'; scoring = null; resigned = 0; peek = null; armed = null; hintOn = false;
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

// human: the player's own move, which cuts off anything still being spoken.
// news: shown and said in place of the usual move announcement (passes).
function playMove(move, { human = false, news = '' } = {}) {
  passWarned = null; // any change of position ends a pass warning
  const parent = game.current;
  const r = game.check(move);
  if (!r.ok) { flash(reasonText(r.reason), 'bad'); playSound('illegal'); return false; }
  if (human) hush(); // a new move: they're done listening
  // Playing on from a tried coach move keeps that line: no more "Back to my move".
  if (human) for (let n = parent, k = 0; n && k < 2; n = n.parent, k++) delete n.backTo;
  const regrade = !!(parent.children.find(c => c.move === move) || {}).grade;
  const node = game.play(move);
  if (news) flash(news);
  else {
    // Say the move; for ungraded (AI) moves add what the player must react to.
    const note = isGraded(node) ? [] : describeNote(factsFor(node).filter(f => f.type !== 'capture'), { mover: node.color, you: settings.human });
    announce([movePhrase(who(node.color), move, node.captured.length), ...note].join(' '));
  }
  hintOn = false; peek = null; armed = null;
  if (move === PASS) playSound('pass'); else stoneSound(node.captured.length, !!aiColor() && node.color === aiColor());
  if (!node.analysisDone) adoptAfterRead(node);
  tryGrade(node);
  if (regrade && isGraded(node)) { node.announced = false; announceGrade(node); }
  if (game.isOver()) { save(); enterScoring(); return true; }
  afterChange();
  // Replaying a move that already has a (taken-back) AI reply below it: the
  // node isn't a leaf, but the AI should still answer.
  if (aiColor() && !resigned && game.toPlay === aiColor() && mode === 'play') aiMove(true);
  return true;
}

function onClick(p) {
  if (swallowClick) { swallowClick = false; return; }
  if (armed) { disarm(); return; } // (keyboard) the board only ends the preview
  if (mode === 'score') { toggleDead(p); return; }
  if (aiNode) { flash('Hold on, the AI is thinking…'); return; }
  const node = game.current;
  if (game.isOver(node)) { flash('Both players passed. The game is over.'); return; }
  // After resigning the game is over: moves explore it, for either side, and the AI stays quiet.
  // Earlier in the game, where the AI moved next, you can try a move for it too; only
  // the end of the line waits for the AI.
  const ai = aiColor();
  if (ai && !resigned && node.board.toPlay === ai && !node.children.length) {
    flash('It\'s the AI\'s turn in this position. Press "AI move" to let it play, or step back.');
    return;
  }
  playMove(p, { human: true });
}

function onHover(p, byKey = false) {
  hoverPt = p; hoverByKey = byKey;
  renderBoard();
  renderStatus();
}

function humanPass() {
  if (mode !== 'play' || aiNode || game.isOver() || resigned) return;
  if (aiColor() && !resigned && game.toPlay === aiColor()) return;
  // Clearly too early (plenty still undecided): warn once; Pass again passes.
  const node = game.current;
  // The coach's read so far is enough: a quick pass right after the AI's move is the one to catch.
  const early = settings.coach && node.analysis && passWarned !== node ? earlyPass(node.board, node.analysis) : null;
  if (early) {
    passWarned = node;
    flash(`Too early to pass: about ${early.undecided} points are still undecided, for example around the ${regionName(early.move, coachLevel())}. Press Pass again to pass anyway.`);
    render();
    return;
  }
  playMove(PASS, { human: true, news: `${who(game.toPlay)} passed.` });
}

function takeBack() {
  passWarned = null; // any change of position ends a pass warning
  // Nothing to take back at the start: leave the AI's first move alone.
  if (!game.current.parent && !resigned) return;
  if (mode === 'score') exitScoring();
  cancelAI();
  peek = null; armed = null; hintOn = false;
  // The first take back after resigning withdraws the resignation.
  if (resigned) { resigned = 0; flash('Resignation withdrawn. Play on!'); afterChange(); return; }
  playSound('undo');
  game.undo();
  const ai = aiColor();
  if (ai && !resigned) while (game.current.parent && game.toPlay === ai) game.undo();
  render();
  announce(positionPhrase(game.current.depth, game.current.color, game.current.move));
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
  // The coach's moves show once you've resigned: taking it back doesn't hide them again.
  for (const n of game.line()) if (n.grade && n.color === settings.human) { n.revealed = true; n.parent.helped = true; }
  playSound('lose');
  flash('You resigned. No shame in that — step back through the game to see where it turned.');
  const next = ladderSentence();
  if (next) announce(next);
  afterChange();
}

// Shows what the opponent wants to play: search the position as if the side to move passed.
async function toggleThreat() {
  const node = game.current;
  if (threat && threat.node === node) { threat = null; scout.cancel(); render(); return; }
  if (mode !== 'play' || game.isOver(node)) return;
  const me = node.board.toPlay, opp = 3 - me;
  const recipe = game.recipe(node);
  recipe.moves = [...recipe.moves, [PASS, me]];
  recipe.resetPasses = true; // the imagined pass must not end the game after a real pass
  const mine = threat = { node, pending: true };
  // Still wanted: not cleared (Esc), not superseded, and still on this position.
  // An answer for a position the player has left is dropped without a word.
  const current = () => {
    if (threat !== mine) return false;
    if (game.current === node && mode === 'play') return true;
    threat = null;
    return false;
  };
  render();
  await kataSettled();
  if (!current()) return;
  const res = await scout.search(recipe, { playouts: 8000, reportMs: 0 });
  if (!current()) return;
  if (res) preferUsefulMove(res);
  const m = res && res.moves.find(x => x.move !== PASS);
  if (!m) {
    threat = res ? { node, none: true } : null;
    render();
    if (res) announce('The opponent has nothing urgent here.');
    return;
  }
  const passed = node.board.clone();
  passed.play(PASS);
  const after = passed.clone();
  after.play(m.move);
  const sgn = me === BLACK ? 1 : -1;
  const cost = node.analysis ? (node.analysis.score - res.score) * sgn : null;
  threat = { node, opp, me, move: m.move, pv: pvStones(opp, [m.move, ...(m.pv || [])]), facts: boardFacts(passed, after, m.move), cost };
  render();
  // Read out what the box says, without its how-to line.
  announce(plainText([...$('#threatBox').children].filter(el => !el.classList.contains('muted')).map(el => el.innerHTML).join(' ')));
}

// ------------------------------------------------------------------ AI opponent

function cancelAI() {
  aiToken++;
  if (aiNode) { builtin.opponent.cancel(); if (kata.opponent) kata.opponent.cancel(); aiNode = null; }
}

// The engine for an AI move: KataGo whenever it runs here (every level uses
// it; the "AI move" button follows the coach's engine), else the built-in one.
async function aiEngine(best) {
  if (best && settings.coachEngine !== 'katago') return builtin.opponent;
  startKata();
  if (kata.state === 'loading') await kata.host.ready;
  return kata.state === 'ready' ? kata.opponent : builtin.opponent;
}

// force: play even when it isn't the AI's turn (the "AI move" button, replays).
// best: play the coach's best move at full strength instead of the level's
// sampled move, reusing the coach's reading of this position when it has one.
async function aiMove(force = false, best = false) {
  const node = game.current;
  if (aiNode || mode !== 'play' || game.isOver(node)) return;
  if (!force && !isAITurn(node)) return;
  const token = ++aiToken;
  const color = node.board.toPlay;
  const lv = best ? { playouts: settings.coachPlayouts, temp: 0, blunder: 0 } : level();
  aiNode = node; aiBest = best; aiForce = force;
  if (best) node.helped = true; // the "AI move" button plays the coach's move: not found by the player
  render();
  const t0 = performance.now();
  const opponent = await aiEngine(best);
  if (token !== aiToken) return;
  const kind = opponent === builtin.opponent ? 'builtin' : 'katago';
  // Without KataGo each level plays as its built-in namesake (Phoenix as Dragon).
  const onKata = !best && kind === 'katago';
  const budget = onKata ? { visits: lv.kata.visits, batch: LEVEL_BATCH } : { playouts: lv.playouts };
  let results = best && node.analysisDone && kindOf(node.analysis) === kind ? node.analysis
    : await opponent.search(game.recipe(node), { ...budget, maxTime: onKata && lv.maxTime ? lv.maxTime : 15000, reportMs: 0 });
  if (token !== aiToken) return;
  // A read started before the coach depth changed still picks the move, but isn't the analysis.
  if (best && results && !node.analysisDone && lv.playouts === settings.coachPlayouts && kind === coachKind()) { node.analysis = preferUsefulMove(results); node.analysisDone = true; tryGrade(node); }
  // When the human has passed, decide about passing with a deeper look.
  let passInfo = results;
  if (results && node.board.lastMove === PASS && node.parent) {
    if (node.analysisDone && kindOf(node.analysis) === kind && effort(node.analysis) > effort(results)) passInfo = node.analysis;
    else if (effort(results) < 4000) passInfo = await opponent.search(game.recipe(node), onKata ? { visits: 33, batch: LEVEL_BATCH, reportMs: 0 } : { playouts: 4000, reportMs: 0 });
    if (token !== aiToken) return;
  }
  const wait = 450 - (performance.now() - t0);
  if (wait > 0) await sleep(wait);
  if (token !== aiToken) return;
  aiNode = null;
  if (!results || !passInfo || game.current !== node) { render(); return; }
  if (!node.analysis && effort(results) >= 1500 && kindOf(results) === coachKind()) node.analysis = results;
  let move = shouldPass(game, passInfo, color) ? PASS : onKata ? chooseKataMove(results, lv.kata) : chooseMove(results, lv);
  if (move !== PASS && !game.check(move).ok) {
    move = (results.allMoves || results.moves).map(m => m.move).find(m => m !== PASS && game.check(m).ok) ?? PASS;
  }
  let news = '';
  if (move === PASS) {
    const who = best ? 'The coach' : aiLabel();
    news = node.board.lastMove === PASS ? `${who} passes too.` : `${who} passes. If you think the game is finished, pass as well.`;
  }
  playMove(move, { news });
}

// ------------------------------------------------------------------ coach

const isGraded = node => gradesMove(node, settings.human, settings.gradeAI);
// A read of the position after `move` from node's parent: stored there (the
// child's own read, a pre-read or a check), or a variation that was read.
const checkRead = (node, move) => node.parent.after && node.parent.after.get(move) ||
  (node.parent.children.find(ch => ch.move === move && ch.analysisDone) || {}).analysis;

// A new node whose position was already read (a pre-read or a check) takes that read.
function adoptAfterRead(node) {
  const an = node.parent && node.parent.after && node.parent.after.get(node.move);
  if (!an) return false;
  node.analysis = an;
  node.analysisDone = true;
  return true;
}

// A node's outstanding grading work, most urgent first.
function coachWork(node, out, ahead) {
  if (!node) return;
  if (!node.analysisDone) {
    if (adoptAfterRead(node)) tryGrade(node);
    else out.push(node.parent ? { kind: 'after', base: node.parent, move: node.move } : { kind: 'root', node });
  }
  if (!node.parent || !isGraded(node)) return;
  if (node.checkMove != null) out.push({ kind: 'after', base: node.parent, move: node.checkMove });
  // Moves other than the coach's choice often need the check read against it:
  // start it early, on a spare engine, so the grade doesn't wait for two reads.
  else if (ahead && !node.grade && node.parent.analysisDone) {
    const e = entryFor(node.parent.analysis, node.move), best = node.parent.analysis.moves[0];
    if (best && best.move !== PASS && e !== best && !checkRead(node, best.move)) out.push({ kind: 'after', base: node.parent, move: best.move });
  }
}

// The threat and baseline reads behind a graded move's explanation (explain.js).
function explainWork(node, out) {
  if (!node || !node.parent || node.move === PASS || !isGraded(node)) return;
  const r = node.reads || {};
  if (!r.threat) out.push({ kind: 'threat', node });
  if (!r.baseline) out.push({ kind: 'baseline', node });
}

// While the player thinks, read the positions after the coach's top moves:
// if the player picks one, its grade (and usually the check) is ready.
function preWork(node, out) {
  if (!node.analysisDone || mode !== 'play' || resigned || game.isOver(node)) return;
  if (aiColor() && node.board.toPlay === aiColor()) return;
  for (const m of node.analysis.moves.filter(x => x.move !== PASS).slice(0, 3)) {
    if (!node.after || !node.after.has(m.move)) out.push({ kind: 'after', base: node, move: m.move });
  }
}

// The coach's to-do list: grading the current move and the one before it,
// explaining them (they're what the coach panel shows), reading ahead for the
// player's next move, then grading the rest of the game outwards from here.
function coachQueue(max) {
  const cur = game.current, out = [];
  coachWork(cur, out, true);
  coachWork(cur.parent, out, true);
  explainWork(cur, out);
  if (cur.parent && cur.parent.parent) explainWork(cur.parent, out);
  coachWork(game.line()[game.line().indexOf(cur) + 1], out); // reviewing: the next real move first
  preWork(cur, out);
  const line = game.line(), idx = line.indexOf(cur);
  for (let d = 1; d < line.length && out.length < max * 2; d++) {
    coachWork(line[idx - 1 - d], out);
    coachWork(line[idx + d], out);
  }
  const seen = new Set();
  return out.filter(w => !seen.has(workKey(w)) && seen.add(workKey(w))).slice(0, max);
}

// Each coach engine reads its own position in one deep search (deeper reads
// grade better than several shallow ones merged). Keeps the engines on the
// most urgent work, pre-empting background reads when something more urgent comes up.
function scheduleCoach() {
  if (!settings.coach || (scoring && scoring.pending) || kataSettled()) return;
  const engines = coach.engines;
  const want = coachQueue(engines.length);
  const wanted = new Set(want.map(workKey));
  const running = new Set(coachJobs.filter(Boolean).map(workKey));
  for (const w of want) {
    if (running.has(workKey(w))) continue;
    let i = engines.findIndex((_, k) => !coachJobs[k]);
    if (i < 0) i = coachJobs.findIndex(j => !wanted.has(workKey(j)));
    if (i < 0) break;
    startCoachJob(i, w);
  }
}

// A read of the position after `move` from `base`: kept on base, where the
// child's own read, check reads and pre-reads all find it, and handed to the
// child while it's in progress (the live win bar) and when it's done.
function storeAfter(base, move, res, done) {
  if (done) { preferUsefulMove(res); (base.after = base.after || new Map()).set(move, res); }
  const ch = base.children.find(c => c.move === move);
  if (ch && !ch.analysisDone) {
    ch.analysis = res;
    if (done) ch.analysisDone = true;
    onAnalysis(ch);
  }
  if (done) onAnalysis(base); // children of base waiting for this as a check
}

function startCoachJob(i, w) {
  const job = coachJobs[i] = w;
  // Explanation reads settle the wording, not the grade: a third of the budget is plenty.
  const explain = w.kind === 'threat' || w.kind === 'baseline';
  const playouts = explain ? Math.round(settings.coachPlayouts / 3) : settings.coachPlayouts;
  coach.engines[i].search(readRecipe(game, w), {
    playouts,
    // A slow device gets a shallower read rather than a long wait (desktops run ~7k playouts/s).
    maxTime: playouts / 2.5,
    reportMs: explain ? 0 : 250,
    onProgress: (res, done) => {
      if (w.kind === 'after') storeAfter(w.base, w.move, res, done);
      else if (w.kind === 'root') {
        w.node.analysis = res;
        if (done) { w.node.analysisDone = true; preferUsefulMove(res); }
        onAnalysis(w.node);
      } else if (done) {
        preferUsefulMove(res);
        (w.node.reads = w.node.reads || {})[w.kind] = res;
        onAnalysis(w.node);
      }
    },
  }).then(res => {
    if (coachJobs[i] === job) coachJobs[i] = null;
    if (res) scheduleCoach();
  });
}

function stopCoach() {
  coach.cancel();
  coachJobs = [];
}

// Grades node's move once both positions are read. A grade that needs a check
// read first (reviewNeeded) waits for it; scheduleCoach picks that up.
function tryGrade(node) {
  const parent = node.parent;
  if (!parent || node.grade || !isGraded(node) || !parent.analysisDone || !node.analysisDone) return;
  let g = gradeMove(parent.analysis, node.analysis, node.move);
  const other = reviewNeeded(g, parent.analysis);
  if (other != null) {
    const an = checkRead(node, other);
    if (!an) { node.checkMove = other; return; }
    g = gradeMove(parent.analysis, node.analysis, node.move, { move: other, analysis: an });
  }
  node.checkMove = null;
  node.grade = g;
  announceGrade(node);
}

// The coach's verdict on a move on screen, spoken once.
function announceGrade(node) {
  const cur = game.current;
  if (node.announced || node.move === PASS || !settings.show.feedback || (node !== cur && node !== cur.parent)) return;
  node.announced = true;
  announce(gradeSpeech(node));
}

// What the coach says about a graded move, as plain text ("Coach: Mistake. …").
function gradeSpeech(node) {
  const level = coachLevel(), facts = factsFor(node), shown = levelGrade(node.grade, level, facts);
  const all = describe(facts, { level, mover: node.color, you: settings.human, shown });
  const skip = skipLine(node, shown);
  if (skip) all.push(skip);
  const lines = puzzle(node, shown) ? hideAnswer(all, answerPoints(node)) : all;
  const said = puzzle(node, shown) ? 'There was something better here. Can you find it?'
    : `${found(node, shown) ? 'You found it! ' : ''}${verdict(node.grade, level, shown)}`;
  return plainText(`Coach: ${shown.label}. ${said} ${lines.join(' ')}`);
}

// What the coach knows about node's move so far (explain.js), from whatever
// reads are done. Cached until one of those reads changes.
function factsFor(node) {
  const p = node.parent;
  const reads = {
    before: p.analysisDone ? p.analysis : null,
    after: node.analysisDone ? node.analysis : null,
    threat: node.reads && node.reads.threat,
    baseline: node.reads && node.reads.baseline,
  };
  return cachedFacts(node, reads);
}

let analysisRenderPending = false;
function onAnalysis(node) {
  tryGrade(node);
  for (const ch of node.children) tryGrade(ch);
  if (analysisRenderPending) return;
  analysisRenderPending = true;
  // setTimeout rather than requestAnimationFrame: rAF stalls in hidden tabs/panes.
  setTimeout(() => { analysisRenderPending = false; render(); }, 30);
}

// ------------------------------------------------------------------ scoring

// restored: reopened on page load, so no sound or scrolling.
async function enterScoring(restored = false) {
  const node = game.current;
  cancelAI();
  mode = 'score';
  const mine = scoring = { node, dead: new Set(), pending: true };
  save(); // a reload while counting comes back to the count
  render();
  if (node.scoredDead) scoring.dead = new Set(node.scoredDead); // counted before: keep the player's dead/alive corrections
  else {
    let an = node.analysisDone ? node.analysis : null;
    if (!an) {
      stopCoach();
      await kataSettled();
      if (scoring !== mine) return;
      an = await coach.search(game.recipe(node), { playouts: 8000, reportMs: 0 });
      if (an) { node.analysis = preferUsefulMove(an); node.analysisDone = true; tryGrade(node); }
    }
    if (scoring !== mine) return; // left, or a newer count took over (and cancelled this search)
    scoring.dead = an ? estimateDead(node.board, an.ownership) : new Set();
    if (!an) flash('The coach couldn\'t read this position, so no stones are marked dead. Click any dead groups yourself.');
    node.scoredDead = new Set(scoring.dead);
  }
  scoring.pending = false;
  save();
  const s0 = game.score(scoring.dead, node);
  announce(`Game over. ${resultPhrase(s0.winner, s0.margin)} ${ladderSentence()}`.trim());
  if (!restored) playSound(settings.human && s0.winner !== settings.human ? 'lose' : 'win');
  render();
  if (!restored) $('#scorePanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // stacked below the board on phones
  scheduleCoach();
}

function exitScoring() { mode = 'play'; scoring = null; }

function toggleDead(p) {
  if (!scoring || scoring.pending) return;
  const b = scoring.node.board;
  if (b.color[p] !== BLACK && b.color[p] !== WHITE) return;
  const on = !scoring.dead.has(p);
  for (const s of b.chainStones(p)) on ? scoring.dead.add(s) : scoring.dead.delete(s);
  scoring.node.scoredDead = new Set(scoring.dead);
  save();
  const s = game.score(scoring.dead, scoring.node);
  announce(`${on ? 'Marked dead' : 'Marked alive'}. ${resultPhrase(s.winner, s.margin)}`);
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

// verdict: also say the coach's verdict on the move landed on (stepping
// through a game); buttons that step back to act from there skip it.
function goTo(node, { verdict: sayVerdict = true } = {}) {
  passWarned = null; // any change of position ends a pass warning
  cancelAI();
  if (mode === 'score') exitScoring();
  peek = null; armed = null; hintOn = false;
  locatePt = null; // the button it came from may be rebuilt without a focusout
  game.goTo(node);
  save(); render(); scheduleCoach();
  // Stepping through a game: the move, and the coach's verdict on it when there is one.
  const graded = sayVerdict && node.move !== PASS && node.grade && isGraded(node) && settings.show.feedback;
  announce(positionPhrase(node.depth, node.color, node.move) + (graded ? ` ${gradeSpeech(node)}` : ''));
  aiMove(); // back at the newest position with the AI to move (only fires on a leaf)
}

function nav(where) {
  const cur = game.current;
  if (where === 'first') goTo(game.root);
  else if (where === 'prev' && cur.parent) goTo(cur.parent);
  else if (where === 'next') { const n = cur.lastChild || cur.children[0]; if (n) goTo(n); }
  else if (where === 'last') { const line = game.line(); goTo(line[line.length - 1]); }
}

// Try's preview: the position before the graded move, with the coach's move and
// how it expects play to go on. Board and status line only: the game stays put.
// Ends a Try preview kept on by a first click.
function disarm() {
  armed = null;
  peek = null;
  ending = true;
  try { render(); } finally { ending = false; }
}

function peekAt(node) {
  const g = node && node.grade, parent = node && node.parent;
  if (!g || !parent || g.bestMove === PASS) {
    if (peek) { peek = null; renderBoard(); renderStatus(); }
    return;
  }
  parent.helped = true; // seeing the coach's move: a good move here isn't "found" alone
  const m = parent.analysis && parent.analysis.moves.find(x => x.move === g.bestMove);
  peek = { node: parent, move: g.bestMove, pv: pvStones(parent.board.toPlay, [g.bestMove, ...((m && m.pv) || [])]) };
  renderBoard(); renderStatus();
}

const nodeById = id => {
  for (const stack = [game.root]; stack.length;) {
    const n = stack.pop();
    if (n.id === id) return n;
    stack.push(...n.children);
  }
  return null;
};

function tryInstead(node) {
  const g = node.grade;
  if (!g || !node.parent) return;
  if (resigned) { flash('You resigned. Take back to keep playing, or start a new game.'); return; }
  const back = game.current; // where the player was: "Back to my move" returns here
  node.parent.helped = true;
  peek = null;
  goTo(node.parent, { verdict: false });
  if (playMove(g.bestMove, { human: true })) {
    const tried = node.parent.children.find(c => c.move === g.bestMove);
    if (tried && tried !== node) tried.backTo = { node: back, move: node.move };
  }
}

// From a tried coach move back to exactly where the player was.
function backToMine(node) {
  if (node.backTo && nodeById(node.backTo.node.id)) goTo(node.backTo.node, { verdict: false });
}

// ------------------------------------------------------------------ rendering

// Graph dot for a move flagged at the current coach level.
function graphMark(node) {
  if (!node.grade || node.move === PASS || !isGraded(node)) return null;
  const shown = levelGrade(node.grade, coachLevel(), factsFor(node));
  return shown.flagged ? { color: shown.color, small: shown.key === 'inaccuracy' } : null;
}

// Replaces an element's HTML only when it changed, so a coach tick doesn't
// rebuild buttons under the pointer (and take their focus). A focused button
// that is rebuilt (same id, or same data-act and data-id) keeps the focus.
function setHTML(el, html) {
  if (el._html === html) return;
  el._html = html;
  const f = document.activeElement;
  const sel = f && f !== el && el.contains(f) && (f.id ? `#${CSS.escape(f.id)}`
    : ['act', 'id'].filter(k => f.dataset && f.dataset[k]).map(k => `[data-${k}="${CSS.escape(f.dataset[k])}"]`).join(''));
  el.innerHTML = html;
  const again = sel && el.querySelector(sel);
  if (again) again.focus({ preventScroll: true });
}

function render() {
  renderBoard();
  renderPlayers();
  renderCoach();
  renderScorePanel();
  renderNav();
  renderStatus();
  renderGraph($('#graph'), game.line(), game.current, goTo, graphMark, { dotsOnScore: game.handicapBonus > 0 });
  renderReview();
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
  return ms.filter(m => m.visits >= Math.max(8, top.visits * 0.06)).slice(0, 6).flatMap((m, rank) => {
    const loss = top.winrate - m.winrate;
    const color = rank === 0 ? '#2f9e61' : loss < 0.04 ? '#3b82c4' : loss < 0.1 ? '#b8901c' : '#cf6a1d';
    const lead = m.score * sgn;
    const hint = { rank, color, label: `${Math.round(m.winrate * 100)}%`, sub: `${lead >= 0 ? '+' : ''}${lead.toFixed(1)}` };
    // Mirror images on a symmetric board are the same move: mark them all.
    return [m.move, ...(m.twins || [])].map(move => ({ ...hint, move }));
  });
}

function hoverInfo() {
  const p = hoverPt, node = game.current, b = node.board;
  if (p === null || mode !== 'play' || aiNode || game.isOver(node) || b.color[p] !== EMPTY) return null;
  if (resigned || (aiColor() && b.toPlay === aiColor())) return null;
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

// Whether the coach's best moves are on the board for this position.
function hintsShown(node) {
  const an = node.analysis;
  return mode === 'play' && !!an && (hintOn || settings.show.hints) && !game.isOver(node)
    && !(aiColor() && !resigned && node.board.toPlay === aiColor() && node.children.length === 0);
}

// Why the top hint is worth playing, when it has a tactical point (cached).
function hintWhy(node) {
  if (!hintsShown(node)) return null;
  const top = node.analysis.moves.find(m => m.move !== PASS);
  if (!top) return null;
  // The wording depends on the coach level and who "you" are, as well as the move.
  const key = `${top.move}:${coachLevel()}:${settings.human}`;
  if (!node.hintWhy || node.hintWhy.key !== key) {
    node.hintWhy = { key, text: hintReason(node.board, top.move, { level: coachLevel(), you: settings.human }) };
  }
  return node.hintWhy.text;
}

function renderBoard() {
  if (peek) {
    const n = peek.node;
    view.render({ board: n.board, nodeId: n.id, lastMove: n.parent ? n.move : PASS, captured: n.captured, capturedColor: 3 - n.color, better: peek.move, pv: peek.pv });
    return;
  }
  const node = game.current, b = node.board, an = node.analysis, sh = settings.show;
  const s = {
    board: b, nodeId: node.id,
    lastMove: node.parent ? node.move : PASS,
    captured: node.captured, capturedColor: 3 - node.color,
    liberties: sh.liberties && mode === 'play',
  };
  if (sh.numbers) s.numbers = moveNumbers(node);
  if (sh.atari && mode === 'play') s.threats = threats(b).filter(t => t.libs.length === 1);
  if (sh.territory && an && mode === 'play') s.ownership = an.ownership;
  if (scoring) { s.dead = scoring.dead; if (!scoring.pending) s.scoreOwner = game.score(scoring.dead, node).owner; }
  const hintsVisible = hintsShown(node);
  if (hintsVisible) node.helped = true; // the best moves were on show here: a good move isn't "found" alone
  if (hintsVisible) {
    s.hints = hintList(an);
    const m = hoverPt !== null && an.moves.find(x => x.move === hoverPt);
    if (m && m.pv) s.pv = pvStones(b.toPlay, [m.move, ...m.pv]);
  }
  if (threat && threat.node === node && threat.move) { s.threat = threat.move; s.pv = threat.pv; s.pvAccent = '#e03131'; }
  if (sh.feedback && node.grade && isGraded(node)) {
    const shown = levelGrade(node.grade, coachLevel(), factsFor(node));
    if (shown.key === 'mistake' || shown.key === 'blunder') s.grade = shown.color;
  }
  if (s.pv) s.liberties = false; // numbered continuation stones would be confused with liberty counts
  else s.hover = hoverInfo();
  s.coord = hoverPt; // the point under the pointer or keyboard cursor, stone or not
  if (locatePt !== null) s.locate = locatePt;
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
  if (game.handicap && settings.human === BLACK) return `Handicap game: you start with ${game.handicap} stones and White moves first. Use your head start: build territory and stay connected.`;
  if (game.handicap) return `Handicap game: the AI starts with ${game.handicap} stones and you move first. You're behind, so be bold: settle a group of your own, then look for weak points between its stones.`;
  if (settings.human === BLACK) return 'Welcome to the dojo! You are Black and move first. Click an intersection to place a stone. The centre (E5) or points like C3, G7, C7 or G3 are great starts. Take back any move with <kbd>U</kbd>.';
  return 'You are White. The AI moves first. White gets komi (bonus points) for going second.';
}

// On narrow screens the coach card is below the board: a badge beside the
// logo shows the grade of the player's latest move (study mode: the latest
// move's), and tapping it scrolls to the card. Hidden by CSS where the card
// is beside the board.
function renderBadge() {
  const el = $('#coachBadge'), cur = game.current;
  const node = !settings.human ? cur : [cur, cur.parent].find(n => n && n.parent && n.color === settings.human);
  const shows = settings.coach && settings.show.feedback && mode === 'play' && node && node.parent && isGraded(node);
  if (!shows) { el.hidden = true; return; }
  const pt = node.move === PASS ? 'pass' : ptName(node.move);
  const shown = node.grade && levelGrade(node.grade, coachLevel(), factsFor(node));
  const text = shown ? `${shown.label} · ${pt}` : 'grading…';
  const key = `${text}|${shown ? shown.color : ''}`;
  el.hidden = false;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.textContent = `${text} ↓`;
  el.classList.toggle('pending', !shown);
  el.style.setProperty('--pill', shown ? shown.color : '');
  el.setAttribute('aria-label', shown ? `Coach: ${shown.label} on ${pt}. Show the coach's comments.` : 'Coach: still grading your move. Show the coach.');
}

function renderCoach() {
  renderBadge();
  const node = game.current, an = node.analysis;
  // How much the coach read: KataGo looks at positions; the built-in engine simulates games.
  const done = an && (kindOf(an) === 'katago' ? `read ${fmtK(an.playouts)} positions` : `${fmtK(an.playouts)} simulations`);
  $('#coachStatus').textContent = !settings.coach ? 'off' : kataSettled() ? 'loading KataGo…' :
    an ? (node.analysisDone ? done : `reading… ${fmtK(an.playouts)}`) : 'reading…';
  const bw = an ? an.blackWinrate : 0.5;
  $('#winB').style.width = `${(bw * 100).toFixed(1)}%`;
  $('#winLabelB').textContent = an ? `Black ${Math.round(bw * 100)}%` : 'Black';
  $('#winLabelW').textContent = an ? `${Math.round((1 - bw) * 100)}% White` : 'White';
  setHTML($('#scoreEst'), an && coachLevel() !== 'beginner' ? `Expected result: <b>${describeScore(an.score)}</b> <span class="muted">(incl. komi ${game.komi}${game.handicapBonus ? ` + ${game.handicapBonus} handicap` : ''})</span>` : '&nbsp;');

  // Feedback on the last two moves, so against the AI you see your own move's
  // grade as well as the reply.
  const fb = $('#feedback');
  const entries = [];
  if (node.parent && node.parent.parent) entries.push(node.parent);
  if (node.parent) entries.push(node);
  setHTML(fb, linkPoints(entries.length ? entries.map(moveEntry).join('') : `<p class="tip">${openingTip()}</p>`));
  fb.onclick = e => {
    const btn = e.target.closest && e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const target = entries.find(n => n.id === +btn.dataset.id);
    if (!target) return;
    if (act === 'back') backToMine(target);
    if (act === 'try') {
      // A mouse has already previewed it by pointing, and a keyboard by focusing: one
      // click plays. A tap (touch has no hover) first keeps the preview on and asks for a second.
      const touch = (e.pointerType || lastPointer) === 'touch';
      if (!touch || armed === target) { armed = null; tryInstead(target); return; }
      armed = target;
      peekAt(target);
      renderCoach();
      announce(`Coach's choice: ${ptName(peek.move)}${peek.pv.length > 1 ? ', then ' + peek.pv.slice(1, 4).map(m => ptName(m.move)).join(', ') : ''}. Press Play to play it.`);
    }
    if (act === 'retry') retry(target);
    if (act === 'reveal') reveal(target);
  };
  const why = hintWhy(node);
  $('#hintWhy').hidden = !why;
  setHTML($('#hintWhy'), why ? linkPoints(why) : '');

  // Live warnings about the position on the board.
  const b = node.board;
  let warn = '';
  if (settings.show.atari && mode === 'play' && !game.isOver(node)) {
    warn = atariWarnings(b, p => game.check(p), { whose: c => whose(c), who: c => who(c) })
      .map(w => `<li class="${w.kind}">${w.text}</li>`).join('');
  }
  setHTML($('#warnings'), linkPoints(warn));
  // Screen readers and speech hear the warnings too: once when they appear for a
  // position (redraws don't repeat them), and again on coming back to it.
  const warnKey = warn && `${node.id}|${warn}`;
  if (warnKey !== warningsSaid) {
    warningsSaid = warnKey;
    if (warn) announce(plainText(warn.replace(/<\/li>/g, ' </li>')));
  }

  const tb = $('#threatBox');
  tb.hidden = !(threat && threat.node === node);
  if (!tb.hidden) {
    if (threat.pending) setHTML(tb, 'Looking at the board from the opponent\'s side…');
    else if (threat.none) setHTML(tb, 'The opponent has nothing urgent here.');
    else {
      const oppName = !settings.human ? colorName(threat.opp) : threat.opp === settings.human ? 'you' : 'the AI';
      setHTML(tb, linkPoints(`<p><b>Their idea:</b> if ${!settings.human ? colorName(threat.me) : threat.me === settings.human ? 'you' : 'the AI'} played somewhere else, ${oppName} would play <b>${ptName(threat.move)}</b>.` +
        (threat.cost >= 1 && coachLevel() !== 'beginner' ? ` Ignoring it costs about <b>${plural(Math.round(threat.cost), 'point')}</b>.` : '') + '</p>' +
        `<ul class="explain">${describe(threat.facts, { level: coachLevel(), mover: threat.opp, you: settings.human, intent: true }).map(t => `<li>${t}</li>`).join('')}</ul>` +
        '<p class="muted small">Numbered stones show how they expect it to continue. Press <kbd>O</kbd> again to hide.</p>'));
    }
  }
  holdCoachHeight();
}

// The Coach card only grows during a game: its text changes with every move,
// and a card that shrank and grew back would make everything below it jump.
// A new game, or a change of window width, starts it afresh.
let coachHeight = 0;
function holdCoachHeight() {
  const card = $('.coach');
  coachHeight = Math.max(coachHeight, card.offsetHeight);
  card.style.minHeight = `${coachHeight}px`;
}
addEventListener('resize', () => { if (coachHeight) { resetCoachHeight(); renderCoach(); } });
function resetCoachHeight() {
  coachHeight = 0;
  $('.coach').style.minHeight = '';
}

function renderReview() {
  const el = $('#review'), level = coachLevel();
  const stats = {};
  for (const c of [BLACK, WHITE]) stats[c] = { n: 0, loss: 0, counts: {}, worst: [] };
  for (const n of game.line()) {
    const g = n.grade;
    if (!g || n.move === PASS || !isGraded(n)) continue;
    const s = stats[n.color], shown = levelGrade(g, level, factsFor(n));
    s.n++;
    s.loss += Math.min(g.ptLoss, 30);
    if (!shown.flagged) continue;
    s.counts[shown.key] = (s.counts[shown.key] || 0) + 1;
    if (shown.key !== 'inaccuracy') s.worst.push(n);
  }
  if (!stats[BLACK].n && !stats[WHITE].n) { setHTML(el, ''); return; }
  const row = c => {
    const s = stats[c];
    if (!s.n) return '';
    const pills = ['blunder', 'mistake', 'inaccuracy'].filter(k => s.counts[k])
      .map(k => `<span class="pill" style="--pill:${GRADES[k].color}">${plural(s.counts[k], gradeLabel(k, level).toLowerCase())}</span>`).join(' ');
    const avg = level === 'beginner' ? '' : `<span class="muted">avg −${(s.loss / s.n).toFixed(1)} pts/move</span>`;
    return `<div class="rv-row"><span class="stone-icon ${c === BLACK ? 'black' : 'white'}"></span><b>${who(c)}</b>` +
      `${avg}${pills || '<span class="muted">no mistakes yet</span>'}</div>`;
  };
  const worst = [...stats[BLACK].worst, ...stats[WHITE].worst].sort((a, b) => b.grade.ptLoss - a.grade.ptLoss).slice(0, 5);
  const chip = n => `<button class="chip" data-id="${n.id}" data-pt="${n.move}" title="Jump to this move">#${n.depth} ${ptName(n.move)}${level === 'beginner' ? '' : ` −${n.grade.ptLoss.toFixed(0)}`}</button>`;
  setHTML(el, linkPoints(row(BLACK) + row(WHITE) + (worst.length ? `<div class="rv-worst"><span class="muted">Biggest:</span>${worst.map(chip).join('')}</div>` : '')) + keyMomentsHtml());
  el.onclick = e => {
    const chip = e.target.closest && e.target.closest('[data-id]');
    const node = chip && game.line().find(n => n.id === +chip.dataset.id);
    if (node) goTo(node);
  };
}

// The point node's move missed, when the opponent played it next on the line:
// node's better point or a mirror image of it. Null otherwise.
function tookNext(node) {
  const next = node.lastChild || node.children[0], g = node.grade;
  if (!next || !g || g.bestMove === PASS || next.color === node.color) return null;
  const e = node.parent.analysis && entryFor(node.parent.analysis, g.bestMove);
  return next.move === g.bestMove || (e && e.twins && e.twins.includes(next.move)) ? next.move : null;
}

// Under a flagged move: the same point has been among the coach's top choices
// for this side's last few moves (coach.js skippedPoint). Null otherwise.
function skipLine(node, shown) {
  if (!shown.flagged) return null;
  const run = [];
  for (let n = node; n.parent && run.length < 12; n = n.parent) {
    if (n.color !== node.color || !isGraded(n)) continue;
    if (!n.grade) break;
    run.unshift({ move: n.move, bestMove: n.grade.bestMove, ptLoss: n.grade.ptLoss, top: topChoices(n.parent.analysis) });
  }
  const s = skippedPoint(run);
  if (!s) return null;
  const whose = node.color === settings.human ? 'your' : `${colorName(node.color)}'s`;
  return `${ptName(s.point)} has been one of the coach's top choices for ${whose} last ${s.count} moves. What makes it so big?`;
}

// Under the AI's latest move: "you don't need to answer this", once the coach
// has read the player's position (games against the AI only).
function ignoreLine(node) {
  if (!settings.human || !settings.coach || resigned || node.color === settings.human || node !== game.current || !node.analysisDone) return null;
  return ignoreNote(node.board, node.move, node.analysis, coachLevel());
}

// Find it yourself: the player's Mistake or Blunder against the AI, with the
// coach's move hidden until they ask (Show answer) or find a good move.
const puzzle = (node, shown) => settings.findYourself && !!settings.human && node.color === settings.human
  && !node.revealed && !resigned && (shown.key === 'mistake' || shown.key === 'blunder');
// The coach's move for node and its mirror images: what a puzzle mustn't name.
function answerPoints(node) {
  const g = node.grade, e = node.parent.analysis && entryFor(node.parent.analysis, g.bestMove);
  return [g.bestMove, ...((e && e.twins) || [])].filter(q => q !== PASS);
}
// A Good or Best move played from a position the player went back to with Try
// again, without being shown the answer (Show answer, Try instead, a hint or
// the "AI move" button all mark the position as helped).
const found = (node, shown) => !!(node.parent && node.parent.retry && !node.parent.helped) && (shown.key === 'best' || shown.key === 'good');

function retry(node) {
  node.parent.retry = true;
  goTo(node.parent, { verdict: false });
}

function reveal(node) {
  node.revealed = true;
  node.parent.helped = true;
  render();
  const level = coachLevel(), shown = levelGrade(node.grade, level, factsFor(node));
  announce(plainText(`Coach: ${verdict(node.grade, level, shown)}`));
}

function moveEntry(node) {
  const latest = node === game.current;
  const head = pill => `<div class="fb-head">${pill}<span><b>${who(node.color)}</b> ${node.move === PASS ? 'passed' : `played <b>${ptName(node.move)}</b>`}</span></div>`;
  const wrap = html => `<div class="fb-entry${latest ? ' latest' : ''}">${html}</div>`;
  const list = lines => lines.length ? `<ul class="explain">${lines.map(t => `<li>${t}</li>`).join('')}</ul>` : '';
  if (node.move === PASS) return wrap(head(''));
  const level = coachLevel(), facts = factsFor(node);
  const ctx = { level, mover: node.color, you: settings.human };
  // Ungraded (AI) moves: just what the player has to react to.
  if (!isGraded(node)) {
    const notes = describeNote(facts, ctx), ignore = ignoreLine(node);
    return wrap(head('') + list(ignore ? [...notes, ignore] : notes));
  }
  const g = node.grade;
  let html;
  if (!settings.show.feedback) html = head('');
  else if (!g) html = head(`<span class="pill pending">${node.checkMove != null ? 'double-checking…' : 'grading…'}</span>`);
  else if (puzzle(node, ctx.shown = levelGrade(g, level, facts))) {
    html = head(`<span class="pill" style="--pill:${ctx.shown.color}">${ctx.shown.label}</span>`) + '<p>There was something better here. Can you find it?</p>' +
      `<div class="fb-actions"><button data-act="retry" data-id="${node.id}">Try again</button><button data-act="reveal" data-id="${node.id}">Show answer</button></div>`;
  } else {
    html = head(`<span class="pill" style="--pill:${ctx.shown.color}">${ctx.shown.label}</span>`) + `<p>${found(node, ctx.shown) ? '<b>You found it!</b> ' : ''}${verdict(g, level, ctx.shown)}</p>`;
    if (g.grade !== 'best' && g.bestMove !== PASS) {
      html += `<div class="fb-actions"><button data-act="try" data-id="${node.id}">${armed === node ? `Play ${ptName(g.bestMove)}` : `Try ${ptName(g.bestMove)} instead`}</button></div>`;
    }
  }
  if (node.backTo && !resigned) html += `<div class="fb-actions"><button data-act="back" data-id="${node.id}">Back to my move (${ptName(node.backTo.move)})</button></div>`;
  const all = describe(facts, ctx);
  const missed = g && ctx.shown && ctx.shown.flagged ? tookNext(node) : null;
  if (missed != null) all.unshift(missedLine(missed, ctx));
  const skip = g && ctx.shown && skipLine(node, ctx.shown);
  if (skip) all.push(skip);
  const lines = g && ctx.shown && puzzle(node, ctx.shown) ? hideAnswer(all, answerPoints(node)) : all;
  if (settings.coach && !(node.reads && node.reads.threat && node.reads.baseline)) lines.push('<span class="muted">Reading the idea behind this move…</span>');
  return wrap(html + list(lines));
}

// After a finished game against the AI, the few of the player's mistakes most
// worth a look (coach.js keyMoments), as a list of moves to jump to. Each says
// how big it was and why, without naming the coach's move: that's left to find
// on the move's own card. '' while there's no finished game.
function keyMomentsHtml() {
  if (!settings.coach || gameOutcome() === null) return '';
  const level = coachLevel();
  const mine = game.line().filter(n => n.parent && n.color === settings.human && isGraded(n));
  if (!mine.length) return '';
  const waiting = mine.filter(n => !n.grade).length;
  const bad = mine.filter(n => n.grade && ['mistake', 'blunder'].includes(levelGrade(n.grade, level, factsFor(n)).key));
  const prior = n => { const e = n.parent.analysis && entryFor(n.parent.analysis, n.grade.bestMove); return e ? e.prior : undefined; };
  const picks = keyMoments(bad.map(n => ({ depth: n.depth, ptLoss: n.grade.ptLoss, prior: prior(n), node: n })), level);
  const item = ({ node: n, turning }) => {
    const shown = levelGrade(n.grade, level, factsFor(n));
    const pts = Math.max(1, Math.round(n.grade.ptLoss));
    const size = level === 'beginner' ? shown.label : `lost about ${plural(pts, 'point')}`;
    const why = hideAnswer(mistakeLines(factsFor(n), { level, mover: n.color, you: settings.human, shown }), answerPoints(n))[0];
    const name = n.move === PASS ? 'pass' : ptName(n.move);
    return `<li><button class="chip" data-id="${n.id}"${n.move === PASS ? '' : ` data-pt="${n.move}"`} title="Jump to this move">Move ${n.depth} · ${name}</button>` +
      `${turning ? ' <b>Turning point.</b>' : ''} ${cap(size)}.${why ? ` <span class="muted">${why}</span>` : ''}</li>`;
  };
  const body = picks.length ? `<ul>${picks.map(item).join('')}</ul>`
    : !waiting ? `<p>${bad.length ? 'Your mistakes this game were hard to see. The graph shows where they were.' : 'No big mistakes this game. Nicely played.'}</p>` : '';
  const more = waiting ? `<p class="muted">The coach is still grading ${plural(waiting, 'move')}…</p>` : '';
  return linkPoints(`<div class="key-moments"><h3>Key moments</h3>${body}${more}</div>`);
}

// The finished game's result for the player: 1 won, -1 lost, 0 drawn, null
// when there's no finished game against the AI (still playing, played on from
// a count, study mode).
function gameOutcome() {
  if (!settings.human) return null;
  if (resigned) return -1;
  const s = finalScore();
  return !s ? null : !s.winner ? 0 : s.winner === settings.human ? 1 : -1;
}

// The finished game's count: the one on show, or out of the count (reviewing,
// say) the line's end, which kept its dead stones. null when not counted.
function finalScore() {
  const end = game.line().at(-1);
  const counted = scoring ? (scoring.pending ? null : scoring) : game.isOver(end) && end.scoredDead ? { node: end, dead: end.scoredDead } : null;
  return counted && game.score(counted.dead, counted.node);
}

// The level the next game starts at: one step along the ladder from a finished game.
function ladderLevel() {
  const o = settings.ladder ? gameOutcome() : null;
  return o === null ? settings.level : nextLevel(settings.level, o).level;
}

// What the ladder does after this game, as a sentence ('' with it off or no finished game).
function ladderSentence() {
  const o = settings.ladder ? gameOutcome() : null;
  if (o === null) return '';
  const { level: n, step } = nextLevel(settings.level, o);
  const name = `level ${n + 1} · ${LEVELS[n].name}`;
  return {
    up: `Next game: ${name}, one step up.`,
    down: `Next game: ${name}, one step down.`,
    same: `Next game: ${name} again.`,
    top: `You beat ${LEVELS[n].name}, the strongest level!`,
    bottom: `Next game: ${name} again. Handicap stones (in New game) make it easier still.`,
  }[step];
}

// Below the result: where the ladder goes next, or with the ladder off, a
// better-matched opponent after a lopsided game. margin is black-minus-white.
function nextGameNote(margin) {
  if (!settings.ladder) return levelAdvice(margin);
  const next = ladderSentence();
  return next ? `<p class="advice">${next}</p>` : '';
}

// Suggests a better-matched opponent after a lopsided game. margin is black-minus-white.
function levelAdvice(margin) {
  if (!settings.human) return '';
  const mine = margin * (settings.human === BLACK ? 1 : -1), lv = settings.level;
  if (mine >= 15 && lv < LEVELS.length - 1) {
    return `<p class="advice">Comfortable win! Try level ${lv + 2} · ${LEVELS[lv + 1].name} next (Settings → AI strength).</p>`;
  }
  if (mine <= -25 && lv > 0) {
    return `<p class="advice">A tough one. Level ${lv} · ${LEVELS[lv - 1].name}, or a 2–3 stone handicap, may be more fun for learning.</p>`;
  }
  return '';
}

function renderScorePanel() {
  const el = $('#scorePanel');
  if (!scoring && !resigned) { el.hidden = true; return; }
  el.hidden = false;
  if (resigned && !scoring) {
    setHTML(el, `<h2>${colorName(resigned)} resigned</h2><p class="big">${resigned === settings.human ? 'The AI wins this one.' : 'You win!'}</p>${nextGameNote(resigned === BLACK ? -99 : 99)}${keyMomentsHtml()}
      <div class="fb-actions"><button data-act="review">Review the game</button><button data-act="save">Save SGF</button><button data-act="new" class="primary">New game</button></div>`);
  } else if (scoring.pending) {
    setHTML(el, '<h2>Counting…</h2><p class="muted">The coach is working out which stones are dead.</p>');
  } else {
    const s = game.score(scoring.dead, scoring.node);
    const winText = !s.winner ? 'A draw!' : !settings.human ? `${colorName(s.winner)} wins.` :
      s.winner === settings.human ? 'You win! 🎉' : 'The AI wins this one.';
    const tm = s.territory.margin;
    setHTML(el, `<h2>Game over · ${s.text}</h2>
      <p class="big">${winText}</p>${nextGameNote(s.margin)}${keyMomentsHtml()}
      <table class="score-table">
        <tr><th></th><th>Black</th><th>White</th></tr>
        <tr><td>Stones + surrounded area</td><td>${s.black}</td><td>${s.white}</td></tr>
        <tr><td>Komi</td><td></td><td>${s.komi}</td></tr>${s.bonus ? `
        <tr><td>Handicap compensation</td><td></td><td>${s.bonus}</td></tr>` : ''}
        <tr class="total"><td>Total</td><td>${s.black}</td><td>${s.white + s.komi + s.bonus}</td></tr>
      </table>
      <p class="muted">Area scoring (Chinese rules). Counting territory + prisoners instead (Japanese style) gives ${tm === 0 ? 'a draw' : (tm > 0 ? 'B+' : 'W+') + Math.abs(tm)}.</p>
      <p class="muted">Squares show who owns each point. Don't agree about a dead group? Click it to switch between dead and alive.</p>
      <div class="fb-actions"><button data-act="resume">Resume play</button><button data-act="review">Review the game</button><button data-act="save">Save SGF</button><button data-act="new" class="primary">New game</button></div>`);
  }
  el.onclick = e => {
    const act = e.target.dataset && e.target.dataset.act;
    const moment = !act && e.target.closest && e.target.closest('[data-id]');
    const node = moment && game.line().find(n => n.id === +moment.dataset.id);
    if (node) { goTo(node); return; }
    if (act === 'resume') resumeFromScoring();
    if (act === 'review') {
      exitScoring(); goTo(game.root);
      flash(`Review: step through with ◀ ▶ or click the graph. Dots mark mistakes. Click the board to try other moves${resigned ? ' for either side' : ''}.`);
    }
    if (act === 'save') exportSGF();
    if (act === 'new') openNewGame();
  };
}

// For a node off the main line (each node's first child, from the start): the
// main line's move where this line first left it. Null on the main line.
function mainLineReturn(node) {
  let fork = null;
  for (let n = node; n.parent; n = n.parent) if (n.parent.children[0] !== n) fork = n.parent;
  return fork && fork.children[0];
}

function renderNav() {
  const node = game.current;
  $('#moveLabel').textContent = node.parent ? `Move ${node.depth} · ${colorName(node.color)} ${ptName(node.move)}` : 'Start';
  $('[data-nav=first]').disabled = $('[data-nav=prev]').disabled = !node.parent;
  $('[data-nav=next]').disabled = $('[data-nav=last]').disabled = !node.children.length;
  const humanTurn = mode === 'play' && !aiNode && !game.isOver() && !resigned && !(aiColor() && game.toPlay === aiColor());
  $('#btnPass').disabled = !humanTurn;
  $('#btnPass').textContent = humanTurn && passWarned === node ? 'Pass anyway' : 'Pass';
  $('#btnUndo').disabled = !node.parent && !resigned;
  $('#btnAI').disabled = !!aiNode || mode !== 'play' || game.isOver() || !!resigned;
  $('#btnResign').textContent = game.isOver() ? 'Count' : 'Resign';
  $('#btnResign').disabled = mode === 'score' || (!game.isOver() && (!settings.human || !!resigned));
  $('#btnHint').classList.toggle('on', hintOn);
  $('#btnThreat').classList.toggle('on', !!threat && threat.node === node);
  $('#btnThreat').disabled = mode !== 'play' || game.isOver();

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
  // Off the main line (the game as first played, ★): one click back to the
  // main line's move where this line left it.
  const back = mainLineReturn(node);
  if (back) html += `<button class="chip" data-id="${back.id}">↩ Back to main line (move ${back.depth})</button>`;
  const v = $('#variations');
  setHTML(v, html);
  v.onclick = e => {
    const id = +(e.target.dataset && e.target.dataset.id);
    const target = [...sibs, ...node.children, ...(back ? [back] : [])].find(n => n.id === id);
    if (target) goTo(target);
  };
}

function renderStatus() {
  const el = $('#message');
  let text = '', kind = '';
  const node = game.current;
  const h = mode === 'play' && hoverPt !== null ? hoverInfo() : null;
  if (peek) text = `Coach's choice: ${ptName(peek.move)}. Numbered stones show how play would go on.`;
  else if (h && !h.ok && !hoverByKey) { text = reasonText(h.reason); kind = 'bad'; }
  else if (flashMsg) { text = flashMsg.text; kind = flashMsg.kind; }
  else if (scoring) text = scoring.pending ? 'Counting…' : 'Click groups to mark them dead or alive.';
  else if (aiNode) text = aiBest ? 'Finding the best move…' : kata.state === 'loading' ? `Loading KataGo, the AI's network…` : `${aiLabel()} is thinking…`;
  else if (resigned) text = `${colorName(resigned)} resigned.`;
  else if (game.isOver(node)) text = 'Both players passed. The game is over.';
  else {
    // Short, so the line never wraps further and moves the controls below it.
    const earlier = node.children.length ? 'Earlier position · ' : '';
    const c = node.board.toPlay;
    text = earlier + (!settings.human ? `${colorName(c)} to play.` : c === settings.human ? `Your move (${colorName(c)}).` : `AI's move (${colorName(c)}).`);
  }
  if (el.textContent !== text) el.textContent = text; // aria-live: don't re-announce on every hover
  el.className = `message ${kind}`;
}

// ------------------------------------------------------------------ persistence

// Child-index path from the root to node.
const pathOf = node => { const p = []; for (let n = node; n.parent; n = n.parent) p.unshift(n.parent.children.indexOf(n)); return p; };

function save() {
  let written = false;
  try {
    // Every counted position keeps the player's dead/alive marks.
    const dead = [];
    const walk = n => { if (n.scoredDead) dead.push({ path: pathOf(n), points: [...n.scoredDead] }); n.children.forEach(walk); };
    walk(game.root);
    // No names: only a loaded record's own names are kept (Save SGF names the players).
    storage.setItem(STORE, JSON.stringify({ settings, sgf: game.toSGF({ black: '', white: '' }), path: pathOf(game.current), resigned, dead,
      scoring: mode === 'score' && scoring ? pathOf(scoring.node) : null }));
    written = true;
  } catch { /* storage full or refused: said by kept() */ }
  kept(written);
}

// The game is saved by itself; when that stops working (storage blocked,
// full, or refusing writes) a line under Save SGF says so, and goes when a
// later save works. written: the save just made went through.
const NOT_SAVED = 'Your game is not being saved in this browser. Use Save SGF to keep it.';
let notSaved = false;
function kept(written) {
  const failing = !(written && storage.durable);
  if (failing === notSaved) return;
  notSaved = failing;
  const note = $('#saveNote');
  note.hidden = !notSaved;
  note.textContent = notSaved ? NOT_SAVED : '';
  if (notSaved) flash(NOT_SAVED);
}

function load() {
  try {
    const d = JSON.parse(storage.getItem(STORE) || storage.getItem(OLD_STORE));
    if (!d) return false;
    settings = { ...structuredClone(DEFAULTS), ...d.settings, show: { ...DEFAULTS.show, ...(d.settings && d.settings.show) } };
    settings.level = Math.min(LEVELS.length - 1, Math.max(0, settings.level | 0));
    // Quick / Normal / Deep were 8k / 24k / 80k before the coach read each position in one tree.
    settings.coachPlayouts = { 8000: 16000, 24000: 48000, 80000: 120000 }[settings.coachPlayouts] || settings.coachPlayouts;
    if (![16000, 48000, 120000].includes(settings.coachPlayouts)) settings.coachPlayouts = DEFAULTS.coachPlayouts;
    if (!['katago', 'builtin'].includes(settings.coachEngine)) settings.coachEngine = DEFAULTS.coachEngine;
    settings.gradeAI = !!settings.gradeAI;
    settings.findYourself = !!settings.findYourself;
    settings.ladder = !!settings.ladder;
    if (![0, BLACK, WHITE].includes(settings.lastHuman)) settings.lastHuman = DEFAULTS.lastHuman;
    settings.studyFromImport = !!settings.studyFromImport;
    settings.speak = !!settings.speak;
    if (!COACH_FOR.some(o => o.key === settings.coachFor)) settings.coachFor = DEFAULTS.coachFor;
    if (![0, BLACK, WHITE].includes(settings.human)) settings.human = DEFAULTS.human;
    if (![0, 2, 3, 4, 5].includes(settings.handicap)) settings.handicap = DEFAULTS.handicap;
    if (!Number.isFinite(settings.komi)) settings.komi = DEFAULTS.komi;
    game = Game.fromSGF(d.sgf);
    let n = game.root;
    for (const i of d.path || []) { if (!n.children[i]) break; n = n.children[i]; }
    game.goTo(n);
    resigned = d.resigned || 0;
    const at = path => { let n = game.root; for (const i of path || []) { if (!n.children[i]) return null; n = n.children[i]; } return n; };
    for (const e of d.dead || []) {
      const n = at(e.path);
      // Only stones actually on that board can be marked dead.
      if (n) n.scoredDead = new Set((e.points || []).filter(p => n.board.color[p] === BLACK || n.board.color[p] === WHITE));
    }
    restoreScoring = d.scoring ? at(d.scoring) : null;
    return true;
  } catch (e) {
    console.warn('Could not restore saved game', e);
    return false;
  }
}

function exportSGF() {
  const name = c => !settings.human ? colorName(c) : c === settings.human ? 'Human' : `GoYomi ${level().name}`;
  const end = game.line().at(-1), counted = finalScore();
  const result = resigned ? `${resigned === BLACK ? 'W' : 'B'}+R`
    : counted ? counted.text.replace('Draw (jigo)', '0') : '';
  // The line on show is written as the main line (the result is its result); other lines stay as variations.
  const text = game.toSGF({ black: name(BLACK), white: name(WHITE), result, main: end });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-go-sgf' }));
  a.download = `goyomi-${new Date().toISOString().slice(0, 10)}.sgf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function importSGF(text) {
  try {
    const g = Game.fromSGF(text);
    cancelAI();
    stopCoach();
    game = g;
    resetCoachHeight();
    settings.lastHuman = settings.human;
    settings.human = 0;
    settings.studyFromImport = true;
    mode = 'play'; scoring = null; resigned = 0; peek = null; armed = null;
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
  // After loading a game (study mode), offer the colour the player had before.
  f.elements.color.value = String(settings.studyFromImport ? settings.lastHuman : settings.human);
  f.elements.level.value = String(ladderLevel()); // a finished game moves the ladder
  f.elements.handicap.value = String(settings.handicap);
  f.elements.komi.value = String(settings.komi);
  dlg.returnValue = ''; // Esc keeps the previous returnValue, which would re-run newGame()
  dlg.showModal();
}

function setupDialog() {
  $('#levelList').innerHTML = LEVELS.map((l, i) =>
    `<label class="level"><input type="radio" name="level" value="${i}"><span><b>${i + 1} · ${l.name}</b><small>${l.blurb}</small></span></label>`).join('');
  const dlg = $('#newGameDlg'), f = dlg.querySelector('form');
  // Guarded: for a few minutes after a deploy a visitor can have the older page with this script.
  const cancel = $('#dlgCancel');
  if (cancel) cancel.onclick = () => dlg.close('cancel');
  f.elements.handicap.onchange = () => { f.elements.komi.value = +f.elements.handicap.value ? '0.5' : '7'; };
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    settings.human = +f.elements.color.value;
    settings.studyFromImport = false;
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
  $('#optEngine').value = settings.coachEngine;
  $('#optCoachFor').value = settings.coachFor;
  $('#optGradeAI').checked = settings.gradeAI;
  $('#optFindYourself').checked = settings.findYourself;
  $('#optLadder').checked = settings.ladder;
  $('#optSpeak').checked = settings.speak;
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
    // Cancelling the coach now would also cancel the dead-stone search.
    if (scoring && scoring.pending) { e.target.value = String(settings.coachPlayouts); return; }
    settings.coachPlayouts = +e.target.value;
    // Re-read positions at the new depth.
    const reset = n => { n.analysisDone = false; n.after = null; n.reads = null; n.checkMove = null; n.grade = null; n.children.forEach(reset); };
    reset(game.root);
    stopCoach();
    save(); scheduleCoach();
  };
  $('#optEngine').onchange = e => {
    if (scoring && scoring.pending) { e.target.value = settings.coachEngine; return; }
    settings.coachEngine = e.target.value;
    save();
    useCoachEngine();
  };
  $('#optCoachFor').innerHTML = COACH_FOR.map(o => `<option value="${o.key}">${o.label}</option>`).join('');
  $('#optCoachFor').onchange = e => { settings.coachFor = e.target.value; save(); render(); };
  $('#optGradeAI').onchange = e => {
    settings.gradeAI = e.target.checked;
    for (const n of game.line()) tryGrade(n);
    save(); render(); scheduleCoach();
  };
  $('#optFindYourself').onchange = e => { settings.findYourself = e.target.checked; save(); render(); };
  $('#optLadder').onchange = e => { settings.ladder = e.target.checked; save(); render(); };
  $('#coachBadge').onclick = () => $('.coach').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#optSound').onchange = e => { settings.sound = e.target.checked; setSoundEnabled(settings.sound); save(); if (settings.sound) playSound('stone'); };
  $('#optSpeak').onchange = e => { settings.speak = e.target.checked; setSpeech(settings.speak); save(); announce(settings.speak ? 'Speech on.' : 'Speech off.'); };
  if (!speechAvailable()) { $('#optSpeak').disabled = true; $('#speakNote').hidden = false; }
  // Hovering (or focusing) a point the coach mentions circles it on the board.
  const locate = p => { if (p !== locatePt) { locatePt = p; renderBoard(); } };
  const ptOf = el => { const t = el && el.closest ? el.closest('[data-pt]') : null; return t ? +t.dataset.pt : null; };
  const tryOf = el => el && el.closest ? el.closest('[data-act=try]') : null;
  const peekFrom = btn => {
    const node = btn ? nodeById(+btn.dataset.id) : null;
    // A preview kept on by a first click stays until it's ended (a tap elsewhere, a move, Esc):
    // pointing at or focusing anything else in the panel doesn't change it.
    if (ending || (armed && node !== armed)) return;
    peekAt(node);
  };
  const fbox = $('#feedback');
  fbox.addEventListener('pointerover', e => peekFrom(tryOf(e.target)));
  fbox.addEventListener('pointerout', e => { if (!armed && !tryOf(e.relatedTarget)) peekFrom(null); });
  fbox.addEventListener('focusin', e => {
    peekFrom(tryOf(e.target));
    if (peek) announce(`Coach's choice: ${ptName(peek.move)}${peek.pv.length > 1 ? ', then ' + peek.pv.slice(1, 4).map(m => ptName(m.move)).join(', ') : ''}.`);
  });
  fbox.addEventListener('focusout', e => { if (!armed && !tryOf(e.relatedTarget)) peekFrom(null); });
  // A tap outside the armed Try button ends its preview; one on the board plays nothing.
  document.addEventListener('keydown', () => { lastPointer = ''; }, true);
  document.addEventListener('pointerdown', e => {
    lastPointer = e.pointerType;
    swallowClick = false;
    if (!armed || (e.target.closest && e.target.closest('[data-act=try]'))) return;
    disarm();
    if (e.target.closest && e.target.closest('.board-svg')) swallowClick = true;
  }, true);
  for (const id of ['#feedback', '#warnings', '#threatBox', '#review']) {
    const box = $(id);
    box.addEventListener('pointerover', e => locate(ptOf(e.target)));
    box.addEventListener('pointerout', e => { if (ptOf(e.relatedTarget) === null) locate(null); });
    box.addEventListener('focusin', e => locate(ptOf(e.target)));
    box.addEventListener('focusout', () => locate(null));
  }

  $('#btnPass').onclick = humanPass;
  $('#btnUndo').onclick = takeBack;
  $('#btnHint').onclick = () => {
    hintOn = !hintOn;
    const an = game.current.analysis;
    if (hintOn && !an) flash('The coach is still reading this position…');
    render();
    // Screen readers and speech hear the hints too (mirror images named once).
    if (hintOn && an) {
      const names = [...new Map(hintList(an).map(h => [h.rank, ptName(h.move)])).values()];
      const why = hintWhy(game.current);
      announce((names.length ? `Best moves: ${names[0]} (best)${names.length > 1 ? ', then ' + names.slice(1).join(', ') : ''}.` : 'No hints here.') + (why ? ` ${plainText(why)}` : ''));
    }
  };
  $('#btnAI').onclick = () => aiMove(true, true);
  $('#btnThreat').onclick = toggleThreat;
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
    if (e.target instanceof Element) {
      // Leave typing alone, but a focused toggle or select must not swallow the game shortcuts.
      if (e.target.closest('textarea, dialog, input:not([type=checkbox]):not([type=radio])')) return;
      if (e.target.closest('select') && /^(Arrow|Home|End|Enter| )/.test(e.key)) return;
    }
    const k = e.key.toLowerCase();
    if (e.key === 'ArrowLeft') nav('prev');
    else if (e.key === 'ArrowRight') nav('next');
    else if (e.key === 'Home') nav('first');
    else if (e.key === 'End') nav('last');
    else if (e.key === 'PageUp') nav('prev');
    else if (e.key === 'PageDown') nav('next');
    else if (k === 's') { if (!$('#optSpeak').disabled) $('#optSpeak').click(); }
    else if (k === 'r') repeatLast();
    else if (k === 'u' || e.key === 'Backspace') takeBack();
    else if (k === 'h') $('#btnHint').click();
    else if (k === 'o') toggleThreat();
    else if (k === 'p') humanPass();
    else if (e.key === 'Escape') { peek = null; armed = null; hintOn = false; threat = null; scout.cancel(); render(); }
    else if (toggleKey[k]) {
      const key = toggleKey[k] === 'best' ? 'hints' : toggleKey[k];
      settings.show[key] = !settings.show[key];
      syncOptions(); save(); render();
    } else return;
    e.preventDefault();
  });
}

// ------------------------------------------------------------------ boot

initAnnouncer($('#announcer'));
setupControls();
setupDialog();
if (!load()) game = new Game({ komi: settings.komi, handicap: settings.handicap });
setSoundEnabled(settings.sound);
setSpeech(settings.speak);
syncOptions();
useCoachEngine();
afterChange();
if (restoreScoring && restoreScoring === game.current) enterScoring(true);

// Handy for debugging from the console.
window.dojo = {
  get game() { return game; },
  get settings() { return settings; },
  get mode() { return mode; },
  get scoring() { return scoring; },
  get aiThinking() { return !!aiNode; },
  // Saving: the page's storage (tests can make its writes fail) and whether the not-saved line is up.
  get storage() { return storage; },
  get notSaved() { return notSaved; },
  // The Try preview: on, and kept on by a first click (armed).
  get preview() { return { on: !!peek, armed: !!armed }; },
  render, aiMove,
  get coach() { return coach; },
  get opponent() { return builtin.opponent; },
  // Which engine the coach uses, and how fast KataGo runs here.
  get katago() { return { state: kata.state, ...kata.info }; },
  // Test hook: make KataGo fail as if its worker had crashed.
  failKata: (message = 'test failure') => kata.host && kata.host.fail(message),
  // Test hooks: play by name ("E5"), pass, take back, start a game with options.
  play: name => onClick(POINTS.find(p => ptName(p) === name.toUpperCase())),
  pass: humanPass,
  takeBack,
  // Sound tweaking: dojo.sounds.stone = new dojo.ZZFXSound([...]); dojo.playSound('stone')
  sounds: SOUNDS, playSound, ZZFXSound,
  newGame: (opts = {}) => { Object.assign(settings, opts); syncOptions(); newGame(); },
};
