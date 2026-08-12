/**
 * Breaks a tournament stated, rather than a halftime the software guessed at.
 *
 * # What is actually being tested
 *
 * The claim these tests defend is that a configured break is the *only* place a scheduled room stops.
 * That matters because the break is what the restrictive substitution policy hangs off: a room told it
 * may substitute after tossups 5 and 10, which can open a break after tossup 7 and substitute there,
 * has not been restricted at all. So the interesting cases are the refusals.
 *
 * # And that nothing changed for a room that configured nothing
 *
 * Version 3 exists alongside every procedure already written to a file or a wire. A v1 or v2 procedure
 * has no `breaks`, has to keep behaving exactly as it did — one break, wherever the moderator calls it
 * — and has to survive being read by this build at all. Those tests are here for the same reason the
 * refusals are.
 */
import { describe, expect, test } from 'vitest';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import {
  IRoomProcedure,
  defaultRoomProcedure,
  maximumRoomBreakLabelLength,
  maximumRoomBreakTossup,
  maximumRoomBreaks,
  readRoomProcedure,
  roomBreakAt,
  roomBreakDue,
  roomBreakLabel,
  roomBreakUpcoming,
  roomBreaks,
  roomBreaksAreScheduled,
  roomMayBreakNow,
  roomProcedureIsActive,
  roomProcedureVersion,
  roomTakesBreaks,
  substitutionOpportunityPhrase,
} from '../src/scoring/RoomProcedure';
import canApplyScoreEvent from '../src/scoring/canApplyScoreEvent';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { roomClockSegment } from '../src/scorer/RoomClock';
import { event } from './events';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James'] },
  right: { name: 'Greenwood', players: ['Emma', 'Jordan'] },
};

function formatFor(mutate: (rules: ScoringRules) => void = () => {}): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  mutate(rules);
  return scoringRulesToScorekeeperFormat(rules);
}

const format = formatFor();

function scheduled(afterTossups: number[], overrides: Partial<IRoomProcedure> = {}): IRoomProcedure {
  return {
    version: roomProcedureVersion,
    halves: true,
    timeoutsPerTeam: 0,
    breaks: afterTossups.map((afterTossup) => ({ afterTossup })),
    ...overrides,
  };
}

function deadTossups(count: number, from = 1): ScoreEvent[] {
  return Array.from({ length: count }, (_, index) => event({ type: 'tossup-dead', questionNumber: from + index }));
}

/** Whether the room could open a break here, asked the way the scorer and the guard both ask it. */
function breakVerdict(procedure: IRoomProcedure | undefined, events: ScoreEvent[]) {
  const game = deriveGame(format, setup, events);
  return canApplyScoreEvent(
    { format, setup, procedure },
    events,
    event({
      type: 'half-break',
      questionNumber: Math.max(1, game.questions.at(-1)?.questionNumber ?? 1),
      lastQuestion: game.questions.at(-1)?.questionNumber ?? 0,
    }),
    game,
  );
}

