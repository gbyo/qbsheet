/**
 * The rules of both games, asked of the rules rather than of a canvas.
 *
 * Everything here is a question about `advanceQBBird` or `advanceSnake`, which is why those are
 * exported: whether a pair of columns can score twice, whether food can appear underneath the snake,
 * and whether following your own tail is a crash are properties of the simulation and have nothing
 * to say about React, a dialog or a frame callback. The randomness is supplied by the caller in both
 * games for the same reason — a rule that only holds for some seeds is not a rule.
 */
import { describe, expect, test } from 'vitest';
import { advanceQBBird, createQBBirdState, flapQBBird, qbbirdWorld } from '../src/arcade/QBBird';
import {
  advanceSnake,
  createSnakeState,
  placeFood,
  snakeColumns,
  snakeRows,
  snakeStepSeconds,
  turnSnake,
  type ICell,
} from '../src/arcade/Snake';

/** A predictable "random", so a test can say exactly where a gap or a piece of food goes. */
const fixed = (value: number) => (): number => value;

/** One sixtieth of a second, which is what the loop hands the games on an ordinary frame. */
const frame = 1 / 60;

describe('QBBird', () => {
  test('gravity pulls the bird down and a flap sends it up', () => {
    const state = createQBBirdState(fixed(0.5));
    const start = state.y;
    advanceQBBird(state, frame, fixed(0.5));
    expect(state.y).toBeGreaterThan(start);

    flapQBBird(state);
    expect(state.velocity).toBeLessThan(0);
    const afterFlap = state.y;
    advanceQBBird(state, frame, fixed(0.5));
    expect(state.y).toBeLessThan(afterFlap);
  });

  test('a pair of columns is worth one point, however many frames it takes to pass', () => {
    const state = createQBBirdState(fixed(0.5));
    let scored = 0;
    // Long enough for the first pair to cross the whole board and be counted.
    for (let step = 0; step < 400; step += 1) {
      // Held level, so the run ends against a column rather than against the ground.
      state.velocity = 0;
      scored += advanceQBBird(state, frame, fixed(0.5)).scored;
    }
    expect(scored).toBeGreaterThan(0);
    expect(state.score).toBe(scored);
    // Every column that has been counted stays counted, and none is counted again.
    expect(state.columns.filter((column) => column.scored).length).toBeLessThanOrEqual(state.score);
  });

  test('the ground ends the run', () => {
    const state = createQBBirdState(fixed(0.5));
    let crashed = false;
    for (let step = 0; step < 200 && !crashed; step += 1) {
      crashed = advanceQBBird(state, frame, fixed(0.5)).crashed;
    }
    expect(crashed).toBe(true);
    expect(state.y).toBeLessThan(qbbirdWorld.height);
  });

  test('the ceiling is a wall and not an ending', () => {
    const state = createQBBirdState(fixed(0.5));
    state.y = 4;
    state.velocity = -600;
    const outcome = advanceQBBird(state, frame, fixed(0.5));
    expect(outcome.crashed).toBe(false);
    expect(state.y).toBeGreaterThan(0);
    expect(state.velocity).toBe(0);
  });

  test('a column ends the run when the bird is not in the gap', () => {
    const state = createQBBirdState(fixed(0.5));
    // A column arriving at the bird, with the gap nowhere near it.
    state.columns = [{ x: 84, gapTop: 10, gapHeight: 40, scored: false }];
    state.y = 300;
    state.velocity = 0;
    expect(advanceQBBird(state, frame, fixed(0.5)).crashed).toBe(true);
  });

  test('the same column is passable when the bird is inside the gap', () => {
    const state = createQBBirdState(fixed(0.5));
    state.columns = [{ x: 84, gapTop: 260, gapHeight: 140, scored: false }];
    state.y = 330;
    state.velocity = 0;
    expect(advanceQBBird(state, frame, fixed(0.5)).crashed).toBe(false);
  });

  test('every gap it generates is on the board and above the ground, for any seed', () => {
    [0, 0.25, 0.5, 0.75, 0.999].forEach((seed) => {
      const state = createQBBirdState(fixed(seed));
      for (let step = 0; step < 600; step += 1) {
        state.velocity = 0;
        state.y = qbbirdWorld.height / 2;
        advanceQBBird(state, frame, fixed(seed));
      }
      expect(state.columns.length).toBeGreaterThan(0);
      state.columns.forEach((column) => {
        expect(column.gapTop).toBeGreaterThanOrEqual(0);
        expect(column.gapTop + column.gapHeight).toBeLessThanOrEqual(qbbirdWorld.height);
        expect(column.gapHeight).toBeGreaterThan(0);
      });
    });
  });
});

