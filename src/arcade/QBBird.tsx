/**
 * QBBird: a bird, some gravity, and a corridor of score columns.
 *
 * # What this is, and what it is not
 *
 * It is the oldest one-button game there is, dressed as a scoresheet. It is not a port of anything.
 * The mechanics — a downward acceleration, an upward impulse on input, obstacle pairs that scroll in
 * from the right, a point for each pair passed — were read from `pyforgedev/flappy-bird` (MIT),
 * which is a compact and legible example of the shape. No code, artwork, sound or font from that
 * project or any other is copied here: the reference uses sprite images and audio files, and every
 * pixel below is drawn procedurally from QBSheet's own tokens. See `docs/ARCADE.md`.
 *
 * # Why the state is a ref and the React state is only the parts a person reads
 *
 * The bird's position changes sixty times a second and nobody needs to see a re-render for it. The
 * score changes about once every second and a half, the status a handful of times a game, and those
 * two are what the surrounding markup is made of. Keeping the simulation in a ref means the loop
 * costs one canvas draw per frame rather than one React render, which is the difference between a
 * game that is free on a school Chromebook and one a scorekeeper notices in the room's own fan.
 *
 * # Why nothing moves until somebody asks
 *
 * There is no idle animation, no attract mode and no bobbing bird on the ready screen. A dialog
 * opened and left open is a static picture, which is both the polite thing to do to a battery and
 * the only honest reading of "animations run because the user started a game".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import readArcadePalette, { arcadePaletteKey, IArcadePalette } from './arcadePalette';
import { IArcadeWorld, prepareFrame, roundedRect } from './arcadeCanvas';
import { loadBestScore, saveBestScore } from './arcadeScores';
import useArcadeLoop from './useArcadeLoop';

/** The units the game is designed in. Everything below is in these; see `arcadeCanvas`. */
export const qbbirdWorld: IArcadeWorld = { width: 320, height: 440 };

/** The strip along the bottom. Solid ground, and the thing most games end against. */
const groundHeight = 34;

/** Constant, because the bird never moves horizontally — the columns move past it. */
const birdX = 84;
const birdRadius = 11;

const gravity = 1350;
const flapVelocity = -395;
const terminalVelocity = 620;
const scrollSpeed = 132;

const columnWidth = 48;
const columnSpacing = 188;
/**
 * The gap, at its tightest and its most generous.
 *
 * Bounded on both sides on purpose. An unbounded random gap produces the two runs that make a small
 * game feel broken: one nobody can pass, and one that is not a game.
 */
const gapMin = 116;
const gapMax = 158;
/** How close to the ceiling or the ground a gap may be placed. */
const gapMargin = 34;

interface IColumn {
  /** The left edge. Decreases at `scrollSpeed`. */
  x: number;
  gapTop: number;
  gapHeight: number;
  /** Whether this pair has already been counted. A pair scores once. */
  scored: boolean;
}

export interface IQBBirdState {
  y: number;
  velocity: number;
  columns: IColumn[];
  score: number;
  /** Seconds since the last flap, which is all the wing angle is made of. */
  sinceFlap: number;
}

/** A gap for the next pair, within the bounds above. */
function nextGap(random: () => number): { gapTop: number; gapHeight: number } {
  const gapHeight = gapMin + random() * (gapMax - gapMin);
  const lowest = qbbirdWorld.height - groundHeight - gapMargin - gapHeight;
  const gapTop = gapMargin + random() * Math.max(0, lowest - gapMargin);
  return { gapTop, gapHeight };
}

/** A fresh game: bird level in the middle, two pairs already on their way in. */
export function createQBBirdState(random: () => number = Math.random): IQBBirdState {
  const columns: IColumn[] = [0, 1].map((index) => ({
    x: qbbirdWorld.width + 40 + index * columnSpacing,
    scored: false,
    ...nextGap(random),
  }));
  return {
    y: (qbbirdWorld.height - groundHeight) / 2,
    velocity: 0,
    columns,
    score: 0,
    sinceFlap: 99,
  };
}

/** The one input the game has. */
export function flapQBBird(state: IQBBirdState): void {
  state.velocity = flapVelocity;
  state.sinceFlap = 0;
}

export interface IQBBirdOutcome {
  /** How many pairs were passed during this step. Zero on almost every frame. */
  scored: number;
  /** The bird hit a column or the ground. The state is left exactly as it was when it did. */
  crashed: boolean;
}