describe('reading a schedule of breaks', () => {
  test('a procedure with no breaks is unscheduled, and halves still means one break', () => {
    const halvesOnly = readRoomProcedure({ version: roomProcedureVersion, halves: true, timeoutsPerTeam: 0 });

    expect(roomBreaks(halvesOnly)).toEqual([]);
    expect(roomBreaksAreScheduled(halvesOnly)).toBe(false);
    expect(roomTakesBreaks(halvesOnly)).toBe(true);
    // The whole point of leaving this unscheduled: the moderator picks, so any moment qualifies.
    expect(roomMayBreakNow(halvesOnly, [], 7)).toBe(true);
  });

  test('breaks are sorted, deduplicated and labelled from what the document said', () => {
    const procedure = readRoomProcedure({
      version: roomProcedureVersion,
      halves: true,
      timeoutsPerTeam: 0,
      breaks: [
        { afterTossup: 10, label: '  End of set 2  ' },
        { afterTossup: 5, label: 'End of set 1' },
        { afterTossup: 10, label: 'A second break after the same tossup' },
        { afterTossup: 15 },
      ],
    });

    expect(procedure.breaks).toEqual([
      { afterTossup: 5, label: 'End of set 1' },
      { afterTossup: 10, label: 'End of set 2' },
      { afterTossup: 15 },
    ]);
  });

  test('a break that is not a whole positive tossup is dropped rather than repaired', () => {
    const procedure = readRoomProcedure({
      version: roomProcedureVersion,
      halves: true,
      timeoutsPerTeam: 0,
      breaks: [
        { afterTossup: 4.5 },
        { afterTossup: 0 },
        { afterTossup: -3 },
        { afterTossup: maximumRoomBreakTossup + 1 },
        { afterTossup: '10' },
        'halftime',
        null,
        { label: 'no tossup at all' },
        { afterTossup: 10 },
      ],
    });

    expect(procedure.breaks).toEqual([{ afterTossup: 10 }]);
  });

  test('an absurd number of breaks is capped, and an absurd name is truncated', () => {
    const procedure = readRoomProcedure({
      version: roomProcedureVersion,
      halves: true,
      timeoutsPerTeam: 0,
      breaks: [
        { afterTossup: 1, label: 'x'.repeat(maximumRoomBreakLabelLength + 40) },
        ...Array.from({ length: maximumRoomBreaks + 10 }, (_, index) => ({ afterTossup: index + 2 })),
      ],
    });

    expect(procedure.breaks).toHaveLength(maximumRoomBreaks);
    expect(procedure.breaks?.[0].label).toHaveLength(maximumRoomBreakLabelLength);
  });

  test('breaks with nothing usable in them leave the field absent rather than empty', () => {
    const procedure = readRoomProcedure({
      version: roomProcedureVersion,
      halves: false,
      timeoutsPerTeam: 0,
      breaks: [{ afterTossup: 0 }],
    });

    expect(procedure.breaks).toBeUndefined();
    expect(procedure).toEqual(defaultRoomProcedure());
  });

  test('a schedule of breaks is a room that stops, whatever the older flag says', () => {
    const procedure = readRoomProcedure({
      version: roomProcedureVersion,
      // Deliberately contradictory: the field says the room does not stop, the schedule says where.
      halves: false,
      timeoutsPerTeam: 0,
      halfLengthMinutes: 10,
      breaks: [{ afterTossup: 10 }],
    });

    expect(procedure.halves).toBe(true);
    // And so the clock length is kept, because there is now a play segment for it to describe.
    expect(procedure.halfLengthMinutes).toBe(10);
    expect(roomProcedureIsActive(procedure)).toBe(true);
  });

  test('a version 1 or 2 procedure still reads, and gains no breaks it did not state', () => {
    for (const version of [1, 2]) {
      const procedure = readRoomProcedure({ version, halves: true, halfLengthMinutes: 10, timeoutsPerTeam: 1 });

      expect(procedure.version).toBe(roomProcedureVersion);
      expect(procedure.breaks).toBeUndefined();
      expect(roomBreaksAreScheduled(procedure)).toBe(false);
    }
  });

  test('a procedure from a later version is not interpreted at all', () => {
    expect(readRoomProcedure({ version: roomProcedureVersion + 1, halves: true, breaks: [{ afterTossup: 5 }] })).toEqual(
      defaultRoomProcedure(),
    );
  });
});

describe('which break the room is at', () => {
  const procedure = scheduled([5, 10, 15]);

  test('nothing is due until the tossup the break comes after has been played', () => {
    expect(roomBreakDue(procedure, [], 4)).toBeUndefined();
    expect(roomBreakDue(procedure, [], 5)).toEqual({ afterTossup: 5 });
  });

  test('a break taken late still counts as that break', () => {
    // The room played through tossup 7 before anybody remembered the break after 5. Requiring the
    // numbers to agree would leave it owed forever and the break after 10 permanently out of reach.
    expect(roomBreakDue(procedure, [7], 7)).toBeUndefined();
    expect(roomBreakUpcoming(procedure, [7])).toEqual({ afterTossup: 10 });
  });

  test('breaks are owed in order, one at a time', () => {
    expect(roomBreakDue(procedure, [], 12)).toEqual({ afterTossup: 5 });
    expect(roomBreakDue(procedure, [5], 12)).toEqual({ afterTossup: 10 });
    expect(roomBreakDue(procedure, [5, 10], 12)).toBeUndefined();
    expect(roomBreakUpcoming(procedure, [5, 10])).toEqual({ afterTossup: 15 });
    expect(roomBreakUpcoming(procedure, [5, 10, 15])).toBeUndefined();
  });

  test('a break is named by its label, or numbered by its place in the schedule', () => {
    const named = scheduled([5, 10], { breaks: [{ afterTossup: 5, label: 'End of set 1' }, { afterTossup: 10 }] });

    expect(roomBreakLabel(named, roomBreakAt(named, 5))).toBe('End of set 1');
    expect(roomBreakLabel(named, roomBreakAt(named, 10))).toBe('Break 2');
    // One break needs no number to tell it apart from anything.
    expect(roomBreakLabel(scheduled([10]), roomBreakAt(scheduled([10]), 10))).toBe('Break');
  });

  test('the break a score check belongs to is the last one at or before it', () => {
    expect(roomBreakAt(procedure, 7)).toEqual({ afterTossup: 5 });
    expect(roomBreakAt(procedure, 4)).toBeUndefined();
  });
});

