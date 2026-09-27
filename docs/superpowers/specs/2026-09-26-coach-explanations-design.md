# Coach explanations that look ahead, matched to the player

Date: 2026-09-26. Status: design approved in conversation, awaiting spec review.

## Why

First player feedback on the coach (after the grading-accuracy work in `1fddcf1`):

- Explanations were sometimes false. A one-stone sacrifice block was described
  as "Keeps two enemy groups apart (a cut)", though the sequence never cut.
- The coach gave bad advice, "like attacking dead groups".
- A good move has two parts, and the coach only described the first: the
  threat that forces the opponent to answer, and the purpose it serves once they
  do. Example: "G3 threatens to capture one stone; when the opponent answers,
  its real purpose is to protect my lower side."
- Commentary should fit the player. Someone who doesn't understand liberties
  yet needs very different commentary from a club player.

Out of scope: a Capture Go mode, a configurable AI engine, pre-reading likely
moves to speed up grading (a separate follow-up).

## Decisions

1. **Setting "Coach explains for"**, in the Settings card under "Coach
   depth", with help text "Changes what the coach says, not how the AI plays."
   Options: *Match AI strength* (default), *Beginners*, *Improving players*,
   *Strong players*. Match AI strength maps AI levels 1–3 (Pebble, Seedling,
   Sprout) to Beginners, 4–5 (Reed, Stream) to Improving, 6–8 (River,
   Mountain, Dragon) to Strong. No first-launch prompt.
2. **Levels change both wording and what gets flagged** (see Wording).
3. **Setting "Grade AI moves"**, a checkbox, off by default. When off, AI
   moves get no grade, no check read and no threat/baseline reads; they get a
   short board-only note instead. In study mode (no AI), both colours count as
   the player's.
4. **Threat and purpose are read for the move being viewed**: the latest
   move, or an older move when the player steps back to it. Results are cached
   on the move. Background review reads only what grades need.
5. **Facts are separate from wording.** A new module works out what is true
   about a move as data; a small wording layer renders those facts for a level.

## Reads

Each graded move's node can carry up to five reads:

| Read | Position | Used for | Status |
|---|---|---|---|
| before | the parent position | grade, the coach's choice | exists |
| after | the position after the move | grade, expected continuation (PV), ownership | exists |
| check | after the coach's choice or runner-up | confirming the grade | exists |
| threat | after the move, then an opponent pass | the mover's follow-up and what ignoring it costs | new |
| baseline | the parent position, then a mover pass | what the move gains; what the opponent would otherwise play | new |

The threat and baseline recipes append a pass and set `resetPasses`, as
"Their idea" does, so the imaginary pass never ends the game.

Scheduling extends the coach queue in `app.js` (`coachWork` / `coachQueue`)
with the two new read kinds. Priority:

1. Position and check reads that grades need (current position, its parent,
   pending checks), as now.
2. Threat and baseline reads for the viewed move, only if that move is graded
   (a player move, or an AI move with "Grade AI moves" on).
3. Background position reads along the game line, for grades only.

The work-item key becomes `nodeId:kind[:move]`. Finished reads are stored on
the node (`node.reads.threat`, `node.reads.baseline`; checks stay in
`node.checks`).

## Facts (`src/explain.js`)

`moveFacts({ before, after, move, reads, level })` returns plain data. `before`
and `after` are Boards; `reads` holds whatever reads have finished, and facts
that need a missing read are simply absent. Three groups:

