# GoYomi · 9×9

Learn Go by playing. 9×9 games against an AI that scales from almost random
to genuinely strong, with a coach that grades every move, explains what
happened, and shows you what it would have played.

## ▶ [Play GoYomi in your browser](https://killedbyapixel.github.io/GoYomi/)

![GoYomi: a game in progress with the coach panel and game graph](social.png)

## What you get

- **An opponent at your level.** Nine AI levels from Pebble to Phoenix, all
  played by KataGo's neural network, plus handicap stones and komi. After a lopsided game it suggests a better match.
  Play Black, White, or both sides in study mode.
- **A coach that watches every move.** Win bar, expected score, and a grade
  for each move with a plain-language reason. It runs KataGo's neural
  network right in your browser. Set **Coach explains for** to
  match your experience: beginners hear about liberties and captures,
  stronger players about points, threats and plans. **Show** puts the
  coach's move on the board; **Try it instead** plays it for you.
- **Play by keyboard or by ear.** Tab to the board and play with the arrow
  keys and Enter. Screen readers hear every move and the coach's comments,
  or turn on **Speak announcements** to have them read aloud. Hover any
  point the coach mentions to see where it is on the board.
- **Hints when you want them.** Ask for the best moves, or press **Their
  idea** to see what your opponent is planning and what ignoring it costs.
- **See the board like a stronger player.** Overlays for liberties, atari
  alerts, territory, move preview and move numbers.
- **Take back freely.** Undo any move, try something else, and switch between
  the variations you've created.
- **Scoring made simple.** Pass twice and the coach counts the game, marking
  dead stones. Click a group if you disagree.
- **Review your games.** A game graph with mistakes marked. Click to jump to
  any move. Save and load SGF files. Your current game is saved automatically.

Keyboard shortcuts and a one-minute guide to the rules are in the game
itself.

## How strong is it?

Every level is KataGo's neural network, held back on purpose below Dragon:
the lower levels play on instinct without reading ahead, and choose among
their ideas more loosely, so their mistakes look like a learner's. In
self-play each level beat the one below it in 7 to 9 games out of 10, from
Pebble, which plays almost at random, up to Dragon.

For an outside yardstick, GNU Go 3.8 at its strongest setting (about 5 to 7
kyu on 9×9) sits around Reed: it beat Sprout 14 games to 6, lost to Reed 6
to 11, and lost all 20 of its games against River and against Dragon.
Phoenix, KataGo thinking longer, won 33 of its 37 decided games against
Dragon; it thinks for at most 10 seconds a move, so on slow devices it reads
less. Where KataGo can't run, GoYomi's own engine plays instead.

© 2026 Frank Force. Free and open source under the [GPL-3.0 license](LICENSE).
The AI and the coach use a [KataGo](https://github.com/lightvector/KataGo)
network ([license](nets/LICENSE.txt)) run with TensorFlow.js, ported with
help from [Web KaTrain](https://github.com/Sir-Teo/web-katrain) (MIT).