describe('a scheduled room may only stop where it was told to', () => {
  test('a break before the first scheduled one is refused, and says where the next one is', () => {
    const verdict = breakVerdict(scheduled([5, 10]), deadTossups(3));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('The next break is after Tossup 5.');
  });

  test('the scheduled break itself is allowed', () => {
    expect(breakVerdict(scheduled([5, 10]), deadTossups(5)).ok).toBe(true);
  });

  test('a second break between two scheduled ones is refused', () => {
    const events = [...deadTossups(5), event({ type: 'half-break', questionNumber: 5, lastQuestion: 5 })];
    const resumed = [...events, event({ type: 'half-resume', questionNumber: 5 }), ...deadTossups(2, 6)];

    const verdict = breakVerdict(scheduled([5, 10]), resumed);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('The next break is after Tossup 10.');
  });

  test('once every break is spent there are none left to take', () => {
    const events = [
      ...deadTossups(5),
      event({ type: 'half-break', questionNumber: 5, lastQuestion: 5 }),
      event({ type: 'half-resume', questionNumber: 5 }),
      ...deadTossups(3, 6),
    ];

    const verdict = breakVerdict(scheduled([5]), events);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('This room has taken every break its procedure allows.');
  });

  test('an unscheduled room keeps the moderator-chosen break it has always had', () => {
    const halvesOnly: IRoomProcedure = { version: roomProcedureVersion, halves: true, timeoutsPerTeam: 0 };

    expect(breakVerdict(halvesOnly, deadTossups(3)).ok).toBe(true);
    expect(breakVerdict(halvesOnly, deadTossups(11)).ok).toBe(true);
  });

  test('a room that takes no breaks at all still refuses one', () => {
    const verdict = breakVerdict(defaultRoomProcedure(), deadTossups(3));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('This room does not take breaks.');
  });

  test('the break the room owes is the phase the engine already derives, at the tossup it was set for', () => {
    const events = [...deadTossups(5), event({ type: 'half-break', questionNumber: 5, lastQuestion: 5 })];

    expect(deriveGame(format, setup, events).phase).toEqual({ kind: 'score-check', afterQuestion: 5 });
  });
});

describe('breaks are what the restrictive substitution policy means', () => {
  const restrictive = scheduled([5, 10], { substitutionPolicy: 'breaks-timeouts-overtime' });

  const substitution = (questionNumber: number) =>
    event({ type: 'substitution', questionNumber, team: 'left' as const, activePlayers: ['James'] });

  test('a substitution between scheduled breaks is refused, naming the tossups that qualify', () => {
    const events = deadTossups(3);
    const verdict = canApplyScoreEvent({ format, setup, procedure: restrictive }, events, substitution(4));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe(
      'Lineup changes are available after tossup 5 or 10, at a timeout, or at a phase checkpoint.',
    );
  });

  test('the same substitution at a scheduled break is allowed', () => {
    const events = [...deadTossups(5), event({ type: 'half-break', questionNumber: 5, lastQuestion: 5 })];

    expect(canApplyScoreEvent({ format, setup, procedure: restrictive }, events, substitution(6)).ok).toBe(true);
  });

  test('the phrase every surface uses says a break when there is no schedule to name', () => {
    expect(substitutionOpportunityPhrase(undefined)).toBe('at a break, at a timeout, or at a phase checkpoint');
    expect(substitutionOpportunityPhrase(scheduled([10]))).toBe(
      'after tossup 10, at a timeout, or at a phase checkpoint',
    );
    expect(substitutionOpportunityPhrase(scheduled([5, 10, 15]))).toBe(
      'after tossup 5, 10 or 15, at a timeout, or at a phase checkpoint',
    );
  });
});

describe('the clock follows the breaks', () => {
  test('a round with three breaks has four play segments, each with its own clock', () => {
    expect(roomClockSegment(true, 0, false, false)).toBe('half-1');
    expect(roomClockSegment(true, 1, false, false)).toBe('half-2');
    expect(roomClockSegment(true, 2, false, false)).toBe('half-3');
    expect(roomClockSegment(true, 3, false, false)).toBe('half-4');
  });

  test('a score check still belongs to the segment that just ended', () => {
    // The room is agreeing the score of the half it played, and that is the clock in front of it.
    expect(roomClockSegment(true, 1, true, false)).toBe('half-1');
    expect(roomClockSegment(true, 3, true, false)).toBe('half-3');
  });

  test('overtime and a room that takes no breaks are unchanged', () => {
    expect(roomClockSegment(true, 2, false, true)).toBe('overtime');
    expect(roomClockSegment(false, 0, false, false)).toBe('half-1');
    expect(roomClockSegment(undefined, 0, false, false)).toBe('half-1');
  });
});
