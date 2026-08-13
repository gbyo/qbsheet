/**
 * Stating an unusual format, and unusual breaks, through the real screens.
 *
 * # What these defend
 *
 * That a format the basic four questions cannot express is now enterable in the room, and that what
 * comes out the other end is an *ordinary* game: the answer types typed into the form are the buttons
 * on the scorer, an irregular bonus makes the scorer ask for a total instead of offering parts, and a
 * scheduled break is a break the room is offered exactly once, where the director put it.
 *
 * That last part is why these go through the app rather than through `defineManualGame`. The unit tests
 * already prove the format and the procedure are built correctly; what they cannot prove is that the
 * form can actually say it and the scorer actually reads it.
 *
 * # And that switching forms is not a way to lose a format
 *
 * Going to the advanced form must carry the values across, and coming back must either be lossless or
 * unavailable. A form that quietly drops a second power tier on the way to a simpler screen is showing
 * a format nobody entered, which is worse than either alternative.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { bonus, openApp, press, pressControl, score, startLineups } from './appHarness';
import { claimResponseTimeoutMs } from '../src/persistence/TabClaim';

afterEach(cleanup);

function type(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Open the setup form and name the two teams, so the roster boxes can be found by team name. */
async function openSetup(): Promise<void> {
  await press('Create game');
  await screen.findByRole('heading', { name: 'Create a game' });
  await act(async () => {
    type('Left team name', 'Ninety Six');
    type('Right team name', 'Greenwood');
  });
  await act(async () => {
    type('Ninety Six players', 'Sarah\nJames');
    type('Greenwood players', 'Emma\nJordan');
  });
}

async function startGame(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
  });
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, claimResponseTimeoutMs + 50);
    });
  });
}

/** The answer-type rows on screen, as `{ points, name }`, in the order the form shows them. */
function answerTypeRows(): { points: string; name: string }[] {
  return screen.getAllByLabelText('Points').map((pointsField) => {
    const row = pointsField.closest('.answer-type-row') as HTMLElement;
    return {
      points: (pointsField as HTMLInputElement).value,
      name: (within(row).getByLabelText('Name') as HTMLInputElement).value,
    };
  });
}

/** Fill in the last answer-type row added, which is the one `Add an answer type` just created. */
function fillLastAnswerType(points: string, name: string, short: string): void {
  const rows = screen.getAllByLabelText('Points');
  const row = rows[rows.length - 1].closest('.answer-type-row') as HTMLElement;
  fireEvent.change(within(row).getByLabelText('Points'), { target: { value: points } });
  fireEvent.change(within(row).getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(within(row).getByLabelText('Short'), { target: { value: short } });
}

/**
 * Switch to the advanced form, with a power tier already stated in the simple one.
 *
 * `basicScoringRulesDefaults` has no power, so the advanced form opens with two rows. A test about a
 * second power tier needs a first one, and stating it in the simple form is also the honest route: it
 * is how a director gets there.
 */
async function goAdvancedWithPower(): Promise<void> {
  await act(async () => {
    type('Power (blank for none)', '15');
  });
  await press('Advanced rules');
}

/** Add a second power tier worth 20, so the format is one the simple form cannot state. */
async function addSuperpower(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add an answer type' }));
  });
  await act(async () => {
    fillLastAnswerType('20', 'Superpower', 'S');
  });
}

/** A converted tossup and the bonus that follows it, for a regular bonus. */
async function convert(playerName: string, shortLabel = 'C', bonusTotal = '30'): Promise<void> {
  await score(playerName, shortLabel);
  await bonus(bonusTotal);
}

