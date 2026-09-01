/**
 * Snake, on a grid, in the scoresheet's own colours.
 *
 * # What this is, and what it is not
 *
 * The rules are the ones everybody already knows, and they are the rules because they are the rules
 * — a grid, a constant step, growth on food, an ending on a wall or on yourself. They were checked
 * against `matiasbeckerle/snake`, whose README grants MIT and which is a short and readable example
 * of the shape. Nothing from it is copied: that project has no licence file of its own, its own
 * README describes it as an adaptation of tutorials, and there is no version of "borrow a little of
 * it" that is worth the ambiguity. Everything below was written for this repository. See
 * `docs/ARCADE.md`.
 *
 * # Why the step is a fixed interval and not a frame
 *
 * A snake that moves one cell per animation frame plays differently on a 120Hz phone than on a 60Hz
 * Chromebook, which would make the difficulty a property of the hardware. The loop accumulates real
 * seconds and takes as many grid steps as have actually fallen due, so the game is the same game
 * everywhere and a stalled tab does not teleport the snake across the board — `useArcadeLoop` clamps
 * the step it is given, and the catch-up below is bounded on top of that.
 *
 * # Why the acceleration is gentle
 *
 * It exists so a long run has somewhere to go, not so it ends the run. Roughly a third faster by the
 * twentieth piece of food and no faster after that; a speed curve that outruns a person's reaction
 * time is a scoreboard for whoever happened to be holding the keyboard, not a game.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import readArcadePalette, { arcadePaletteKey, IArcadePalette } from './arcadePalette';
import { IArcadeWorld, prepareFrame, roundedRect } from './arcadeCanvas';
import { loadBestScore, saveBestScore } from './arcadeScores';
import useArcadeLoop from './useArcadeLoop';

/** The board, in cells. */
export const snakeColumns = 20;
export const snakeRows = 15;
const cell = 18;

/** The units the game is designed in; the board is exactly the grid. See `arcadeCanvas`. */
export const snakeWorld: IArcadeWorld = { width: snakeColumns * cell, height: snakeRows * cell };

export type SnakeDirection = 'up' | 'down' | 'left' | 'right';

const vectors: Record<SnakeDirection, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const opposite: Record<SnakeDirection, SnakeDirection> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

export interface ICell {
  x: number;
  y: number;
}

export interface ISnakeState {
  /** Head first. The last entry is the tail, and it is the one that vacates on an ordinary step. */
  cells: ICell[];
  /** The direction the last completed step was taken in. */
  direction: SnakeDirection;
  /**
   * The direction the next step will be taken in, if it is legal by then.
   *
   * Separate from `direction` because a person can press two keys inside one step. Turning on the
   * key rather than on the step would let Up-then-Left inside a single interval fold the snake back
   * through its own neck, which reads as the game cheating.
   */
  pending: SnakeDirection;
  food: ICell;
  score: number;
  /** Real seconds banked toward the next grid step. */
  elapsed: number;
}

/** How long one step takes, given how much has been eaten. */
export function snakeStepSeconds(score: number): number {
  return Math.max(0.085, 0.165 - score * 0.004);
}

/** At most this many grid steps are taken for one animation frame. A bound on catch-up after a stall. */
const maxStepsPerFrame = 3;

const sameCell = (a: ICell, b: ICell): boolean => a.x === b.x && a.y === b.y;

/**
 * A cell the snake is not in.
 *
 * Chosen from the free cells rather than by guessing and retrying, so food can never be placed
 * inside the snake and a nearly full board cannot spin. Three hundred cells is small enough that
 * building the list is cheaper than the retries would be.
 */
export function placeFood(cells: readonly ICell[], random: () => number = Math.random): ICell {
  const free: ICell[] = [];
  for (let y = 0; y < snakeRows; y += 1) {
    for (let x = 0; x < snakeColumns; x += 1) {
      if (!cells.some((part) => part.x === x && part.y === y)) free.push({ x, y });
    }
  }
  // A board with no free cell at all is a completed game; the head's own cell is a harmless answer
  // and the next step ends the run against the snake itself.
  if (free.length === 0) return { ...cells[0] };
  return free[Math.min(free.length - 1, Math.floor(random() * free.length))];
}

