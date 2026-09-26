// Plays GoYomi's AI against GNU Go over GTP (the Go Text Protocol).
//
//   node tools/gnugo-match.js --gnugo path/to/gnugo.exe --level 8 --gnulevel 10 --games 20 --jobs 4
//
// --level     GoYomi AI level, 1 (Pebble) to 8 (Dragon)        default 8
// --gnulevel  GNU Go strength, 0 to 10 (10 is its strongest)    default 10
// --games     number of games; colours alternate                default 10
// --jobs      games played in parallel (one process each)       default 1
// --komi      komi for White                                    default 7
//
// Each game is scored by GNU Go's final_score under Chinese (area) rules, as an
// independent referee. GoYomi's own count is recorded too; disagreements are shown.
// GoYomi moves exactly as the app's AI does: same search, playouts and move choice.
import { spawn, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BLACK, WHITE, PASS, ptName, parsePt } from '../src/board.js';
import { Search, seed } from '../src/mcts.js';
import { Game } from '../src/game.js';
import { LEVELS, chooseMove, shouldPass, estimateDead } from '../src/coach.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const opts = {
  gnugo: arg('gnugo', 'gnugo'),
  level: +arg('level', 8) - 1,
  gnulevel: +arg('gnulevel', 10),
  games: +arg('games', 10),
  jobs: +arg('jobs', 1),
  komi: +arg('komi', 7),
  maxMoves: 250,
};

// ------------------------------------------------------------------ GTP client

class Gtp {
  constructor(cmd, args) {
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    this.buf = '';
    this.waiting = [];
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => { this.buf += d.replace(/\r/g, ''); this.drain(); });
    this.proc.on('error', e => { for (const w of this.waiting) w.reject(e); this.waiting = []; });
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

async function playGame(index) {
  const ours = index % 2 === 0 ? BLACK : WHITE; // alternate colours
  const lv = LEVELS[opts.level];
  seed((index + 1) * 7919);
  const gnu = new Gtp(opts.gnugo, ['--mode', 'gtp', '--boardsize', '9', '--chinese-rules',
    '--komi', String(opts.komi), '--level', String(opts.gnulevel), '--seed', String(index + 1)]);
  await gnu.send('boardsize 9');
  await gnu.send('clear_board');
  await gnu.send(`komi ${opts.komi}`);

  const game = new Game({ komi: opts.komi });
  let resigned = 0;
  const t0 = Date.now();
  while (!game.isOver() && game.current.depth < opts.maxMoves) {
    const c = game.toPlay;
    let move;
    if (c === ours) {
      const s = new Search(game.board, { komi: opts.komi, forbidden: p => !game.check(p).ok });
      s.run(lv.playouts);
      let r = s.results(60);
      // As in the app: after the opponent passes, decide with at least 4000 playouts.
      let passInfo = r;
      if (game.board.lastMove === PASS && game.current.parent && r.playouts < 4000) {
        const s2 = new Search(game.board, { komi: opts.komi, forbidden: p => !game.check(p).ok });
        s2.run(4000);
        passInfo = s2.results(60);
      }
      move = shouldPass(game, passInfo, c) ? PASS : chooseMove(r, lv);
      if (move !== PASS && !game.check(move).ok) {
        move = (r.allMoves || r.moves).map(m => m.move).find(m => m !== PASS && game.check(m).ok) ?? PASS;
      }
      await gnu.send(`play ${gtpColor(c)} ${ptName(move)}`);
    } else {
      const reply = (await gnu.send(`genmove ${gtpColor(c)}`)).toUpperCase();
      if (reply === 'RESIGN') { resigned = c; break; }
      move = parsePt(reply);
      if (move === null || !game.check(move).ok) throw new Error(`game ${index + 1}: GNU Go played ${reply}, not legal here`);
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
    game: index + 1, ours: ours === BLACK ? 'B' : 'W', winner: winner === ours ? 'GoYomi' : winner ? 'GNU Go' : 'draw',
    result, oursCount, moves: game.current.depth, minutes: +((Date.now() - t0) / 60000).toFixed(1),
    sgf: game.toSGF({ black: ours === BLACK ? `GoYomi ${lv.name}` : `GNU Go L${opts.gnulevel}`,
      white: ours === WHITE ? `GoYomi ${lv.name}` : `GNU Go L${opts.gnulevel}`, result }),
  };
}

// ------------------------------------------------------------------ driver

if (process.argv.includes('--worker')) {
  const index = +arg('index', 0);
  playGame(index).then(r => process.send(r), e => process.send({ game: index + 1, error: e.message }));
} else {
  const self = fileURLToPath(import.meta.url);
  const lvName = LEVELS[opts.level].name;
  console.log(`GoYomi ${lvName} (level ${opts.level + 1}) vs GNU Go level ${opts.gnulevel}, ${opts.games} games, komi ${opts.komi}, ${opts.jobs} at a time`);
  const results = [];
  let next = 0;
  const runOne = () => new Promise(resolve => {
    if (next >= opts.games) return resolve();
    const index = next++;
    const child = fork(self, [...process.argv.slice(2), '--worker', '--index', String(index)]);
    child.on('message', r => {
      results.push(r);
      if (r.error) console.log(`game ${r.game}: ERROR ${r.error}`);
      else console.log(`game ${String(r.game).padStart(2)}: GoYomi as ${r.ours}  ${r.winner.padEnd(6)}  ${r.result.padEnd(7)} (GoYomi counts ${r.oursCount || '-'})  ${r.moves} moves, ${r.minutes} min`);
    });
    child.on('exit', () => resolve(runOne()));
  });
  await Promise.all(Array.from({ length: Math.min(opts.jobs, opts.games) }, runOne));

  const ok = results.filter(r => !r.error);
  const wins = ok.filter(r => r.winner === 'GoYomi').length, losses = ok.filter(r => r.winner === 'GNU Go').length;
  const byColor = col => { const g = ok.filter(r => r.ours === col); return `${g.filter(r => r.winner === 'GoYomi').length}/${g.length}`; };
  const disagree = ok.filter(r => r.oursCount && r.oursCount.startsWith('B') !== r.result.startsWith('B')).length;
  console.log(`\nRESULT GoYomi ${lvName} ${wins} - ${losses} GNU Go L${opts.gnulevel}` +
    `  (as Black ${byColor('B')}, as White ${byColor('W')}; ${ok.length - wins - losses} draws, ${results.length - ok.length} errors)`);
  console.log(`Counting: GoYomi and GNU Go disagreed on the winner in ${disagree} of ${ok.filter(r => r.oursCount).length} counted games`);
  if (arg('sgf')) {
    const fs = await import('node:fs');
    fs.writeFileSync(arg('sgf'), ok.sort((a, b) => a.game - b.game).map(r => r.sgf).join('\n'));
    console.log(`SGFs written to ${arg('sgf')}`);
  }
}
