/**
 * The arithmetic behind the sliding row.
 *
 * Tested here rather than through the prompt because the interesting cases are geometric and a
 * rendered test cannot see geometry: jsdom lays nothing out, so every row in a workflow test measures
 * as zero and every shift as none. What the prompt's tests are for is that the lineup is right; what
 * this is for is that if the lineup were rendered, the rows would travel the right way.
 *
 * No test here asserts a duration. The numbers are a design decision that will be adjusted by looking
 * at it, and a test that pins them turns a taste change into a failing suite.
 */
import { describe, expect, test } from 'vitest';
import { lineupMovedClass, lineupMovingClass, rowShifts } from '../src/scorer/LineupMotion';

/** Positions as a browser reports them: a name and the top of its row. */
function at(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

describe('how far a row has to be pushed back', () => {
  test('two starters trading seats travel towards each other by the same distance', () => {
    const before = at({ 'Sarah Jones': 100, 'Michael Smith': 130, 'Jordan Hall': 160 });
    const after = at({ 'Michael Smith': 100, 'Sarah Jones': 130, 'Jordan Hall': 160 });

    const shifts = rowShifts(before, after);
    // Michael is drawn 30px lower than his new seat and released upwards into it; Sarah the reverse.
    expect(shifts.get('Michael Smith')).toBe(30);
    expect(shifts.get('Sarah Jones')).toBe(-30);
    // Jordan did not move, so Jordan is not animated.
    expect(shifts.has('Jordan Hall')).toBe(false);
  });

  test('a row nobody moved is left alone rather than transformed by nothing', () => {
    const same = at({ 'Sarah Jones': 100, 'Michael Smith': 130 });

    expect(rowShifts(same, same).size).toBe(0);
  });

  test('sub-pixel rounding is not a move', () => {
    const before = at({ 'Sarah Jones': 100 });
    const after = at({ 'Sarah Jones': 100.4 });

    expect(rowShifts(before, after).size).toBe(0);
  });

  test('a name in only one measurement has nowhere to travel from', () => {
    // A player added to the roster mid-prompt has a new row and no previous position; animating them
    // from wherever the last row happened to be would be an invention.
    const shifts = rowShifts(at({ 'Sarah Jones': 100 }), at({ 'Sarah Jones': 100, 'Alex Brown': 130 }));

    expect(Array.from(shifts.keys())).toEqual([]);
  });

  test('a player leaving the bench for a seat travels the whole way, and the bench closes up', () => {
    // Starting has one row, then the Bench heading, then two bench rows.
    const before = at({ 'Sarah Jones': 100, 'Michael Smith': 160, 'Jordan Hall': 190 });
    // Michael takes seat 2 directly under Sarah; Jordan is now the only bench row and rises to where
    // Michael's used to be.
    const after = at({ 'Sarah Jones': 100, 'Michael Smith': 130, 'Jordan Hall': 160 });

    const shifts = rowShifts(before, after);
    expect(shifts.get('Michael Smith')).toBe(30);
    expect(shifts.get('Jordan Hall')).toBe(30);
    expect(shifts.has('Sarah Jones')).toBe(false);
  });
});

describe('the class names the stylesheet is written against', () => {
  test('are the ones the stylesheet is written against', () => {
    // Cheap, but these are a contract between a module that adds classes imperatively and a
    // stylesheet that cannot import from it.
    expect(lineupMovingClass).toBe('is-moving');
    expect(lineupMovedClass).toBe('is-moved');
  });
});