/** A fresh game: three cells in the middle, heading right, nothing eaten. */
export function createSnakeState(random: () => number = Math.random): ISnakeState {
  const y = Math.floor(snakeRows / 2);
  const x = Math.floor(snakeColumns / 2);
  const cells: ICell[] = [
    { x, y },
    { x: x - 1, y },
    { x: x - 2, y },
  ];
  return {
    cells,
    direction: 'right',
    pending: 'right',
    food: placeFood(cells, random),
    score: 0,
    elapsed: 0,
  };
}

/**
 * Ask for a turn.
 *
 * Refused only for a reversal onto the neck, which is not a turn a person means. Every other request
 * is recorded and applied by the next step.
 */
export function turnSnake(state: ISnakeState, direction: SnakeDirection): void {
  if (state.cells.length > 1 && direction === opposite[state.direction]) return;
  state.pending = direction;
}

export interface ISnakeOutcome {
  /** How many pieces of food were eaten during this step. */
  ate: number;
  /** The snake left the board or ran into itself. */
  crashed: boolean;
}

/**
 * Advance by `seconds`, taking whole grid steps as they fall due.
 *
 * Exported for the same reason `advanceQBBird` is: whether food can appear under the snake, whether
 * a wall ends a game, and whether a reversal is refused are questions about the rules and not about
 * React.
 */
export function advanceSnake(
  state: ISnakeState,
  seconds: number,
  random: () => number = Math.random,
): ISnakeOutcome {
  state.elapsed += seconds;
  let ate = 0;
  let steps = 0;

  while (state.elapsed >= snakeStepSeconds(state.score) && steps < maxStepsPerFrame) {
    state.elapsed -= snakeStepSeconds(state.score);
    steps += 1;

    state.direction = state.pending;
    const move = vectors[state.direction];
    const head: ICell = { x: state.cells[0].x + move.x, y: state.cells[0].y + move.y };

    if (head.x < 0 || head.y < 0 || head.x >= snakeColumns || head.y >= snakeRows) {
      return { ate, crashed: true };
    }

    const eating = sameCell(head, state.food);
    // The tail has already left its cell by the time the head arrives, so a snake following its own
    // tail at full length is running, not crashing. It stays only when something was eaten.
    const body = eating ? state.cells : state.cells.slice(0, -1);
    if (body.some((part) => sameCell(part, head))) return { ate, crashed: true };

    state.cells = [head, ...body];
    if (eating) {
      state.score += 1;
      ate += 1;
      state.food = placeFood(state.cells, random);
    }
  }

  // Whatever could not be taken this frame is dropped rather than banked. Otherwise a tab that was
  // hidden for a minute would come back owing a minute of steps.
  if (steps >= maxStepsPerFrame) state.elapsed = 0;
  return { ate, crashed: false };
}

type SnakeStatus = 'ready' | 'playing' | 'paused' | 'over';

/** The shortest pointer travel that counts as a swipe rather than a tap, in world units. */
const swipeThreshold = 16;

function drawOverlay(
  context: CanvasRenderingContext2D,
  palette: IArcadePalette,
  lines: { text: string; size: number; colour: string }[],
): void {
  context.save();
  context.globalAlpha = 0.9;
  context.fillStyle = palette.surface;
  context.fillRect(0, 0, snakeWorld.width, snakeWorld.height);
  context.globalAlpha = 1;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const spacing = 24;
  const start = snakeWorld.height / 2 - ((lines.length - 1) * spacing) / 2;
  lines.forEach((line, index) => {
    context.fillStyle = line.colour;
    context.font = `600 ${line.size}px ${palette.fontFamily}`;
    context.fillText(line.text, snakeWorld.width / 2, start + index * spacing);
  });
  context.restore();
}

