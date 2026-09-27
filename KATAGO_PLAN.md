# Plan: KataGo in the browser for GoYomi

Handoff brief for a cloud session. Delete this file in the final commit before the PR.

## Goal

Run a small KataGo neural network in the browser. Use it as the coach's engine by
default, and as a new top AI level. Keep the built-in Monte Carlo engine for the
existing AI levels, and as an automatic fallback when KataGo can't load or runs too
slowly. Players get a switch between the two.

**Why this is worth it.** The built-in engine is roughly a 3 kyu on 9×9. The
~2 MB KataGo network with 64 visits a move beat it 6–0, mostly by 70–89 points. So
the coach's grades, explanations and hints would come from a far stronger engine,
and the download stays small.

## The project in brief

- **GoYomi.** A 9×9 Go web app in plain ES modules, with no framework and no
  bundler in development. `index.html` loads `src/app.js`. It is served statically
  from the repo root on GitHub Pages. `tools/build.js` makes `dist/`, which is
  gitignored and used for itch.io uploads.
- **Tests.** `npm test` (`node --test test/*.test.js`). Keep every test passing,
  and add tests for new logic.
- **Style.** Match the surrounding code: terse comments that explain why, the same
  idioms, and small functions. Commit as you go, in small, well-described commits.
  The README is a player guide: short, and no technical detail beyond a line or
  two.
- **Engine interface.** The whole app talks to its engine through the `Engine` and
  `EnginePool` classes in `src/engine-client.js`.
  - `search(recipe, { playouts, maxTime, onProgress, reportMs })` returns a promise
    for results. Starting a new search cancels the old one.
  - The recipe is `{ setup, moves, whiteFirst, komi, resetPasses }`, from
    `Game.recipe()` in `src/game.js`. `komi` already includes the handicap bonus.
  - The worker (`src/engine-worker.js`) rebuilds the board and superko history,
    then streams `progress` and `done` messages.
  - Results come from `Search.results()` in `src/mcts.js`:
    - `toPlay`, `playouts`
    - `winrate` for the side to move, and `blackWinrate`
    - `score`: Black minus White, komi included
    - `ownership`: 81 values, row by row from the top, +1 for Black
    - `moves` (the top 40 when done) and `allMoves`, each
      `{ move, visits, winrate (mover's), score (Black's), prior, pv: [moves after it] }`,
      sorted by visits.

  `src/coach.js` (grading), `src/explain.js` (move facts) and `src/app.js` all read
  that shape, so a KataGo engine must return exactly it.
- **Playout counts.** Some code assumes the built-in engine's counts. The coach
  depth setting is 16k/48k/120k playouts. App code checks `results.playouts` against
  thresholds such as 1500, 4000 and 8000. `tools/coach-audit.js` uses deep reads as
  an oracle. Search `src/app.js` and `src/coach.js` for these and map them to
  sensible KataGo visit counts.
- **Rules.** Area scoring with dead stones removed at the end, positional superko,
  no suicide, and komi 7 by default. In handicap games White gets +1 per handicap
  stone, already folded into `komi`.

## What is on this branch

- **`nets/kata1-b6c96-s175395328-d26788732.txt.gz`.** A 6-block, 96-channel KataGo
  network: model version 8, 22 spatial and 19 global input channels, about 1.03 M
  parameters. It is in KataGo's *text* format, with weights as ASCII floats and each
  array spread over several lines. Its license is in `nets/LICENSE.txt`
  (MIT-style), which must ship next to the network.
- **`test/fixtures/katago-b6c96-reference.json`.** Native KataGo v1.18.1
  `kata-raw-nn 0` outputs (symmetry 0) from this network for 12 positions:
  - several stages of a real game
  - komi 0.5 with White to play
  - a position after a pass
  - an active ko

  Each entry has the move list, komi and side to move, plus `whiteWin`,
  `whiteLoss`, `noResult`, `whiteLead`, `whiteScoreSelfplay`, `policy` (81 values,
  row by row from the top, A..J, `null` for illegal moves), `policyPass` and
  `whiteOwnership`. They were computed under Chinese rules (area, friendly pass),
  positional superko, no suicide and no handicap bonus, which is exactly GoYomi's
  setup. **The JavaScript port must reproduce these outputs.** That is the
  correctness check for input features, weights and the forward pass.

## Code to reuse

