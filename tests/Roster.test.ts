import { describe, expect, test } from 'vitest';
import { readRosterLines, rosterLineProblems } from '../src/game/Roster';

describe('roster paste reading', () => {
  test('keeps the ordinary one-name-per-line workflow unchanged', () => {
    expect(readRosterLines('  Smith, John  \n\n  Garcia\r\nNguyen\r\n')).toEqual([
      'Smith, John',
      'Garcia',
      'Nguyen',
    ]);
  });

  test('uses the first column for consistently tab-separated spreadsheet rows', () => {
    expect(readRosterLines('Smith, John\tTeam A\tYear 1\r\n  Garcia\tTeam A\nNguyen\tTeam A')).toEqual([
      'Smith, John',
      'Garcia',
      'Nguyen',
    ]);
  });

  test('does not guess a column for a mixed or ambiguous paste', () => {
    expect(readRosterLines('Smith, John\tTeam A\nGarcia')).toEqual(['Smith, John\tTeam A', 'Garcia']);
    expect(readRosterLines('\tTeam A\nGarcia\tTeam A')).toEqual(['\tTeam A', 'Garcia\tTeam A']);
  });

  test('never splits comma-shaped names', () => {
    expect(readRosterLines('Smith, John\nDoe, Jane')).toEqual(['Smith, John', 'Doe, Jane']);
    expect(readRosterLines('Smith, John\tTeam A\nDoe, Jane\tTeam A')).toEqual(['Smith, John', 'Doe, Jane']);
  });
});

describe('roster validation', () => {
  test('flags duplicate player names regardless of capitalization', () => {
    expect(rosterLineProblems(['Alex Smith', 'alex smith'])).toEqual([
      '"alex smith" is listed more than once.',
    ]);
  });
});