/**
 * Advance the world by `seconds`.
 *
 * Exported so that the rules can be tested without a canvas, a dialog or a frame callback: what a
 * gap is worth, that a pair scores once, and that the ground ends a game are questions about this
 * function. `seconds` is already clamped by `useArcadeLoop`, so no step is large enough to carry the
 * bird through a column between two collision checks.
 */
export function advanceQBBird(
  state: IQBBirdState,
  seconds: number,
  random: () => number = Math.random,
): IQBBirdOutcome {
  state.sinceFlap += seconds;
  state.velocity = Math.min(state.velocity + gravity * seconds, terminalVelocity);
  state.y += state.velocity * seconds;

  // The ceiling is a wall, not an ending. Bonking it costs the climb and nothing else, which is
  // kinder than a death nobody saw coming from off the top of the screen.
  if (state.y < birdRadius) {
    state.y = birdRadius;
    state.velocity = 0;
  }

  const floor = qbbirdWorld.height - groundHeight;
  let scored = 0;

  state.columns.forEach((column) => {
    column.x -= scrollSpeed * seconds;
    if (!column.scored && column.x + columnWidth < birdX - birdRadius) {
      column.scored = true;
      scored += 1;
    }
  });

  state.score += scored;
  state.columns = state.columns.filter((column) => column.x + columnWidth > -8);

  const last = state.columns[state.columns.length - 1];
  if (last === undefined || last.x <= qbbirdWorld.width - columnSpacing) {
    state.columns.push({
      x: (last?.x ?? qbbirdWorld.width) + columnSpacing,
      scored: false,
      ...nextGap(random),
    });
  }

  if (state.y + birdRadius >= floor) {
    state.y = floor - birdRadius;
    return { scored, crashed: true };
  }

  const hit = state.columns.some(
    (column) =>
      birdX + birdRadius > column.x &&
      birdX - birdRadius < column.x + columnWidth &&
      (state.y - birdRadius < column.gapTop || state.y + birdRadius > column.gapTop + column.gapHeight),
  );

  return { scored, crashed: hit };
}

/** One column of the pair, drawn as a panel of score rows with a band at the end facing the gap. */
function drawColumn(
  context: CanvasRenderingContext2D,
  palette: IArcadePalette,
  x: number,
  top: number,
  height: number,
  bandAtBottom: boolean,
): void {
  if (height <= 2) return;
  context.fillStyle = palette.surfaceSunken;
  context.strokeStyle = palette.borderStrong;
  context.lineWidth = 1.5;
  roundedRect(context, x, top, columnWidth, height, 4);
  context.fill();
  context.stroke();

  // The rows. Drawn from the gap end so the pattern lines up with the band rather than with a
  // column edge that is usually off screen.
  context.strokeStyle = palette.border;
  context.lineWidth = 1;
  const step = 13;
  const bandDepth = 10;
  for (let offset = bandDepth + step; offset < height - 2; offset += step) {
    const y = bandAtBottom ? top + height - offset : top + offset;
    context.beginPath();
    context.moveTo(x + 7, y);
    context.lineTo(x + columnWidth - 7, y);
    context.stroke();
  }

  context.fillStyle = palette.accent;
  const bandY = bandAtBottom ? top + height - bandDepth : top;
  roundedRect(context, x, bandY, columnWidth, bandDepth, 3);
  context.fill();
}

