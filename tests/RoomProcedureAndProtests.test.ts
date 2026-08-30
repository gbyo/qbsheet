/**
 * The layer that is not scoring: room procedure settings, and protests as things with a state.
 *
 * The property under test throughout is that none of it touches a statistic. A tournament that
 * configures no procedure gets exactly the behaviour it had before any of this existed, and a
 * protest changes what tournament control is told without changing what anybody scored.
 */
import { describe, expect, test } from 'vitest';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import {
  defaultRoomProcedure,
  maximumHalfLengthMinutes,
  maximumTimeoutDurationSeconds,
  readRoomProcedure,
  roomProcedureIsActive,
  roomProcedureVersion,
} from '../src/scoring/RoomProcedure';
import {
  protestNoteLine,
  unresolvedProtestLines,
  unresolvedProtestMarker,
} from '../src/scoring/ProtestNotes';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import toQbjMatch from '../src/scoring/toQbjMatch';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { event } from './events';
import { eventDescription } from '../src/scorer/OperationsDialogs';

const setup: IGameSetup = {
  left: { name: 'Ninety Six B', players: ['Sarah', 'James'] },
  right: { name: 'Clinton', players: ['Emma', 'Jordan'] },
};

function formatFor(mutate: (rules: ScoringRules) => void = () => {}): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  mutate(rules);
  return scoringRulesToScorekeeperFormat(rules);
}

const format = formatFor();

describe('a procedure nobody configured does nothing', () => {
  test('the default is inert', () => {
    const procedure = defaultRoomProcedure();

    expect(procedure).toEqual({ version: roomProcedureVersion, halves: false, timeoutsPerTeam: 0 });
    expect(roomProcedureIsActive(procedure)).toBe(false);
  });

  test('anything unrecognizable reads back as the default rather than throwing', () => {
    expect(readRoomProcedure(undefined)).toEqual(defaultRoomProcedure());
    expect(readRoomProcedure('halves please')).toEqual(defaultRoomProcedure());
    expect(readRoomProcedure({ version: 99, halves: true, timeoutsPerTeam: 3 })).toEqual(
      defaultRoomProcedure(),
    );
  });

  test('a clock length with no halves to apply it to is dropped', () => {
    const procedure = readRoomProcedure({
      version: roomProcedureVersion,
      halves: false,
      halfLengthMinutes: 10,
    });

    expect(procedure.halfLengthMinutes).toBeUndefined();
  });

  test('an absurd half length is dropped rather than believed', () => {
    const procedure = readRoomProcedure({
      version: roomProcedureVersion,
      halves: true,
      halfLengthMinutes: maximumHalfLengthMinutes + 1,
      timeoutsPerTeam: 1,
    });

    expect(procedure.halfLengthMinutes).toBeUndefined();
    expect(procedure.halves).toBe(true);
  });

  test('a configured procedure is recognized as worth sending to a room', () => {
    expect(roomProcedureIsActive({ version: roomProcedureVersion, halves: true, timeoutsPerTeam: 0 })).toBe(
      true,
    );
    expect(roomProcedureIsActive({ version: roomProcedureVersion, halves: false, timeoutsPerTeam: 1 })).toBe(
      true,
    );
  });

  test('documented default policy values remain inert when explicitly present', () => {
    expect(
      roomProcedureIsActive({
        version: roomProcedureVersion,
        halves: false,
        timeoutsPerTeam: 0,
        protestCheckpoints: 'none',
        substitutionPolicy: 'any-boundary',
      }),
    ).toBe(false);
  });

  test('new procedure fields migrate and clamp without losing legacy settings', () => {
    const procedure = readRoomProcedure({
      version: 1,
      halves: true,
      halfLengthMinutes: 12,
      timeoutsPerTeam: 2,
      timeoutDurationSeconds: maximumTimeoutDurationSeconds + 1,
      protestCheckpoints: 'strict-overtime',
      substitutionPolicy: 'breaks-timeouts-overtime',
    });

    expect(procedure).toEqual({
      version: roomProcedureVersion,
      halves: true,
      halfLengthMinutes: 12,
      timeoutsPerTeam: 2,
      protestCheckpoints: 'strict-overtime',
      substitutionPolicy: 'breaks-timeouts-overtime',
    });
  });
});