**Board facts** (no reads needed; today's `explainMove` rules, moved here):
capture (count, ko), atari / double atari and whether a ladder or net traps the
stones, rescue from atari and whether the stones are still in danger,
self-atari, filling an own eye, connecting groups, shape (extend, diagonal,
contact, opening height, first line early).

**Look-ahead facts** (need the after read):

- *cut*: only when the two enemy groups are still separate chains after the
  after read's principal variation (up to 8 moves) is played on a scratch
  board, and the cutting stone's ownership in the after read favours the
  mover (> 0.3).
- *sacrifice*: the moved stone's ownership in the after read strongly favours
  the opponent (< −0.5) and the move's grade is not a mistake or blunder.
  Replaces the false "cut".
- *deadTarget*: the move ataris or attacks enemy stones whose ownership in the
  before read already favours the mover (> 0.6). Worded as "those stones were
  already dead", never as praise.
- *hopelessRescue*: the move saves stones from atari but their ownership in the
  after read still favours the opponent (< −0.5).

**Threat and purpose** (need the threat and baseline reads):

- *threat*: the threat read's best move for the mover, the board facts of
  that move on the threat position (captures N, cuts, ataris), and its worth:
  threat-read score minus after-read score, from the mover's side. No threat
  when the worth is below 2 points.
- *initiative*: sente when the after read's expected reply is within distance
  2 of the move or answers the threat, gote otherwise.
- *purpose*: per-point ownership gain, after read minus baseline read, from the
  mover's side, summed into nine regions (four 3×3 corners, four sides,
  centre). The biggest region or two are reported, as *protects* (the mover
  owned it in the before read), *reduces* (the opponent owned it) or *claims*
  (neutral), with an approximate point value (sum / 2, as today).
- *otherwise*: the baseline read's best opponent move ("otherwise White
  plays E4") and its value.

**The coach's own suggestions.** When a read finishes, if its top move plays
at a point the mover already owns firmly (ownership ≥ 0.8, e.g. capturing dead
stones inside settled territory) and the runner-up is within 0.5 points and 2%
win chance, the two are swapped. Applied once per read, so hints, "Show",
"Try" and grades agree.

## Wording

`describe(facts, grade, level)` returns the grade label and the lines to show.

| | Beginners | Improving | Strong |
|---|---|---|---|
| Labels | Good move / Mistake / Big mistake | Best / Good / Mistake / Blunder | Best / Good / Inaccuracy / Mistake / Blunder |
| Flagged | ≥ 4 points, or loses stones | ≥ 4 points | as today |
| Numbers | none: stones and liberties | points | points and win % |
| Game graph, review summary | flagged moves only | flagged moves only | as today |

Mapping from the underlying grade: Beginners show best/good/inaccuracy as
"Good move", mistake as "Mistake", blunder as "Big mistake"; a move that loses
stones is flagged as a Mistake even under 4 points. A move loses stones when
some of the mover's stones had ownership > 0.3 for the mover in the before
read and < −0.5 in the after read (the search expects them captured). Improving
shows inaccuracy as "Good".

Beginner-only lines (board facts, instant): "Your group now has 2 liberties.
Careful." / "White's stone at D4 has 1 liberty left: you can capture it." /
mistakes explained in stones where possible ("White can now capture your 3
stones at C4"). The coach panel's "Expected result" line is hidden for
Beginners. Win bar, hints, "Show" and "Try" are unchanged at every level.

Example, the tester's G3 move:

- Beginners: "Good move. Puts the White stone at G4 in atari: it has only 1
  liberty left. White has to save it, and then your stones guard the bottom of
  the board."
- Improving: "Good. Threatens to capture G4 (worth about 6 points). Once White
  answers at H4, it secures your lower side, and you get to play elsewhere
  next (sente)."
- Strong: "Best move. Sente: threatens G4 (≈6 pts). After H4 it secures the
  lower side (+8). Otherwise White plays G3 (≈5 pts)."

AI moves with "Grade AI moves" off, all levels: urgent board facts only, e.g.
"White played D4. Your 2 stones at C3 are now in atari." (atari on the
player's stones, captures, confirmed cuts).

## Testing

- Facts: unit tests on `Board.fromRows` positions with hand-made reads
  (ownership arrays, PVs), including regressions for the sacrifice block called
  a cut, an atari on dead stones, a G3-style threat and purpose, and a
  hopeless rescue.
- Threat and purpose with real searches: a few seeded tests on clear-cut
  positions, in the style of `test/mcts.test.js`.
- Wording: each fact bundle at all three levels; Beginner text contains no
  point values or percentages; labels match the table.
- Level grade mapping and flagging: unit tests.
- `tools/explain-demo.js` prints all three levels for sample positions.
- Browser: a short game at each level with the headless Playwright driver;
  no console errors, screenshots checked, AI moves show only the note when
  "Grade AI moves" is off.
