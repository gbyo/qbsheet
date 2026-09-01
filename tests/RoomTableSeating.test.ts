/**
 * Keeping a person in the chair they are already sitting in.
 *
 * The seating preference is keyed by name, and two ordinary things change a name without anybody
 * moving: a correction to a spelling, and a lineup change that replaces several people at once and
 * says nothing about which chair each new arrival took. Both of them, left alone, put somebody at
 * the end of the table who has not stood up — which is worse than a wrong order, because the room
 * arranged the table and then watched the software rearrange it.
 *
 * These are pure functions of a preference and a lineup, deliberately: none of this is scoring
 * history, none of it may reach an event, and every case below can be reasoned about without a
 * scoresheet on screen. `RoomTableView` covers what the view does with them.
 */
import { describe, expect, test } from 'vitest';
import { orderBySeating, renameSeatPlayer, reseatLineup } from '../src/scorer/PlayerSeating';

describe('correcting a name', () => {
  test('the corrected player keeps the exact seat they were in', () => {
    const preferred = ['Gibson', 'Maycie', 'Jeremy', 'Adam'];

    expect(renameSeatPlayer(preferred, 'Jeremy', 'Jeremy Cole')).toEqual([
      'Gibson',
      'Maycie',
      'Jeremy Cole',
      'Adam',
    ]);
  });

  test('a side nobody has arranged has nothing to rewrite', () => {
    expect(renameSeatPlayer([], 'Jeremy', 'Jeremy Cole')).toEqual([]);
  });

  test('a name the preference never mentioned leaves it alone', () => {
    const preferred = ['Gibson', 'Maycie'];

    expect(renameSeatPlayer(preferred, 'Somebody Else', 'Corrected')).toEqual(['Gibson', 'Maycie']);
    // A copy, not the array it was given: the caller compares the two to decide whether to write.
    expect(renameSeatPlayer(preferred, 'Somebody Else', 'Corrected')).not.toBe(preferred);
  });

  test('a merge leaves one seat rather than two, and it is the earlier of them', () => {
    // The room typed the same person in twice at tossup 4 and is now reconciling the two.
    const preferred = ['Gibson', 'Maycie', 'Jeremy', 'Jerry'];

    const merged = renameSeatPlayer(preferred, 'Jerry', 'Jeremy');

    expect(merged).toEqual(['Gibson', 'Maycie', 'Jeremy']);
    expect(new Set(merged).size).toBe(merged.length);
  });

  test('merging the other way round is still one seat, and still the earlier one', () => {
    const preferred = ['Gibson', 'Maycie', 'Jeremy', 'Jerry'];

    expect(renameSeatPlayer(preferred, 'Jeremy', 'Jerry')).toEqual(['Gibson', 'Maycie', 'Jerry']);
  });
});

describe('a lineup change nobody described seat by seat', () => {
  const preferred = ['Sarah', 'James', 'Olivia', 'Noah'];

  test('a one-for-one change the seating store has already handled needs nothing', () => {
    // `takeSeat` has run: the preference already seats Emma where Sarah was.
    const afterTakeSeat = ['Emma', 'Sarah', 'James', 'Olivia', 'Noah'];

    const result = reseatLineup(
      afterTakeSeat,
      ['Sarah', 'James', 'Olivia', 'Noah'],
      ['Emma', 'James', 'Olivia', 'Noah'],
    );

    expect(result.seats).toEqual(['Emma', 'James', 'Olivia', 'Noah']);
    // One chair changed hands, which is a substitution and not something to warn about.
    expect(result.vacated).toBe(1);
  });

  test('surviving players keep their chairs and the emptied ones are filled in order', () => {
    const result = reseatLineup(
      preferred,
      ['Sarah', 'James', 'Olivia', 'Noah'],
      ['Olivia', 'Noah', 'Emma', 'Chris'],
    );

    expect(result.seats).toEqual(['Emma', 'Chris', 'Olivia', 'Noah']);
    expect(result.vacated).toBe(2);
  });

  test('the same change twice produces the same table', () => {
    const first = reseatLineup(
      preferred,
      ['Sarah', 'James', 'Olivia', 'Noah'],
      ['Olivia', 'Noah', 'Emma', 'Chris'],
    );
    const second = reseatLineup(
      preferred,
      ['Sarah', 'James', 'Olivia', 'Noah'],
      ['Olivia', 'Noah', 'Emma', 'Chris'],
    );

    expect(second.seats).toEqual(first.seats);
  });

  test('a team that shrinks closes up rather than leaving a gap', () => {
    const result = reseatLineup(preferred, ['Sarah', 'James', 'Olivia', 'Noah'], ['Sarah', 'Noah']);

    expect(result.seats).toEqual(['Sarah', 'Noah']);
    expect(result.vacated).toBe(2);
  });

  test('a team that grows seats the newcomer on the end, where an unseated player goes anyway', () => {
    const result = reseatLineup(preferred, ['Sarah', 'James'], ['Sarah', 'James', 'Olivia']);

    expect(result.seats).toEqual(['Sarah', 'James', 'Olivia']);
    expect(result.vacated).toBe(0);
  });

  test('it reads the room arrangement rather than the lineup order', () => {
    // The room has James first on the floor even though the recorded lineup starts with Sarah.
    const arranged = ['James', 'Sarah', 'Olivia', 'Noah'];

    const result = reseatLineup(
      arranged,
      ['Sarah', 'James', 'Olivia', 'Noah'],
      ['Olivia', 'Noah', 'Emma', 'Chris'],
    );

    // James's chair was first, so the first arrival takes it.
    expect(result.seats).toEqual(['Emma', 'Chris', 'Olivia', 'Noah']);
  });

  test('the result is a complete order for the players on the floor and nobody else', () => {
    const result = reseatLineup(
      preferred,
      ['Sarah', 'James', 'Olivia', 'Noah'],
      ['Olivia', 'Noah', 'Emma', 'Chris'],
    );

    expect(new Set(result.seats)).toEqual(new Set(['Olivia', 'Noah', 'Emma', 'Chris']));
    // And it is what `orderBySeating` will produce from it, which is the thing the view renders.
    expect(orderBySeating(['Olivia', 'Noah', 'Emma', 'Chris'], result.seats, (name) => name)).toEqual(
      result.seats,
    );
  });
});