describe('a protest reaches tournament control', () => {
  const protested: ScoreEvent[] = [
    event({ type: 'tossup-dead', questionNumber: 1 }),
    event({
      type: 'protest',
      questionNumber: 1,
      team: 'right',
      subject: 'tossup-answer',
      description: 'Clinton answered "Bohr" and it was ruled wrong.',
      status: 'open',
    }),
  ];

  test('an open protest is carried on the result, marked as outstanding', () => {
    const game = deriveGame(format, setup, protested);
    const qbj = toQbjMatch(format, game) as { notes?: string };

    expect(unresolvedProtestLines(qbj.notes)).toHaveLength(1);
    expect(qbj.notes).toContain('Clinton');
    expect(qbj.notes).toContain(unresolvedProtestMarker);
  });

  test('a decided protest no longer stops anything', () => {
    const resolved = protested.map((scoreEvent) =>
      scoreEvent.type === 'protest'
        ? { ...scoreEvent, status: 'declined' as const, resolution: 'Ruling stands' }
        : scoreEvent,
    );
    const qbj = toQbjMatch(format, deriveGame(format, setup, resolved)) as { notes?: string };

    expect(unresolvedProtestLines(qbj.notes)).toHaveLength(0);
    expect(qbj.notes).toContain('Ruling stands');
  });

  test('a protest changes nothing about the score', () => {
    const game = deriveGame(format, setup, protested);

    expect(game.left.points).toBe(0);
    expect(game.right.points).toBe(0);
    expect(game.tossupsRead).toBe(1);
    expect(game.protests[0].status).toBe('open');
  });

  test('ordinary notes are not mistaken for protests', () => {
    const notes = [
      'Late start',
      protestNoteLine({
        questionNumber: 4,
        teamName: 'Clinton',
        status: 'upheld',
        subject: 'The question',
        description: 'Two answers were acceptable',
      }),
    ].join('\n');

    expect(unresolvedProtestLines(notes)).toHaveLength(0);
  });
});

describe('what a room-level event does to the exported match', () => {
  test('timeout history uses the readable team name', () => {
    const game = deriveGame(format, setup, []);

    expect(eventDescription(event({ type: 'timeout', questionNumber: 1, team: 'left' }), format, game)).toBe(
      'Timeout: Ninety Six B',
    );
    expect(
      eventDescription(event({ type: 'timeout-start', questionNumber: 1, team: 'left' }), format, game),
    ).toBe('Timeout started: Ninety Six B');
  });

  test('a game ended early says so on the result', () => {
    const game = deriveGame(format, setup, [
      event({ type: 'tossup-dead', questionNumber: 1 }),
      event({ type: 'end-game-early', questionNumber: 2, reason: 'Packet ran out', tossupsRead: 1 }),
    ]);
    const qbj = toQbjMatch(format, game) as { notes?: string; tossups_read?: number };

    expect(qbj.tossups_read).toBe(1);
    expect(qbj.notes).toContain('Packet ran out');
  });

  test('a replaced question is recorded as one, at the question level and in words', () => {
    const game = deriveGame(format, setup, [
      event({ type: 'tossup-dead', questionNumber: 1 }),
      event({ type: 'question-void', questionNumber: 1, scope: 'tossup', reason: 'Wrong packet' }),
      event({ type: 'tossup-dead', questionNumber: 1 }),
    ]);
    const qbj = toQbjMatch(format, game) as {
      notes?: string;
      match_questions?: { question_number: number; tossup_question?: { type: string } }[];
    };

    expect(qbj.notes).toContain('Wrong packet');
    expect(qbj.match_questions?.[0].tossup_question).toEqual({ type: 'replacement' });
  });

  test('a zero-point wrong answer is a buzz worth nothing and never an answer count', () => {
    const game = deriveGame(format, setup, [
      event({ type: 'tossup-no-penalty', questionNumber: 1, team: 'left', playerName: 'Sarah' }),
      event({ type: 'tossup-dead', questionNumber: 1 }),
    ]);
    const qbj = toQbjMatch(format, game) as {
      match_questions?: { buzzes: { result: { value: number } }[] }[];
      match_teams?: { match_players: { player: { name: string }; answer_counts: unknown[] }[] }[];
    };

    expect(qbj.match_questions?.[0].buzzes).toEqual([
      { team: { name: 'Ninety Six B' }, player: { name: 'Sarah' }, result: { value: 0 } },
    ]);
    const sarah = qbj.match_teams?.[0].match_players.find((player) => player.player.name === 'Sarah');
    expect(sarah?.answer_counts).toEqual([]);
  });

  test('a bonus collected part by part travels as parts', () => {
    const powerIndex = format.answerTypes.find((answerType) => answerType.value === 10)!.index;
    const game = deriveGame(format, setup, [
      event({
        type: 'tossup-buzz',
        questionNumber: 1,
        team: 'left',
        playerName: 'Sarah',
        answerTypeIndex: powerIndex,
      }),
      event({
        type: 'bonus',
        questionNumber: 1,
        team: 'left',
        parts: [{ controlledPoints: 10 }, { controlledPoints: 0 }, { controlledPoints: 10 }],
      }),
    ]);
    const qbj = toQbjMatch(format, game) as {
      match_questions?: { bonus?: { parts: { controlled_points: number }[] }; bonus_points?: number }[];
    };

    expect(qbj.match_questions?.[0].bonus_points).toBe(20);
    expect(qbj.match_questions?.[0].bonus?.parts).toHaveLength(3);
    expect(game.left.points).toBe(30);
  });

  test('who was in the room is carried when the room knows', () => {
    const game = deriveGame(format, setup, [event({ type: 'tossup-dead', questionNumber: 1 })]);
    const qbj = toQbjMatch(format, game, { moderator: 'A. Reader', scorekeeper: 'B. Keeper' }) as {
      moderator?: string;
      scorekeeper?: string;
    };

    expect(qbj.moderator).toBe('A. Reader');
    expect(qbj.scorekeeper).toBe('B. Keeper');
  });
});