/** The mascot. A bird, drawn out of the same three colours everything else uses. */
function drawBird(context: CanvasRenderingContext2D, palette: IArcadePalette, state: IQBBirdState): void {
  const tilt = Math.max(-0.42, Math.min(0.85, state.velocity / 780));
  context.save();
  context.translate(birdX, state.y);
  context.rotate(tilt);

  context.fillStyle = palette.accent;
  context.beginPath();
  context.ellipse(0, 0, birdRadius + 2, birdRadius, 0, 0, Math.PI * 2);
  context.fill();

  // The wing, which is the whole animation: up for the first tenth of a second after a flap, and
  // settled the rest of the time.
  const raised = state.sinceFlap < 0.12;
  context.fillStyle = palette.onAccent;
  context.globalAlpha = 0.55;
  context.beginPath();
  context.ellipse(-2, raised ? -3.5 : 2.5, 6, 3.6, raised ? -0.55 : 0.35, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;

  context.fillStyle = palette.warning;
  context.beginPath();
  context.moveTo(birdRadius, -1);
  context.lineTo(birdRadius + 6, 1.5);
  context.lineTo(birdRadius, 4);
  context.closePath();
  context.fill();

  context.fillStyle = palette.surface;
  context.beginPath();
  context.arc(5, -3.5, 3.4, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = palette.text;
  context.beginPath();
  context.arc(6, -3.5, 1.6, 0, Math.PI * 2);
  context.fill();

  context.restore();
}

/** A centred message over a dimmed board. The three non-playing states all look like this. */
function drawOverlay(
  context: CanvasRenderingContext2D,
  palette: IArcadePalette,
  lines: { text: string; size: number; colour: string }[],
): void {
  context.save();
  context.globalAlpha = 0.9;
  context.fillStyle = palette.surface;
  context.fillRect(0, 0, qbbirdWorld.width, qbbirdWorld.height);
  context.globalAlpha = 1;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  const spacing = 26;
  const start = qbbirdWorld.height / 2 - ((lines.length - 1) * spacing) / 2;
  lines.forEach((line, index) => {
    context.fillStyle = line.colour;
    context.font = `600 ${line.size}px ${palette.fontFamily}`;
    context.fillText(line.text, qbbirdWorld.width / 2, start + index * spacing);
  });
  context.restore();
}

type QBBirdStatus = 'ready' | 'playing' | 'paused' | 'over';

export default function QBBird() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef<IQBBirdState>(createQBBirdState());
  const palette = useRef<IArcadePalette>(readArcadePalette(null));
  const paletteKey = useRef<string>('');

  const [status, setStatus] = useState<QBBirdStatus>('ready');
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => loadBestScore('qbbird'));
  const bestRef = useRef(best);
  const [bestSaved, setBestSaved] = useState(true);

  /**
   * Draw the current state, once.
   *
   * Called from the loop while a game is running and from an effect the rest of the time, so a ready
   * board, a pause and a game over are all painted by the same code that paints a frame of play.
   */
  const draw = useCallback((current: QBBirdStatus, currentScore: number) => {
    const element = canvas.current;
    if (element === null) return;
    const context = prepareFrame(element, qbbirdWorld);
    if (context === null) return;

    // The tokens, re-read only when the appearance they depend on has moved. See `arcadePalette`.
    const key = arcadePaletteKey();
    if (key !== paletteKey.current) {
      paletteKey.current = key;
      palette.current = readArcadePalette(element);
    }
    const colours = palette.current;
    const world = state.current;

    context.fillStyle = colours.surface;
    context.fillRect(0, 0, qbbirdWorld.width, qbbirdWorld.height);

    // The ruled ground of a paper scoresheet, at the weight of every other rule in the application.
    context.strokeStyle = colours.border;
    context.lineWidth = 1;
    context.globalAlpha = 0.55;
    for (let y = 40; y < qbbirdWorld.height - groundHeight; y += 40) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(qbbirdWorld.width, y);
      context.stroke();
    }
    context.globalAlpha = 1;

    world.columns.forEach((column) => {
      drawColumn(context, colours, column.x, 0, column.gapTop, true);
      const belowTop = column.gapTop + column.gapHeight;
      drawColumn(context, colours, column.x, belowTop, qbbirdWorld.height - groundHeight - belowTop, false);
    });

    const floor = qbbirdWorld.height - groundHeight;
    context.fillStyle = colours.surfaceSunken;
    context.fillRect(0, floor, qbbirdWorld.width, groundHeight);
    context.strokeStyle = colours.borderStrong;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(0, floor);
    context.lineTo(qbbirdWorld.width, floor);
    context.stroke();
    context.strokeStyle = colours.faint;
    context.lineWidth = 1;
    for (let x = 10; x < qbbirdWorld.width; x += 22) {
      context.beginPath();
      context.moveTo(x, floor + 11);
      context.lineTo(x, floor + 21);
      context.stroke();
    }

    drawBird(context, colours, world);

    // Also on the board, because a player's eyes are on the bird and not on the markup below it.
    // The authoritative copy is the text under the canvas; this one is decoration.
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillStyle = colours.text;
    context.font = `700 26px ${colours.fontFamily}`;
    context.fillText(String(currentScore), qbbirdWorld.width / 2, 16);

    if (current === 'ready') {
      drawOverlay(context, colours, [
        { text: 'QBBird', size: 22, colour: colours.text },
        { text: 'Space, Arrow Up, or tap to flap', size: 13, colour: colours.muted },
        { text: 'Fly through the gaps in the score columns', size: 13, colour: colours.muted },
      ]);
    } else if (current === 'paused') {
      drawOverlay(context, colours, [
        { text: 'Paused', size: 22, colour: colours.text },
        { text: 'QBSheet left the screen', size: 13, colour: colours.muted },
      ]);
    } else if (current === 'over') {
      drawOverlay(context, colours, [
        { text: 'Game over', size: 22, colour: colours.text },
        { text: `${currentScore} ${currentScore === 1 ? 'gap' : 'gaps'}`, size: 15, colour: colours.muted },
        { text: 'Press Restart to play again', size: 13, colour: colours.muted },
      ]);
    }
  }, []);

  useArcadeLoop({
    running: status === 'playing',
    step: (seconds) => {
      const outcome = advanceQBBird(state.current, seconds);
      const next = state.current.score;
      if (outcome.scored > 0) {
        setScore(next);
        if (next > bestRef.current) {
          bestRef.current = next;
          setBest(next);
          if (!saveBestScore('qbbird', next)) setBestSaved(false);
        }
      }
      if (outcome.crashed) {
        setStatus('over');
        draw('over', next);
        return;
      }
      draw('playing', next);
    },
    onHidden: () => setStatus((current) => (current === 'playing' ? 'paused' : current)),
  });

  // Every state that is not a running game is one still frame, and this is what paints it. Also the
  // first paint, and the repaint after a resize changed the box the world is scaled into.
  useEffect(() => {
    draw(status, score);
  }, [draw, status, score]);

  useEffect(() => {
    const onResize = () => draw(status, score);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw, status, score]);

  const focusBoard = () => canvas.current?.focus();

  /**
   * The one control, whatever pressed it.
   *
   * Ready starts a game and flaps in the same action, so the first press is not spent on a menu.
   * Paused resumes. Over does nothing: ending a run and immediately restarting it because a finger
   * was still on the screen is the one thing that makes a best score feel unearned.
   */
  const flap = () => {
    if (status === 'over') return;
    if (status === 'ready') {
      setStatus('playing');
      setScore(0);
      flapQBBird(state.current);
      return;
    }
    if (status === 'paused') {
      setStatus('playing');
      return;
    }
    flapQBBird(state.current);
  };

  const restart = () => {
    state.current = createQBBirdState();
    setScore(0);
    setStatus('ready');
    focusBoard();
  };

  return (
    <div className="arcade-game">
      <div className="arcade-scores">
        <p className="arcade-score">
          <span className="arcade-score-label">Score</span>
          <span className="arcade-score-value">{score}</span>
        </p>
        <p className="arcade-score">
          <span className="arcade-score-label">Best</span>
          <span className="arcade-score-value">{best}</span>
        </p>
      </div>

      <canvas
        ref={canvas}
        className="arcade-board arcade-board-qbbird"
        width={qbbirdWorld.width}
        height={qbbirdWorld.height}
        tabIndex={0}
        aria-label={`QBBird play area. Score ${score}. Best ${best}.`}
        aria-describedby="arcade-qbbird-controls"
        onPointerDown={(event) => {
          event.preventDefault();
          focusBoard();
          flap();
        }}
        /*
         * On the board, and only on the board.
         *
         * The listener is the canvas's own rather than the document's, so Space and Arrow Up are the
         * game's exactly while the game has focus and belong to nothing at all the moment it does
         * not. The scoresheet underneath is already inert — its listener drops every key while a
         * dialog is open, see `keystrokeBelongsToControl` — and this is the other half of the same
         * promise: no arcade key is ever seen outside this element.
         */
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'ArrowUp') {
            // Before the repeat check: a held Space scrolls the page whether or not it flaps.
            event.preventDefault();
            if (event.repeat) return;
            flap();
            return;
          }
          if (event.key === 'Enter' && status === 'over') {
            event.preventDefault();
            restart();
          }
        }}
      />

      <div className="arcade-controls">
        {status === 'over' ? (
          <button type="button" className="arcade-primary" onClick={restart}>
            Restart
          </button>
        ) : (
          <button type="button" className="arcade-primary" onClick={flap}>
            {status === 'ready' ? 'Start' : status === 'paused' ? 'Resume' : 'Flap'}
          </button>
        )}
      </div>

      <p className="arcade-instructions" id="arcade-qbbird-controls">
        Flap with <kbd>Space</kbd>, <kbd>↑</kbd>, or a tap on the board. Each pair of score columns you pass
        is one point. The keys work while the board has focus.
      </p>
      {!bestSaved && (
        <p className="arcade-note">This device is not saving a best score. The game still works.</p>
      )}
    </div>
  );
}