describe('switching between the simple and advanced rule forms', () => {
  test('the advanced form opens holding what the simple one said', async () => {
    await openApp();
    await openSetup();

    await act(async () => {
      type('Correct tossup', '10');
      type('Power (blank for none)', '15');
      type('Neg (blank for none)', '-5');
    });
    await press('Advanced rules');

    // The same three values, spelled out as rows, in the order the scorer will show them.
    expect(answerTypeRows()).toEqual([
      { points: '15', name: 'Power' },
      { points: '10', name: 'Correct' },
      { points: '-5', name: 'Neg' },
    ]);
  });

  test('a format the simple form could also state can go back, and says so', async () => {
    await openApp();
    await openSetup();
    await press('Advanced rules');

    const simplify = screen.getByRole('button', { name: 'Simple rules' });
    expect(simplify.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(/also fit the simple form/)).toBeTruthy();

    await press('Simple rules');
    expect(screen.getByLabelText('Correct tossup')).toBeTruthy();
  });

  test('a format the simple form cannot state refuses to go back, and says why', async () => {
    await openApp();
    await openSetup();
    await goAdvancedWithPower();
    await addSuperpower();

    // Two power tiers. Going back would have to discard one, so the control is not offered.
    const simplify = screen.getByRole('button', { name: 'Simple rules' });
    expect(simplify.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/going back would change them/)).toBeTruthy();
    expect(screen.queryByLabelText('Correct tossup')).toBeNull();
  });

  test('an irregular bonus alone is enough to make the simple form unable to state it', async () => {
    await openApp();
    await openSetup();
    await press('Advanced rules');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Bonuses vary in parts or in what a part is worth'));
    });

    expect(screen.getByRole('button', { name: 'Simple rules' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('an answer-type table is a table', () => {
  test('a row can be added, moved and removed', async () => {
    await openApp();
    await openSetup();
    await goAdvancedWithPower();
    await addSuperpower();
    expect(answerTypeRows().map((row) => row.points)).toEqual(['15', '10', '-5', '20']);

    // The form does not sort as values are typed — that would move the row out from under the cursor
    // — so Move up is how a director makes the table read the way the scorer will.
    await press('Move Superpower up');
    expect(answerTypeRows().map((row) => row.points)).toEqual(['15', '10', '20', '-5']);

    await press('Remove Neg');
    expect(answerTypeRows().map((row) => row.name)).toEqual(['Power', 'Correct', 'Superpower']);
  });

  test('a row with no value typed in it stops the game starting, and says which row', async () => {
    await openApp();
    await openSetup();
    await press('Advanced rules');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add an answer type' }));
    });
    await act(async () => {
      const rows = screen.getAllByLabelText('Points');
      const row = rows[rows.length - 1].closest('.answer-type-row') as HTMLElement;
      fireEvent.change(within(row).getByLabelText('Name'), { target: { value: 'Partial' } });
    });

    await startGame();
    expect(screen.getByText('"Partial" needs a point value.')).toBeTruthy();
    // Still on the form: nothing was created.
    expect(screen.getByRole('heading', { name: 'Create a game' })).toBeTruthy();
  });
});

describe('a format with two power tiers reaches the scorer', () => {
  test('every answer type typed in is a button on the roster, and scores what it says', async () => {
    await openApp();
    await openSetup();
    await goAdvancedWithPower();
    await addSuperpower();
    await startGame();
    await startLineups();

    const panel = screen.getByLabelText('Ninety Six');
    // All four, including the second tier the basic form had no field for.
    for (const label of ['Superpower', 'Power', 'Correct', 'Neg']) {
      expect(within(panel).getByRole('button', { name: `Sarah ${label}` })).toBeTruthy();
    }

    // 20 for the tossup, and the bonus it earned.
    await convert('Sarah', 'S');
    expect(screen.getByLabelText('Ninety Six score').textContent).toContain('50');
  });
});

describe('an irregular bonus', () => {
  /** Fill the irregular bonus fields, having already switched to the advanced form. */
  const stateIrregularBonus = async () => {
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Bonuses vary in parts or in what a part is worth'));
    });
    await act(async () => {
      type('Most a bonus is worth', '40');
      type('Bonus score increment', '10');
      type('Fewest parts', '2');
      type('Most parts', '3');
    });
  };

  test('makes the scorer ask for a total rather than offering a set of parts', async () => {
    await openApp();
    await openSetup();
    await press('Advanced rules');
    await stateIrregularBonus();
    await startGame();
    await startLineups();

    await score('Sarah', 'C');

    // No fixed buttons: an irregular bonus has no known set of totals to offer.
    const prompt = screen.getByLabelText('Bonus');
    expect(within(prompt).queryByRole('button', { name: '30' })).toBeNull();
    expect(within(prompt).getByLabelText('Bonus points')).toBeTruthy();

    await act(async () => {
      fireEvent.change(within(prompt).getByLabelText('Bonus points'), { target: { value: '40' } });
    });
    await act(async () => {
      fireEvent.click(within(prompt).getByRole('button', { name: 'Record' }));
    });
    expect(screen.getByLabelText('Ninety Six score').textContent).toContain('50');
  });

  test('a maximum that is not a multiple of the increment is refused before the game starts', async () => {
    await openApp();
    await openSetup();
    await press('Advanced rules');
    await stateIrregularBonus();
    await act(async () => {
      type('Most a bonus is worth', '35');
    });

    await startGame();
    expect(screen.getByText('The maximum bonus score must be a multiple of the bonus score increment.')).toBeTruthy();
  });
});

