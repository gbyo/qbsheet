# The arcade

QBSheet has two small games in it: QBBird and Snake. They exist because a room waiting twenty minutes
on tournament control is a real part of a tournament day, and a scoresheet is the application already
open on the Chromebook. They are deliberately the least important thing in the repository, and this
document is mostly a list of the ways they are kept that way.

## Where it is

    src/arcade/
      ArcadeLauncher.tsx   the entry point, and the only part in the scoring bundle
      ArcadeDialog.tsx     the picker, and whichever game it picked
      QBBird.tsx           a bird, some gravity, and a corridor of score columns
      Snake.tsx            a grid, a constant step, and a tail
      useArcadeLoop.ts     the one animation loop, and the promise that it stops
      arcadeCanvas.ts      fixed game units, scaled to whatever the layout gave it
      arcadePalette.ts     the scoresheet's own tokens, read from the live document
      arcadeScores.ts      two best scores, and nothing else that is remembered
      arcade.css           ships in the lazily loaded chunk with the games

Two entry points, one arcade.

The homepage offers a small promotional banner — **Want a break?** — which is the casual door, for a
room that is waiting rather than scoring. It is in `WelcomeScreen.tsx`, it renders only when there is
no unfinished game (a device that reloaded mid-round has a Resume button to find, and an animated
advertisement must not compete with it), and it is dismissible: `ArcadePromo.ts` owns the one key,
`qbsheet.arcade-promo.dismissed.v1`, which is versioned so a later promotion can decide to be seen
again. Dismissing it hides the banner and nothing else — the arcade itself is unaffected.

The scoresheet's Game menu offers **Take a break…** through the same `dialog` state as every other
infrequent action (see `scorerMenu.ts` and `Scorer.tsx`). That is the door for a scorekeeper already
sitting in front of a game.

Both render `ArcadeLauncher`, and there is no second implementation of anything for either. Device
Settings used to be a third door; it is not any more, because a preferences screen is not a feature
launcher.

The banner is also the one place in QBSheet allowed to be colourful and to move. It is a CSS
gradient and two radial-gradient dots — no image, no sprite, no font, nothing fetched — it animates
only `background-position` and a `transform`, so it can never move the page around it, and
`prefers-reduced-motion: reduce` returns it to a deliberate still picture rather than a paused one.
Its colours are `--arcade-promo-*` tokens with light, dark and raised-contrast values of their own,
so it never borrows the palette that means "warning" or "success".

## The rules it is built under

**It cannot touch a game.** Nothing under `src/arcade/` imports the scorer's state, the event
journal, the game store, QBJ, or tournament control, and nothing there can record a `ScoreEvent`.
The only thing it writes is two integers, under `qbsheet.arcade.qbbird.bestScore` and
`qbsheet.arcade.snake.bestScore`. `Arcade.test.tsx` plays a game on a live scoresheet and asserts
the scoresheet recorded nothing at all.

**It costs nothing when it is closed.** `useArcadeLoop` schedules no animation frame and adds no
listener unless a game is actually running, cancels the outstanding frame and removes the listener on
unmount, and stops when the document is hidden. Only the chosen game is mounted; returning to the
picker unmounts it. `ArcadeLifecycle.test.tsx` drives a fake frame queue and asserts the negative
directly — that after an unmount, running the queue again does nothing.

**It costs nothing when it has never been opened.** The games are behind a dynamic `import()`, so
they are a chunk of their own that a reloading Chromebook never fetches. The chunk lands in
`assets/`, which `vite.config.ts` precaches when the service worker installs, so an offline device
has it before anybody presses the entry.

**It never takes a key from the scoresheet.** The games listen on their own `<canvas>`, never on the
document, so their keys exist while the board has focus and nowhere else. Underneath, the scoresheet
is already inert: `keystrokeBelongsToControl` drops every keystroke while any dialog is open, which
is what the arcade is. Nothing globally disables keyboard scoring.

**It looks like QBSheet.** Every colour either game draws with is a `--room-*` token read from the
live document, so both follow the appearance the scorekeeper chose, including raised contrast. There
are no image, audio, or font assets: everything is drawn procedurally.

## References, and what was taken from them

Two open-source projects were read while working out the mechanics.

| Project                                                               | Licence                                                                                                | Used for                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [`pyforgedev/flappy-bird`](https://github.com/pyforgedev/flappy-bird) | MIT (`LICENSE`, Copyright (c) 2026 Masyura Fanni Ramadhan)                                             | The shape of a one-button flight game: acceleration, an impulse on input, obstacle pairs scrolling in, a point per pair passed. |
| [`matiasbeckerle/snake`](https://github.com/matiasbeckerle/snake)     | MIT stated in its README; no `LICENSE` file, and its README describes it as an adaptation of tutorials | Confirming the ordinary grid-Snake rules.                                                                                       |

**No code from either project is in this repository, and no asset from either is shipped.** Both
games were written for QBSheet. The flappy reference draws from sprite images and plays `.mp3` files;
neither is used here, and no Flappy Bird artwork, sound, branding, or font is copied — the name
QBBird and every pixel of it are QBSheet's own.

Because nothing was copied, no third-party copyright notice is required, and none has been added to
`NOTICE.md` — that file lists third-party code that is _in the built application_, and claiming a
dependency there that does not exist would be worse than saying nothing. The references are recorded
here and in the header of each game instead, which is the honest place for "we read this".

QBSheet remains AGPL-3.0-or-later. Nothing about the arcade changes that.

## Adding a third game

Add a component under `src/arcade/`, drive it with `useArcadeLoop` and `prepareFrame`, add an entry
to the `entries` array in `ArcadeDialog.tsx`, and — if it keeps a score — add a key to
`arcadeBestScoreKeys`. Nothing outside `src/arcade/` should need to change. If it does, the change is
probably not a game.

This is meant to stay small. It is not a platform, and QBSheet is not becoming one.
