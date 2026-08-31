import { describe, expect, test } from 'vitest';
import { gameFormatSummary, formatSummary, procedureSummary } from '../src/scoring/gameFormatSummary';
import { IScorekeeperFormat, scorekeeperFormatVersion } from '../src/scoring/ScorekeeperFormat';
import { roomProcedureVersion } from '../src/scoring/RoomProcedure';

function format(overrides: Partial<IScorekeeperFormat> = {}): IScorekeeperFormat {
  return {
    version: scorekeeperFormatVersion,
    name: 'Room rules',
    answerTypes: [
      {
        index: 0,
        value: 15,
        label: 'Power',
        shortLabel: 'P',
        isPower: true,
        isNeg: false,
        awardsBonus: true,
        qbjId: 'power',
      },
      {
        index: 1,
        value: 10,
        label: 'Correct',
        shortLabel: 'C',
        isPower: false,
        isNeg: false,
        awardsBonus: true,
        qbjId: 'correct',
      },
      {
        index: 2,
        value: -5,
        label: 'Neg',
        shortLabel: 'N',
        isPower: false,
        isNeg: true,
        awardsBonus: false,
        qbjId: 'neg',
      },
    ],
    regulation: { timed: false, tossupCount: 20, maximumTossupCount: 20 },
    bonus: {
      enabled: true,
      bounceBack: false,
      regular: true,
      divisor: 10,
      minimumParts: 3,
      maximumParts: 3,
      pointsPerPart: 10,
      maximumScore: 30,
    },
    overtime: { minimumQuestionCount: 1, suddenDeath: true, includesBonuses: false },
    lightning: { enabled: false, countPerTeam: 0, divisor: 10 },
    players: { maximumActive: 4 },
    totalDivisor: 5,
    ...overrides,
  };
}

describe('human-readable parsed game summaries', () => {
  test('describes the structural format without assuming a named ruleset', () => {
    const summary = formatSummary(format({ name: '' }));
    expect(summary).toContain('20 tossups');
    expect(summary).toContain('+15 / +10 / -5');
    expect(summary).toContain('4 players');
    expect(summary).toContain('30-point bonuses');
    expect(summary).toContain('untimed');
  });

  test('includes parsed non-default format details', () => {
    const summary = formatSummary(
      format({
        regulation: { timed: true, tossupCount: 20, maximumTossupCount: 24 },
        overtime: { minimumQuestionCount: 3, suddenDeath: false, includesBonuses: true },
        lightning: { enabled: true, countPerTeam: 2, divisor: 5 },
        bonus: {
          enabled: true,
          bounceBack: true,
          regular: false,
          divisor: 5,
          minimumParts: 2,
          maximumParts: 4,
          maximumScore: 40,
        },
      }),
    );
    expect(summary).toContain('20 tossups planned (up to 24)');
    expect(summary).toContain('timed');
    expect(summary).toContain('40-point bonuses, 2–4 parts, bouncing back');
    expect(summary).toContain('3-tossup overtime with bonuses');
    expect(summary).toContain('2 lightning rounds per team in 5-point increments');
  });

  test('describes procedure details from the parsed object', () => {
    const summary = procedureSummary({
      version: roomProcedureVersion,
      halves: true,
      breaks: [{ afterTossup: 10, label: 'Halftime' }, { afterTossup: 20 }],
      halfLengthMinutes: 12,
      timeoutsPerTeam: 1,
      timeoutDurationSeconds: 60,
      protestCheckpoints: 'phase-boundaries',
      substitutionPolicy: 'breaks-timeouts-overtime',
    });
    expect(summary).toContain('1 timeout each');
    expect(summary).toContain('Halftime (after tossup 10) and after tossup 20');
    expect(summary).toContain('lineups change at breaks, timeouts, and phase checkpoints');
    expect(summary).toContain('12-minute halves');
    expect(summary).toContain('protests checked at phase boundaries');
  });

  test('keeps the setup and details surfaces on one formatter', () => {
    const formatValue = format();
    expect(gameFormatSummary(formatValue, undefined)).toEqual({
      format: formatSummary(formatValue),
      procedure: procedureSummary(undefined),
    });
  });
});