describe('scheduled breaks, through the real screens', () => {
  /** Turn breaks on and schedule one after the given tossup, optionally naming it. */
  const scheduleBreak = async (afterTossup: string, name?: string) => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a break' }));
    });
    await act(async () => {
      const rows = screen.getAllByLabelText('After tossup');
      const row = rows[rows.length - 1].closest('.manual-break-row') as HTMLElement;
      fireEvent.change(within(row).getByLabelText('After tossup'), { target: { value: afterTossup } });
      if (name !== undefined) {
        fireEvent.change(within(row).getByLabelText('Name (optional)'), { target: { value: name } });
      }
    });
  };

  const turnBreaksOn = async () => {
    await act(async () => {
      fireEvent.click(screen.getByLabelText('The round has breaks'));
    });
  };

  test('the breaks editor only exists once the round has breaks', async () => {
    await openApp();
    await openSetup();

    expect(screen.queryByRole('button', { name: 'Add a break' })).toBeNull();
    await turnBreaksOn();
    expect(screen.getByRole('button', { name: 'Add a break' })).toBeTruthy();
    expect(screen.getByText('No scheduled breaks.')).toBeTruthy();
  });

  test('a break outside the round is refused, because the room would never reach it', async () => {
    await openApp();
    await openSetup();
    await turnBreaksOn();
    await scheduleBreak('40');

    await startGame();
    expect(
      screen.getByText('Break 1 comes after tossup 40, which is not inside a 20-tossup round.'),
    ).toBeTruthy();
  });

  test('two breaks after the same tossup are refused', async () => {
    await openApp();
    await openSetup();
    await turnBreaksOn();
    await scheduleBreak('5');
    await scheduleBreak('5');

    await startGame();
    expect(screen.getByText('Two breaks are set after tossup 5.')).toBeTruthy();
  });

  test('the scorer offers the scheduled break only once it is owed, and names it', async () => {
    await openApp();
    await openSetup();
    await turnBreaksOn();
    await scheduleBreak('2', 'End of set 1');
    await scheduleBreak('4');
    await startGame();
    await startLineups();

    // Nothing to take yet: the break falls after tossup 2 and one has been read.
    await convert('Sarah');
    expect(screen.queryByRole('button', { name: /End of set 1/ })).toBeNull();

    await convert('Emma');

    // Now it is owed, offered under the director's own name, and takes the room to a score check that
    // uses that name rather than calling tossup 2 of 20 halftime.
    await pressControl('End of set 1 · after tossup 2');
    const check = screen.getByLabelText('End of set 1 score check');
    expect(within(check).getByText('End of set 1 · after tossup 2')).toBeTruthy();
  });

  test('a break taken late is still the break it was, and the next one is still owed', async () => {
    await openApp();
    await openSetup();
    await turnBreaksOn();
    await scheduleBreak('2', 'End of set 1');
    await scheduleBreak('4', 'End of set 2');
    await startGame();
    await startLineups();

    // Nobody calls the break after tossup 2 and the room plays on past the break after 4 as well.
    await convert('Sarah');
    await convert('Emma');
    await convert('Sarah');
    await convert('Emma');
    await convert('Sarah');

    // The oldest owed break is still the first one, and it is what the control offers.
    await pressControl('End of set 1 · after tossup 2');

    // The score check is that same break. Naming it from the tossup the room physically stopped at
    // would head this screen "End of set 2" — the break the room has just been told it is *not* at.
    const check = screen.getByLabelText('End of set 1 score check');
    expect(within(check).getByText('End of set 1 · after tossup 5')).toBeTruthy();
    expect(screen.queryByLabelText('End of set 2 score check')).toBeNull();

    await press('Score confirmed · Continue');

    // And the second break was not swallowed by the first. It is owed the moment play resumes.
    await act(async () => {
      fireEvent.click(screen.getByText('Game'));
    });
    expect(screen.getByRole('menuitem', { name: /End of set 2 · after tossup 4/ })).toBeTruthy();
  });

  test('a break the schedule does not have is not offered between two that it does', async () => {
    await openApp();
    await openSetup();
    await turnBreaksOn();
    await scheduleBreak('2', 'End of set 1');
    await scheduleBreak('6', 'End of set 2');
    await startGame();
    await startLineups();

    await convert('Sarah');
    await convert('Emma');

    await pressControl('End of set 1 · after tossup 2');
    await press('Score confirmed · Continue');

    // Tossup 3 played. The next scheduled stop is after 6, so there is no break to take here.
    await convert('Sarah');
    expect(screen.queryByRole('button', { name: /End of set 2/ })).toBeNull();
    // And no generic one either: the schedule is the only thing that opens a break.
    expect(screen.queryByRole('button', { name: /End this half/ })).toBeNull();
  });
});
