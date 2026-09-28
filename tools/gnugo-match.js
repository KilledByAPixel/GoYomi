// Plays GoYomi's AI against GNU Go or KataGo over GTP (the Go Text Protocol).
//
//   node tools/gnugo-match.js --gnugo path/to/gnugo.exe --level 8 --gnulevel 10 --games 20 --jobs 4
//   node tools/gnugo-match.js --katago path/to/katago.exe --model net.bin.gz --visits 50 --games 20 --jobs 4
//
// --level     GoYomi AI level, 1 (Pebble) to 9 (Phoenix)          default 8
// --engine    how GoYomi's level plays: katago or builtin (its fallback) default katago
// --gnulevel  GNU Go strength, 0 to 10 (10 is its strongest)    default 10
// --katago    play KataGo instead of GNU Go (path to katago.exe)
// --model     KataGo network file (required with --katago)
// --config    KataGo GTP config        default: default_gtp.cfg next to katago.exe
// --visits    KataGo visits per move (its strength)             default 100
// --profile   imitate human players of a rank instead, e.g. rank_5k, rank_1d
//             (needs --human-model b18c384nbt-humanv0.bin.gz; config default
//             gtp_human5k_example.cfg next to katago.exe)
// --games     number of games; colours alternate                default 10
// --jobs      games played in parallel (one process each)       default 1
// --komi      komi for White                                    default 7
// --sgf       write the games to this SGF file
//
// Each game is scored by the opponent engine's final_score under area rules,
// as an independent referee. GoYomi's own count is recorded too; disagreements
// are shown. GoYomi moves exactly as the app's AI does: same search, playouts
// and move choice. KataGo plays GoYomi's rules: Chinese area scoring (dead
// stones removed at the end), positional superko, no suicide.
import { spawn, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { BLACK, WHITE, PASS, ptName, parsePt } from '../src/board.js';
import { Search, seed } from '../src/mcts.js';
import { Game } from '../src/game.js';
import { LEVELS, estimateDead } from '../src/coach.js';
import { Evaluator } from '../src/katago/evaluator.js';
import { loadNet } from './katago-node.js';
import { levelMove } from './play-level.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const opts = {
  // An absolute path: Cygwin builds of GNU Go re-launch themselves by the path given and fail on a relative one.
  gnugo: arg('gnugo') ? resolve(arg('gnugo')) : 'gnugo',
  level: +arg('level', 8) - 1,
  engine: arg('engine', 'katago'),
  gnulevel: +arg('gnulevel', 10),
  katago: arg('katago') ? resolve(arg('katago')) : null,
  model: arg('model') ? resolve(arg('model')) : null,
  visits: +arg('visits', 100),
  games: +arg('games', 10),
  jobs: +arg('jobs', 1),
  komi: +arg('komi', 7),
  maxMoves: 250,
};
if (opts.katago && !opts.model) throw new Error('--katago needs --model (a KataGo network file)');
opts.profile = arg('profile');
opts.humanModel = arg('human-model') ? resolve(arg('human-model')) : null;
if (opts.profile && !opts.humanModel) throw new Error('--profile needs --human-model (b18c384nbt-humanv0.bin.gz)');
opts.config = opts.katago && resolve(arg('config') || join(dirname(opts.katago), opts.profile ? 'gtp_human5k_example.cfg' : 'default_gtp.cfg'));
// The opponent's name in the results.
const THEM = !opts.katago ? `GNU Go L${opts.gnulevel}` : opts.profile ? `KataGo ${opts.profile}` : `KataGo ${opts.visits}v`;

// KataGo's command line: plain search at a fixed number of visits, or human-style play at a rank.
function katagoArgs() {
  const over = opts.profile
    ? `logDir=,delayMoveScale=0,delayMoveMax=0,humanSLProfile=${opts.profile}${arg('visits') ? `,maxVisits=${opts.visits}` : ''}`
    : `logDir=,maxVisits=${opts.visits},numSearchThreads=${Math.min(8, Math.max(1, opts.visits))}`;
  return ['gtp', '-model', opts.model, '-config', opts.config, ...(opts.profile ? ['-human-model', opts.humanModel] : []), '-override-config', over];
}

// ------------------------------------------------------------------ GTP client

class Gtp {
  constructor(cmd, args) {
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    this.buf = '';
    this.waiting = [];
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => { this.buf += d.replace(/\r/g, ''); this.drain(); });
    const fail = e => { for (const w of this.waiting) w.reject(e); this.waiting = []; };
    this.proc.on('error', fail);
    // If the engine dies, say so instead of leaving the game waiting (the worker would exit silently).
    this.proc.on('exit', code => fail(new Error(`${THEM} exited (code ${code})`)));
  }
  drain() {
    let i;
    while (this.waiting.length && (i = this.buf.indexOf('\n\n')) >= 0) {
      const reply = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 2);
      const w = this.waiting.shift();
      if (reply.startsWith('=')) w.resolve(reply.slice(1).trim());
      else w.reject(new Error(`GTP "${w.cmd}": ${reply}`));
    }
  }
  send(cmd) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ cmd, resolve, reject });
      this.proc.stdin.write(cmd + '\n');
    });
  }
  async close() { try { await this.send('quit'); } catch { /* already gone */ } this.proc.kill(); }
}

// ------------------------------------------------------------------ one game

const gtpColor = c => (c === BLACK ? 'black' : 'white');

// One network per process, loaded on first use.
let evaluatorOnce = null;
const sharedEvaluator = async () => evaluatorOnce || (evaluatorOnce = new Evaluator((await loadNet()).net));

