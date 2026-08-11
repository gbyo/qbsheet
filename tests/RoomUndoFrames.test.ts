/** @vitest-environment jsdom */

/**
 * What undo and redo hand back.
 *
 * The event stack was already correct and is unchanged here. What is new is that it now reports the
 * frame it moved, so the screen above it can say what was taken back instead of quietly showing a
 * different set of numbers. It is feedback and nothing else: the events are gone before the value is
 * returned, and a caller that drops it changes nothing about the game.
 *
 * The grouping is the part with consequences, and it is the part that must not have moved. Some
 * single actions are several events — a spoiled cycle is a void and the note explaining it — and a
 * scorekeeper pressing undo means the action, not one event of it.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';
import useGameEvents from '../src/scorer/useGameEvents';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { IGameSetup } from '../src/scoring/deriveGame';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';

/** A roster that exactly fills the floor, so every player is active and no lineup has to be chosen. */
const rules = new ScoringRules(CommonRuleSets.AcfPowers);
rules.maximumPlayersPerTeam = 2;
const format = scoringRulesToScorekeeperFormat(rules);
const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah Mitchell', 'James Robinson'] },
  right: { name: 'Greenwood', players: ['Emma Turner', 'Jordan Lee'] },
};

let gameCounter = 0;

function installLocalStorage() {
  let store: Record<string, string> = {};
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    },
  });
}

/** A fresh event stack, keyed so no two of them share a saved game. */
function renderEvents() {
  gameCounter += 1;
  const key = `undo-frames-${gameCounter}`;
  return renderHook(() => useGameEvents(key, format, setup));
}

const buzz = (id: string, questionNumber: number, playerName: string): ScoreEvent => ({
  id,
  type: 'tossup-buzz',
  questionNumber,
  team: 'left',
  playerName,
  answerTypeIndex: 1,
});

const bonus = (id: string, questionNumber: number): ScoreEvent => ({
  id,
  type: 'bonus',
  questionNumber,
  team: 'left',
  controlledPoints: 20,
});

beforeEach(() => {
  installLocalStorage();
});

describe('the frame undo and redo report', () => {
  test('undo returns exactly the events it removed', () => {
    const hook = renderEvents();
    act(() => {
      hook.result.current.append(buzz('a', 1, 'Sarah Mitchell'));
    });

    let removed: ScoreEvent[] | null = null;
    act(() => {
      removed = hook.result.current.undo();
    });

    expect(removed).toEqual([buzz('a', 1, 'Sarah Mitchell')]);
    expect(hook.result.current.events).toEqual([]);
  });

  test('redo returns exactly the events it put back', () => {
    const hook = renderEvents();
    act(() => {
      hook.result.current.append(buzz('a', 1, 'Sarah Mitchell'));
    });
    act(() => {
      hook.result.current.undo();
    });

    let restored: ScoreEvent[] | null = null;
    act(() => {
      restored = hook.result.current.redo();
    });

    expect(restored).toEqual([buzz('a', 1, 'Sarah Mitchell')]);
    expect(hook.result.current.events).toEqual([buzz('a', 1, 'Sarah Mitchell')]);
  });

  test('an action of several events is one frame, reported whole', () => {
    const hook = renderEvents();
    act(() => {
      hook.result.current.append(buzz('a', 1, 'Sarah Mitchell'));
    });
    act(() => {
      hook.result.current.append(bonus('b', 1));
    });

    let removed: ScoreEvent[] | null = null;
    act(() => {
      removed = hook.result.current.undo();
    });
    // Two appends are two actions, however close together they were.
    expect(removed).toEqual([bonus('b', 1)]);

    const together = renderEvents();
    act(() => {
      together.result.current.append(buzz('c', 1, 'Sarah Mitchell'), bonus('d', 1));
    });

    let both: ScoreEvent[] | null = null;
    act(() => {
      both = together.result.current.undo();
    });
    expect(both).toEqual([buzz('c', 1, 'Sarah Mitchell'), bonus('d', 1)]);
    expect(together.result.current.events).toEqual([]);
    expect(together.result.current.canUndo).toBe(false);
  });

  test('nothing to take back is null rather than an empty frame', () => {
    const hook = renderEvents();

    let removed: ScoreEvent[] | null | undefined;
    let restored: ScoreEvent[] | null | undefined;
    act(() => {
      removed = hook.result.current.undo();
      restored = hook.result.current.redo();
    });

    expect(removed).toBeNull();
    expect(restored).toBeNull();
  });

  test('the score is unchanged by anything the frame is used for', () => {
    const hook = renderEvents();
    act(() => {
      hook.result.current.append(buzz('a', 1, 'Sarah Mitchell'), bonus('b', 1));
    });
    act(() => {
      hook.result.current.append(buzz('c', 2, 'James Robinson'));
    });

    act(() => {
      hook.result.current.undo();
    });
    expect(hook.result.current.events.map((event) => event.id)).toEqual(['a', 'b']);

    act(() => {
      hook.result.current.redo();
    });
    expect(hook.result.current.events.map((event) => event.id)).toEqual(['a', 'b', 'c']);
  });

  /*
   * A refusal is not a frame. It is its own state with its own reason to be cleared, and it must not
   * be confused with the acknowledgement path an undo goes through.
   */
  test('a refused append leaves nothing to undo and says why on its own', () => {
    const hook = renderEvents();
    act(() => {
      hook.result.current.append(buzz('a', 1, 'Sarah Mitchell'));
    });

    let accepted: boolean | undefined;
    act(() => {
      // A second answer for a team that has already answered this tossup.
      accepted = hook.result.current.append(buzz('b', 1, 'James Robinson'));
    });

    expect(accepted).toBe(false);
    expect(hook.result.current.rejection).not.toBe('');
    expect(hook.result.current.events.map((event) => event.id)).toEqual(['a']);
  });
});
