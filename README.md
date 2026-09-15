# Go Dojo · 9×9

A 9×9 Go game you play in the browser against a Monte-Carlo AI, with a coach
that grades and explains moves as you go. Built for learning.

```
node serve.js 8115      # then open http://localhost:8115
npm test                # rules, search, game record and coach tests
```

No build step and no dependencies. ES modules plus Web Workers, which is why
it needs the tiny static server rather than opening `index.html` from disk.

## What it does

- **Play** as Black or White against six AI levels (Pebble → Dragon), with
  handicap and komi, or play both colours in **study mode**.
- **Take back** any move. Nothing is lost: the game is a tree, so trying another
  move after a take-back creates a variation you can switch between.
- **Coach** (a second engine in its own worker) reads every position in the
  background:
  - win bar and expected score
  - a grade for your move *and* the AI's reply (best / good / inaccuracy /
    mistake / blunder), in points lost, with **Show** (coach's move plus the
    expected continuation as numbered stones) and **Try it instead**
  - plain-language explanations: captures, atari, double atari, saving stones,
    connecting, cutting, self-atari warnings, filling your own eye, area swings
  - live warnings for groups in atari (yours and theirs)
  - a game graph (win % and score lead) with mistakes marked; click to jump
- **Board overlays**: liberties on every group, atari alerts, territory and
  dead-stone estimate, move preview on hover (✕ on stones you'd capture, new
  ataris, your stone's liberties, and why a move is illegal), best moves with
  win %, move numbers.
- **Scoring**: after two passes the coach marks dead stones. Click groups to
  fix them. Area (Chinese) count, with the Japanese count shown too.
- SGF save/load, autosave to localStorage, keyboard shortcuts, synthesised
  stone sounds.

## Code map

| file | role |
|---|---|
| `src/board.js` | fast board: chains as linked lists, pseudo-liberties with sum/sum² atari test, Zobrist hash, empty-point list |
| `src/patterns.js` | MoGo 3×3 playout patterns expanded to a 64k lookup table |
| `src/mcts.js` | MCTS + RAVE (michi-style priors), heuristic playouts, score-aware reward, ownership, principal variations |
| `src/game.js` | game tree, rule checks with reasons (ko, suicide, superko), scoring, SGF |
| `src/coach.js` | AI levels, move choice, pass decision, dead stones, move grading, explanations |
| `src/engine-worker.js`, `src/engine-client.js` | search in a worker with progress streaming |
| `src/view.js`, `src/graph.js`, `src/sound.js`, `src/app.js` | UI |
| `tools/bench.js` | playout speed |
| `tools/selfplay.js` | equal-time A/B self-play between parameter sets |