async function playGame(index) {
  const ours = index % 2 === 0 ? BLACK : WHITE; // alternate colours
  const lv = LEVELS[opts.level];
  seed((index + 1) * 7919);
  const gnu = opts.katago
    ? new Gtp(opts.katago, katagoArgs())
    : new Gtp(opts.gnugo, ['--mode', 'gtp', '--boardsize', '9', '--chinese-rules',
      '--komi', String(opts.komi), '--level', String(opts.gnulevel), '--seed', String(index + 1)]);
  await gnu.send('boardsize 9');
  await gnu.send('clear_board');
  if (opts.katago) {
    // Chinese rules count dead stones as captured when both pass ("friendly pass");
    // a bare area rule set would count the board as it stands. Then GoYomi's ko rule.
    for (const cmd of ['kata-set-rules chinese', 'kata-set-rule ko POSITIONAL', 'kata-set-rule whiteHandicapBonus 0']) await gnu.send(cmd);
  }
  await gnu.send(`komi ${opts.komi}`);

  const game = new Game({ komi: opts.komi });
  let resigned = 0;
  const t0 = Date.now();
  while (!game.isOver() && game.current.depth < opts.maxMoves) {
    const c = game.toPlay;
    let move;
    if (c === ours) {
      const evaluator = opts.engine === 'katago' ? await sharedEvaluator() : null;
      ({ move } = await levelMove(game, lv, { engine: opts.engine, evaluator, komi: opts.komi }));
      await gnu.send(`play ${gtpColor(c)} ${ptName(move)}`);
    } else {
      const reply = (await gnu.send(`genmove ${gtpColor(c)}`)).toUpperCase();
      if (reply === 'RESIGN') { resigned = c; break; }
      move = parsePt(reply);
      if (move === null || !game.check(move).ok) throw new Error(`game ${index + 1}: ${THEM} played ${reply}, not legal here`);
    }
    game.play(move);
  }

  let winner, result, oursCount = '';
  if (resigned) {
    winner = 3 - resigned;
    result = `${winner === BLACK ? 'B' : 'W'}+R`;
  } else {
    result = (await gnu.send('final_score')).toUpperCase(); // e.g. B+3.0, W+12.5, 0
    winner = result.startsWith('B+') ? BLACK : result.startsWith('W+') ? WHITE : 0;
    // GoYomi's own count, the way the app now does it (position played out).
    const final = game.board.clone(); final.passes = 0;
    const s = new Search(final, { komi: opts.komi }); s.run(4000);
    oursCount = game.score(estimateDead(game.board, s.results().ownership)).text;
  }
  await gnu.close();
  return {
    game: index + 1, ours: ours === BLACK ? 'B' : 'W', winner: winner === ours ? 'GoYomi' : winner ? THEM : 'draw',
    result, oursCount, moves: game.current.depth, minutes: +((Date.now() - t0) / 60000).toFixed(1),
    sgf: game.toSGF({ black: ours === BLACK ? `GoYomi ${lv.name}` : THEM,
      white: ours === WHITE ? `GoYomi ${lv.name}` : THEM, result }),
  };
}

// ------------------------------------------------------------------ driver

if (process.argv.includes('--worker')) {
  const index = +arg('index', 0);
  playGame(index).then(r => process.send(r), e => process.send({ game: index + 1, error: e.message }));
} else {
  const self = fileURLToPath(import.meta.url);
  const lvName = LEVELS[opts.level].name;
  console.log(`GoYomi ${lvName} (level ${opts.level + 1}) vs ${THEM}, ${opts.games} games, komi ${opts.komi}, ${opts.jobs} at a time`);
  const results = [];
  let next = 0;
  const runOne = () => new Promise(resolve => {
    if (next >= opts.games) return resolve();
    const index = next++;
    const child = fork(self, [...process.argv.slice(2), '--worker', '--index', String(index)]);
    child.on('message', r => {
      results.push(r);
      if (r.error) console.log(`game ${r.game}: ERROR ${r.error}`);
      else console.log(`game ${String(r.game).padStart(2)}: GoYomi as ${r.ours}  ${r.winner.padEnd(Math.max(6, THEM.length))}  ${r.result.padEnd(7)} (GoYomi counts ${r.oursCount || '-'})  ${r.moves} moves, ${r.minutes} min`);
    });
    child.on('exit', () => resolve(runOne()));
  });
  await Promise.all(Array.from({ length: Math.min(opts.jobs, opts.games) }, runOne));

  const ok = results.filter(r => !r.error);
  const wins = ok.filter(r => r.winner === 'GoYomi').length, losses = ok.filter(r => r.winner === THEM).length;
  const byColor = col => { const g = ok.filter(r => r.ours === col); return `${g.filter(r => r.winner === 'GoYomi').length}/${g.length}`; };
  const disagree = ok.filter(r => r.oursCount && r.oursCount.startsWith('B') !== r.result.startsWith('B')).length;
  console.log(`\nRESULT GoYomi ${lvName} ${wins} - ${losses} ${THEM}` +
    `  (as Black ${byColor('B')}, as White ${byColor('W')}; ${ok.length - wins - losses} draws, ${results.length - ok.length} errors)`);
  console.log(`Counting: GoYomi and ${THEM} disagreed on the winner in ${disagree} of ${ok.filter(r => r.oursCount).length} counted games`);
  if (arg('sgf')) {
    const fs = await import('node:fs');
    fs.writeFileSync(arg('sgf'), ok.sort((a, b) => a.game - b.game).map(r => r.sgf).join('\n'));
    console.log(`SGFs written to ${arg('sgf')}`);
  }
}