describe('Snake', () => {
  /** Take exactly one grid step, whatever the current speed is. */
  const oneStep = (state: ReturnType<typeof createSnakeState>, random = fixed(0)) =>
    advanceSnake(state, snakeStepSeconds(state.score), random);

  test('a step moves the head one cell and the tail follows', () => {
    const state = createSnakeState(fixed(0));
    const head = { ...state.cells[0] };
    const length = state.cells.length;
    oneStep(state);
    expect(state.cells[0]).toEqual({ x: head.x + 1, y: head.y });
    expect(state.cells).toHaveLength(length);
  });

  test('a reversal onto its own neck is refused, and any other turn is taken', () => {
    const state = createSnakeState(fixed(0));
    turnSnake(state, 'left');
    expect(state.pending).toBe('right');

    turnSnake(state, 'up');
    expect(state.pending).toBe('up');
    oneStep(state);
    expect(state.direction).toBe('up');
  });

  test('two turns inside one step cannot fold the snake through itself', () => {
    const state = createSnakeState(fixed(0));
    /*
     * Up then left, both pressed before the next step falls due, by somebody rounding a corner
     * quickly. Each request is judged against the direction the snake is actually travelling in
     * rather than against the one queued ahead of it, so the second is refused as the reversal it is
     * — the snake turns up and lives. Judging `left` against the queued `up` would accept it, and the
     * next step would put the head straight into its own neck.
     */
    turnSnake(state, 'up');
    turnSnake(state, 'left');
    expect(state.pending).toBe('up');
    expect(oneStep(state).crashed).toBe(false);
    expect(state.direction).toBe('up');

    // And once that step is behind it, the same key is an ordinary turn.
    turnSnake(state, 'left');
    expect(state.pending).toBe('left');
    expect(oneStep(state).crashed).toBe(false);
  });

  test('eating grows the snake, scores, and puts the next card somewhere free', () => {
    const state = createSnakeState(fixed(0));
    const length = state.cells.length;
    state.food = { x: state.cells[0].x + 1, y: state.cells[0].y };
    const outcome = oneStep(state);

    expect(outcome.ate).toBe(1);
    expect(state.score).toBe(1);
    expect(state.cells).toHaveLength(length + 1);
    expect(state.cells.some((part) => part.x === state.food.x && part.y === state.food.y)).toBe(false);
  });

  test('a wall ends the run', () => {
    const state = createSnakeState(fixed(0));
    state.cells = [{ x: snakeColumns - 1, y: 3 }];
    state.direction = 'right';
    state.pending = 'right';
    expect(oneStep(state).crashed).toBe(true);
  });

  test('running into itself ends the run', () => {
    const state = createSnakeState(fixed(0));
    // A tight coil: moving up from (5,5) arrives on the body cell at (5,4).
    state.cells = [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 4, y: 4 },
      { x: 5, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 5 },
    ];
    state.direction = 'up';
    state.pending = 'up';
    expect(oneStep(state).crashed).toBe(true);
  });

  test('following its own tail is running, not crashing', () => {
    const state = createSnakeState(fixed(0));
    // A closed ring: the head arrives exactly where the tail is leaving.
    state.cells = [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 5 },
    ];
    state.food = { x: 0, y: 0 };
    state.direction = 'right';
    state.pending = 'right';
    expect(oneStep(state).crashed).toBe(false);
  });

  test('food is never placed inside the snake, however full the board is', () => {
    // A snake filling every cell but one. Guessing and retrying would take an unbounded number of
    // attempts here; choosing from the free cells takes one.
    const cells: ICell[] = [];
    for (let y = 0; y < snakeRows; y += 1) {
      for (let x = 0; x < snakeColumns; x += 1) {
        if (!(x === 7 && y === 9)) cells.push({ x, y });
      }
    }
    const food = placeFood(cells, fixed(0.5));
    expect(food).toEqual({ x: 7, y: 9 });
  });

  test('one frame cannot pay off an unbounded backlog of steps', () => {
    const state = createSnakeState(fixed(0));
    const head = { ...state.cells[0] };
    // Ten seconds in one call, as a stalled tab would produce if nothing bounded the catch-up.
    advanceSnake(state, 10, fixed(0));
    expect(state.cells[0].x - head.x).toBeLessThanOrEqual(3);
    expect(state.elapsed).toBe(0);
  });

  test('it speeds up with the score, and then stops speeding up', () => {
    expect(snakeStepSeconds(10)).toBeLessThan(snakeStepSeconds(0));
    expect(snakeStepSeconds(500)).toBe(snakeStepSeconds(200));
    expect(snakeStepSeconds(500)).toBeGreaterThan(0.05);
  });
});