[Web KaTrain](https://github.com/Sir-Teo/web-katrain) is MIT-licensed. Its
`src/engine/katago/` folder runs KataGo networks with TensorFlow.js: WebGPU first,
then WASM, then CPU. The parts worth porting to plain JS (drop the types) are:

| File | What it does |
|---|---|
| `binModelParser.ts` | reads the model's token stream |
| `loadModelV8.ts` | the model structure, versions 8–16 |
| `modelV8.ts` | builds the network in TF.js |
| `featuresV7.ts`, `positionInputsV7.ts` | input features |
| `evalV8.ts`, `scoreValue.ts` | turn outputs into values and scores |

Keep its MIT copyright notice in the ported files' headers, and add a line to
`LICENSE`/README credits. Its `analyzeMcts.ts` is 177 KB: don't port it. Write a
compact search instead (see below).

Its parser only reads the binary (`@BIN@`) format. Either make the float reader
also accept ASCII floats (the reader is count-driven, so this is easy), or write
`tools/convert-net.js` to turn the text network into a compact binary file. Ideally
use float16, since about 2 MB is the target download.

## Steps, each with its check

1. **Load the network and run a forward pass in Node.** Use TF.js's CPU backend as
   a dev dependency. Build the input features from a GoYomi board plus move
   history, matching KataGo's: history planes, the ko ban, komi and rules encoding,
   and the pass/area flags. Write a test that runs all 12 fixture positions. Aim
   for:
   - policy within about 1e-3 absolute
   - win/loss within about 2e-3
   - `whiteLead` within about 0.05
   - ownership within about 5e-3

   Note the perspective: the fixtures are from White's side. Don't move on until
   the outputs match.
2. **Search.** Write `src/katago/search.js`, a PUCT search guided by the network:
   - policy priors, value backup and KataGo-style FPU
   - superko via the same `forbidden` check the worker uses
   - pass handling that doesn't pass away won or lost stones: two passes end the
     game and are scored by area with the network's ownership used for dead stones
   - averaged ownership and score, and a principal variation
   - batched evaluations if easy (small batches help WebGPU)

   It must return the results shape above, with `playouts` = visits. Test it in
   Node on simple tactical positions: it must capture a stone in atari, save its
   own, see a ladder, and pass at the end of a finished game.
3. **Worker.** Write `src/katago-worker.js` with the same message protocol as
   `engine-worker.js` (search, stop, progress, done).
   - Load TF.js lazily and pick a backend: WebGPU, then WebGL, then WASM, then CPU.
   - Load the network once. Report the backend and evaluations per second.
   - Vendor pinned TF.js files under `vendor/` so the game still works offline and
     on itch.io. If the size is unreasonable, load from cdn.jsdelivr.net pinned to
     a version instead, and say which you chose and why in the PR.
   - Make `tools/build.js` copy `nets/` and `vendor/` into `dist/`.
4. **Engine choice.**
   - `engine-client.js` gets a KataGo engine class with the same interface. The
     app picks per role: coach, opponent, scout, counting.
   - A settings control: "Coach engine: KataGo / Built-in". The default is KataGo.
   - Fall back to the built-in engine automatically, with one short message, if the
     network fails to load or a quick benchmark on first use is too slow for the
     coach to be useful. Pick a threshold and justify it.
   - Map Coach depth Quick/Normal/Deep to visit counts that suit the speed you
     measure, and scale them down on slow devices.
   - Keep the game fully usable while the network loads.
5. **AI levels.**
   - Keep the 8 existing levels (Pebble to Dragon) on the built-in engine; their
     weakness is tuned.
   - Add one level above Dragon on KataGo at a fixed visit count, and give it a
     name that fits the series.
   - Check it with `tools/levels.js` or a node match against Dragon. It should win
     clearly.
6. **Coach tuning.** The grading thresholds and double-check logic in `coach.js`
   were tuned for a noisy playout engine.
   - Re-measure with `tools/coach-audit.js`, adapted to use KataGo reads, with deep
     KataGo reads as the oracle.
   - Adjust thresholds only where the numbers say so, and report before/after in
     the PR.
   - Run `tools/explain-demo.js`, adapted to the KataGo engine, and read the
     output. The explanation code relies on ownership, and KataGo's ownership is
     much sharper, so look for comments that became wrong or noisy.
7. **Finish.**
   - README: one or two player-facing lines, e.g. that the coach runs KataGo's
     neural network in your browser, with credit. No technical detail.
   - Delete this file.
   - Open a PR from `katago-coach` to `master`.

## What the PR should report

- How closely the fixtures match (the largest error per output).
- Evaluations per second in Node on the CPU backend.
- The new level's result against Dragon.
- Coach-audit numbers before and after.
- Anything left unfinished.
- A short checklist for Frank to test locally. The cloud has no GPU or phone, so
  include:
  - evaluations per second and backend in Chrome with WebGPU and in Firefox
  - a phone
  - first-load time
  - that the fallback kicks in

  Make the backend and evaluations per second visible somewhere he can read them,
  for example in the status line or on `window.dojo`.

## Out of scope

- Human-style rank play.
- Larger networks.
- A KataGo server or native bridge.