export default function Snake() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef<ISnakeState>(createSnakeState());
  const palette = useRef<IArcadePalette>(readArcadePalette(null));
  const paletteKey = useRef<string>('');
  const swipeFrom = useRef<{ x: number; y: number } | null>(null);

  const [status, setStatus] = useState<SnakeStatus>('ready');
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => loadBestScore('snake'));
  const bestRef = useRef(best);
  const [bestSaved, setBestSaved] = useState(true);

  const draw = useCallback((current: SnakeStatus, currentScore: number) => {
    const element = canvas.current;
    if (element === null) return;
    const context = prepareFrame(element, snakeWorld);
    if (context === null) return;

    const key = arcadePaletteKey();
    if (key !== paletteKey.current) {
      paletteKey.current = key;
      palette.current = readArcadePalette(element);
    }
    const colours = palette.current;
    const world = state.current;

    context.fillStyle = colours.surface;
    context.fillRect(0, 0, snakeWorld.width, snakeWorld.height);

    context.strokeStyle = colours.border;
    context.lineWidth = 1;
    context.globalAlpha = 0.5;
    for (let x = 1; x < snakeColumns; x += 1) {
      context.beginPath();
      context.moveTo(x * cell, 0);
      context.lineTo(x * cell, snakeWorld.height);
      context.stroke();
    }
    for (let y = 1; y < snakeRows; y += 1) {
      context.beginPath();
      context.moveTo(0, y * cell);
      context.lineTo(snakeWorld.width, y * cell);
      context.stroke();
    }
    context.globalAlpha = 1;

    // Food, drawn as a tossup card: the one thing on the board that is not the snake, so it gets the
    // one colour on the board that is not the accent.
    context.fillStyle = colours.warning;
    roundedRect(context, world.food.x * cell + 3, world.food.y * cell + 3, cell - 6, cell - 6, 3);
    context.fill();
    context.strokeStyle = colours.surface;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(world.food.x * cell + 6, world.food.y * cell + cell / 2);
    context.lineTo(world.food.x * cell + cell - 6, world.food.y * cell + cell / 2);
    context.stroke();

    world.cells.forEach((part, index) => {
      // The head at full strength and the body fading toward the tail, so which way the snake is
      // pointing is legible without relying on colour to say it.
      context.globalAlpha = index === 0 ? 1 : Math.max(0.5, 0.92 - index * 0.03);
      context.fillStyle = colours.accent;
      const inset = index === 0 ? 1.5 : 2.5;
      roundedRect(
        context,
        part.x * cell + inset,
        part.y * cell + inset,
        cell - inset * 2,
        cell - inset * 2,
        index === 0 ? 5 : 3,
      );
      context.fill();
    });
    context.globalAlpha = 1;

    const head = world.cells[0];
    const facing = vectors[world.direction];
    context.fillStyle = colours.onAccent;
    [-1, 1].forEach((side) => {
      const centreX = head.x * cell + cell / 2 + facing.x * 3.5 + (facing.x === 0 ? side * 3.5 : 0);
      const centreY = head.y * cell + cell / 2 + facing.y * 3.5 + (facing.y === 0 ? side * 3.5 : 0);
      context.beginPath();
      context.arc(centreX, centreY, 1.7, 0, Math.PI * 2);
      context.fill();
    });

    context.strokeStyle = colours.borderStrong;
    context.lineWidth = 2;
    context.strokeRect(1, 1, snakeWorld.width - 2, snakeWorld.height - 2);

    if (current === 'ready') {
      drawOverlay(context, colours, [
        { text: 'Snake', size: 21, colour: colours.text },
        { text: 'Arrow keys or W A S D to steer', size: 13, colour: colours.muted },
        { text: 'Swipe on the board on a touchscreen', size: 13, colour: colours.muted },
      ]);
    } else if (current === 'paused') {
      drawOverlay(context, colours, [
        { text: 'Paused', size: 21, colour: colours.text },
        { text: 'QBSheet left the screen', size: 13, colour: colours.muted },
      ]);
    } else if (current === 'over') {
      drawOverlay(context, colours, [
        { text: 'Game over', size: 21, colour: colours.text },
        {
          text: `${currentScore} ${currentScore === 1 ? 'tossup' : 'tossups'}`,
          size: 15,
          colour: colours.muted,
        },
        { text: 'Press Restart to play again', size: 13, colour: colours.muted },
      ]);
    }
  }, []);

  useArcadeLoop({
    running: status === 'playing',
    step: (seconds) => {
      const outcome = advanceSnake(state.current, seconds);
      const next = state.current.score;
      if (outcome.ate > 0) {
        setScore(next);
        if (next > bestRef.current) {
          bestRef.current = next;
          setBest(next);
          if (!saveBestScore('snake', next)) setBestSaved(false);
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

  useEffect(() => {
    draw(status, score);
  }, [draw, status, score]);

  useEffect(() => {
    const onResize = () => draw(status, score);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw, status, score]);

  const focusBoard = () => canvas.current?.focus();

  const start = () => {
    if (status === 'ready') setStatus('playing');
    else if (status === 'paused') setStatus('playing');
    focusBoard();
  };

  const restart = () => {
    state.current = createSnakeState();
    setScore(0);
    setStatus('ready');
    focusBoard();
  };

  /** A direction from any source: a key, the pad below the board, or a swipe across it. */
  const steer = (direction: SnakeDirection) => {
    turnSnake(state.current, direction);
    if (status === 'ready') setStatus('playing');
    else if (status === 'paused') setStatus('playing');
  };

  const directionForKey = (key: string): SnakeDirection | null => {
    switch (key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        return 'up';
      case 'ArrowDown':
      case 's':
      case 'S':
        return 'down';
      case 'ArrowLeft':
      case 'a':
      case 'A':
        return 'left';
      case 'ArrowRight':
      case 'd':
      case 'D':
        return 'right';
      default:
        return null;
    }
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
        className="arcade-board arcade-board-snake"
        width={snakeWorld.width}
        height={snakeWorld.height}
        tabIndex={0}
        aria-label={`Snake play area. Score ${score}. Best ${best}.`}
        aria-describedby="arcade-snake-controls"
        onPointerDown={(event) => {
          event.preventDefault();
          focusBoard();
          swipeFrom.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const from = swipeFrom.current;
          swipeFrom.current = null;
          if (from === null) return;
          const dx = event.clientX - from.x;
          const dy = event.clientY - from.y;
          if (Math.abs(dx) < swipeThreshold && Math.abs(dy) < swipeThreshold) {
            // A tap rather than a swipe. Starting and resuming are the only things it does; it never
            // turns, because a tap has no direction and guessing one would be worse than ignoring it.
            if (status === 'ready' || status === 'paused') start();
            return;
          }
          steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
        }}
        onPointerCancel={() => {
          swipeFrom.current = null;
        }}
        /* The board's own listener, for the reason given in `QBBird`: these keys exist while this
           element has focus and nowhere else. */
        onKeyDown={(event) => {
          const direction = directionForKey(event.key);
          if (direction !== null) {
            // Arrows scroll a dialog whether or not they steer, so this comes before the repeat check.
            event.preventDefault();
            if (event.repeat || status === 'over') return;
            steer(direction);
            return;
          }
          if ((event.key === ' ' || event.key === 'Spacebar') && status !== 'over') {
            event.preventDefault();
            if (!event.repeat) start();
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
          <button type="button" className="arcade-primary" disabled={status === 'playing'} onClick={start}>
            {status === 'paused' ? 'Resume' : 'Start'}
          </button>
        )}

        {/*
          A pad, not only a swipe target.
          
          Swiping is the natural phone gesture and it is implemented above, but a pad is the thing
          that also works for somebody using a pointer, a switch, or a screen reader's own touch
          exploration — none of whom can swipe. It is four ordinary buttons, so all of that is free.
        */}
        <div className="arcade-pad" role="group" aria-label="Steer">
          <button
            type="button"
            className="arcade-pad-key arcade-pad-up"
            aria-label="Steer up"
            onClick={() => steer('up')}
          >
            <span aria-hidden="true">↑</span>
          </button>
          <button
            type="button"
            className="arcade-pad-key arcade-pad-left"
            aria-label="Steer left"
            onClick={() => steer('left')}
          >
            <span aria-hidden="true">←</span>
          </button>
          <button
            type="button"
            className="arcade-pad-key arcade-pad-down"
            aria-label="Steer down"
            onClick={() => steer('down')}
          >
            <span aria-hidden="true">↓</span>
          </button>
          <button
            type="button"
            className="arcade-pad-key arcade-pad-right"
            aria-label="Steer right"
            onClick={() => steer('right')}
          >
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <p className="arcade-instructions" id="arcade-snake-controls">
        Steer with the <kbd>arrow keys</kbd> or <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> while the
        board has focus, by swiping on a touchscreen, or with the pad above. Each tossup card is one point.
        Walls and your own tail end the run.
      </p>
      {!bestSaved && (
        <p className="arcade-note">This device is not saving a best score. The game still works.</p>
      )}
    </div>
  );
}
