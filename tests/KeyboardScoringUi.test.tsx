/**
 * Keyboard scoring, driven through the real scoresheet.
 *
 * `KeyboardScoring.test.ts` pins the model. This is about the parts that only exist once the layer is
 * attached to a live game: that a keystroke records the same event a tap would, that a substitution moves
 * the name behind a key without moving the key, and — most of all — that the shortcuts are silent while
 * somebody is typing.
 *
 * That last one is the reason this file is long. A scorekeeper typing "Alexander" into the Players dialog
 * must not score four tossups doing it, and the ways that can go wrong are all about focus and event
 * targets rather than about scoring.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openApp, openGameFile, gameFile, press, startLineups } from './appHarness';
import { resetKeyboardPreference, saveKeyboardEnabled } from '../src/scorer/keyboardPreference';
import { validPackage } from './packages';

/** Turn the layer on the way the stored preference would, before the app reads it. */
function enableKeyboard(): void {
  saveKeyboardEnabled(true);
  resetKeyboardPreference();
}

beforeEach(() => {
  saveKeyboardEnabled(false);
  resetKeyboardPreference();
});

afterEach(() => {
  saveKeyboardEnabled(false);
  resetKeyboardPreference();
});

/** Press one key at the document. */
async function pressRawKey(
  code: string,
  options: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean; repeat?: boolean; key?: string } = {},
): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, {
      code,
      key: options.key ?? code.replace(/^Key/, '').toLowerCase(),
      shiftKey: options.shift ?? false,
      altKey: options.alt ?? false,
      ctrlKey: options.ctrl ?? false,
      metaKey: options.meta ?? false,
      repeat: options.repeat ?? false,
    });
  });
}

/** Press the numeric seat followed by its action. */
async function pressSequence(number: number, action: string): Promise<void> {
  await pressRawKey(`Digit${number}`, { key: String(number) });
  await pressRawKey(`Key${action.toUpperCase()}`, { key: action.toLowerCase() });
}

/**
 * Keep the older seat-code call sites readable while the cases migrate to the public numeric scheme.
 * The application itself only sees the two numeric events emitted here.
 */
async function pressSeatCode(code: string, options: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean; repeat?: boolean } = {}): Promise<void> {
  const numbers: Record<string, number> = {
    KeyA: 1,
    KeyS: 2,
    KeyD: 3,
    KeyF: 4,
    KeyJ: 5,
    KeyK: 6,
    KeyL: 7,
    Semicolon: 8,
  };
  const number = numbers[code];
  if (number === undefined || options.ctrl || options.meta) {
    await pressRawKey(code, { ...options, key: code.replace(/^Key/, '').toLowerCase() });
    return;
  }
  if (options.repeat) {
    await pressRawKey(`Digit${number}`, { repeat: true, key: String(number) });
    return;
  }
  await pressRawKey(`Digit${number}`, { key: String(number) });
  if (options.shift && options.alt) return;
  const action = options.shift ? 'p' : options.alt ? 'n' : 'c';
  await pressRawKey(`Key${action.toUpperCase()}`, { key: action });
}

async function pressKey(
  code: string,
  options: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean; repeat?: boolean; key?: string } = {},
): Promise<void> {
  if (/^(?:Key[ASDFJKL]|Semicolon)$/.test(code)) {
    await pressSeatCode(code, options);
    return;
  }
  await pressRawKey(code, options);
}

/** Open a game with the layer already on and the lineup settled. */
async function openScoringWithKeyboard(file = gameFile()): Promise<void> {
  enableKeyboard();
  await openApp();
  await openGameFile(file);
  await startLineups();
}

async function openScoringWithoutKeyboard(): Promise<void> {
  await openApp();
  await openGameFile();
  await startLineups();
}

function leftScore(): string {
  return screen.getByLabelText('Ninety Six A score').textContent ?? '';
}

function rightScore(): string {
  return screen.getByLabelText('Greenwood score').textContent ?? '';
}

describe('the eight numeric seat numbers', () => {
  // The fixture fields three players a side, so the fourth number of each side has nobody in its seat and
  // is checked separately below. Asserted against the activity rail, which is the scoresheet's own
  // record of who was ruled on — the roster row carries the same name, so an unscoped query matches both.
  test.each([
    [1, 'Sarah Mitchell'],
    [2, 'James Okafor'],
    [3, 'Alex Rivera'],
    [5, 'Emma Chen'],
    [6, 'Jordan Blake'],
    [7, 'Morgan Ellis'],
  ])('%s then C scores the player in that seat', async (number, player) => {
    await openScoringWithKeyboard();

    await pressSequence(number, 'c');

    const rail = screen.getByLabelText('Recent activity');
    await waitFor(() => expect(within(rail).getByText(new RegExp(player))).toBeInTheDocument());
  });

  test('1 is the first left seat', async () => {
    await openScoringWithKeyboard();

    await pressSequence(1, 'c');
    await waitFor(() => expect(leftScore()).toContain('10'));
    expect(rightScore()).toBe('0');
  });

  test('5 is the first right seat', async () => {
    await openScoringWithKeyboard();

    await pressSequence(5, 'c');

    await waitFor(() => expect(rightScore()).toContain('10'));
  });

  test('a key for a seat nobody is sitting in does nothing', async () => {
    // Three players a side in the fixture, so the fourth seat is empty. A team playing short is
    // ordinary and must not produce a ruling against nobody.
    await openScoringWithKeyboard();

    await pressSequence(4, 'c');

    expect(leftScore()).toBe('0');
  });
});

describe('the action keys', () => {
  test('C records the ordinary correct answer from the format', async () => {
    await openScoringWithKeyboard();

    await pressKey('KeyA');

    await waitFor(() => expect(leftScore()).toContain('10'));
  });

  test('P records the power', async () => {
    await openScoringWithKeyboard();

    await pressKey('KeyA', { shift: true });

    await waitFor(() => expect(leftScore()).toContain('15'));
  });

  test('N records the penalty', async () => {
    await openScoringWithKeyboard();

    await pressKey('KeyA', { alt: true });

    await waitFor(() => expect(leftScore()).toContain('-5'));
  });

  test('Ctrl plus a number is left to Chrome or ChromeOS', async () => {
    await openScoringWithKeyboard();

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Digit1',
      key: '1',
      ctrlKey: true,
    });
    await act(async () => {
      document.dispatchEvent(event);
    });

    // Ctrl+1 event is a browser/operating-system shortcut, not a keyboard ruling. It must not spend the
    // team's chance or be turned into a no-penalty score by this listener.
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByText('Tossup 1 of 20')).toBeInTheDocument();
    expect(leftScore()).toBe('0');
  });

  test('modifier chords record nothing', async () => {
    await openScoringWithKeyboard();

    await pressKey('KeyA', { shift: true, alt: true });

    expect(leftScore()).toBe('0');
  });

  test('Cmd plus a number is left to the browser', async () => {
    await openScoringWithKeyboard();

    await pressKey('KeyA', { meta: true });

    expect(leftScore()).toBe('0');
  });

  test('the map teaches the numeric sequence and does not teach modifier chords', async () => {
    await openScoringWithKeyboard();

    const map = screen.getByLabelText('Keyboard scoring');
    expect(within(map).queryByText('Ctrl + seat')).toBeNull();
    expect(within(map).getByText('seat → 0')).toBeInTheDocument();
    expect(within(map).getByText('5')).toBeInTheDocument();
  });

  test('N does nothing once the other team has already answered', async () => {
    await openScoringWithKeyboard();

    // Greenwood answers wrong with no penalty, so the question has been read out.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Emma Chen 0 after readout wrong, no penalty' }));
    });
    await pressKey('KeyA', { alt: true });

    // No neg was recorded, because a neg is not a legal ruling any more.
    expect(leftScore()).toBe('0');
  });

  test('a number aimed at a team that has already answered does nothing', async () => {
    await openScoringWithKeyboard();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sarah Mitchell 0 after readout wrong, no penalty' }));
    });
    await pressKey('KeyA');

    expect(leftScore()).toBe('0');
  });
});

describe('a substitution moves the name, not the key', () => {
  test('the incoming player inherits the outgoing one’s seat key', async () => {
    await openScoringWithKeyboard();

    // James Okafor is in the second seat, so `S`. The fixture fields three a side with a floor of four,
    // so two players have to be added before there is a bench: the first fills the empty fourth seat, and
    // the second is the one who can come on.
    for (const name of ['Dana Ford', 'Priya Raman']) {
      await press('Players');
      // Open the left team's inline form; the right team's form remains closed.
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: /Add player/ })[0]);
      });
      const addField = screen.getAllByLabelText('Player name')[0];
      const addForm = addField.closest('form') as HTMLFormElement;
      await act(async () => {
        fireEvent.change(addField, { target: { value: name } });
      });
      await act(async () => {
        fireEvent.submit(addForm);
      });
    }
    const row = Array.from(document.querySelectorAll('.scorer-player')).find(
      (candidate) => candidate.querySelector('.scorer-player-name')?.textContent === 'James Okafor',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByLabelText('Substitute for James Okafor'));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Priya Raman' }));
    });

    // The key was never bound to the person: `PlayerSeating.takeSeat` puts the incoming player in the
    // outgoing one's place, so the second seat is still the second seat and `S` still addresses it.
    await pressKey('KeyS');

    const rail = screen.getByLabelText('Recent activity');
    await waitFor(() => expect(within(rail).getByText(/Priya Raman/)).toBeInTheDocument());
  });
});

describe('opting in', () => {
  test('the layer is off for somebody who has never asked for it', async () => {
    await openScoringWithoutKeyboard();

    await pressKey('KeyA');

    // The whole point: an ordinary keystroke on a scoresheet somebody has been using for a year must
    // not record a tossup.
    expect(leftScore()).toBe('0');
    expect(screen.queryByLabelText('Keyboard scoring')).toBeNull();
  });

  test('the menu says which state it is in, and switching it on shows the map', async () => {
    await openScoringWithoutKeyboard();

    await press('Game');
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Keyboard scoring: off' }));
    });

    expect(await screen.findByLabelText('Keyboard scoring')).toBeInTheDocument();
    await pressKey('KeyA');
    await waitFor(() => expect(leftScore()).toContain('10'));
  });

  test('the preference survives a reload of the application', async () => {
    await openScoringWithoutKeyboard();
    await press('Game');
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Keyboard scoring: off' }));
    });

    // A fresh application against the same storage. The preference is device-scoped and is deliberately
    // not aged out: a scorekeeper who turned this on in the morning has not changed their mind by lunch.
    cleanup();
    resetKeyboardPreference();
    await openApp();

    expect(await screen.findByText('Unfinished game')).toBeInTheDocument();
    await press('Resume');
    expect(await screen.findByLabelText('Keyboard scoring')).toBeInTheDocument();
  });
});

describe('shortcuts stay silent while somebody is typing', () => {
  test('nothing is scored while a dialog is open', async () => {
    await openScoringWithKeyboard();

    await press('Game');
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Notes' }));
    });
    await pressKey('KeyA');
    await pressKey('KeyA', { shift: true });

    expect(leftScore()).toBe('0');
  });

  test('the map says the keyboard is not aimed at the scoresheet', async () => {
    await openScoringWithKeyboard();

    await press('Game');
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Notes' }));
    });

    // A map that lied about the current state would be worse than no map, because it is what somebody
    // checks when they are unsure.
    expect(within(screen.getByLabelText('Keyboard scoring')).getByText(/Finish what is open first/)).toBeInTheDocument();
  });

  test('a keystroke aimed at a text field belongs to the field', async () => {
    await openScoringWithKeyboard();
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();

    await act(async () => {
      fireEvent.keyDown(field, { code: 'KeyA', key: 'a' });
    });

    expect(leftScore()).toBe('0');
    field.remove();
  });

  test('a keystroke aimed at a textarea belongs to the textarea', async () => {
    await openScoringWithKeyboard();
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();

    await act(async () => {
      fireEvent.keyDown(field, { code: 'KeyD', key: 'd' });
    });

    expect(leftScore()).toBe('0');
    field.remove();
  });

  test('a keystroke aimed at a contenteditable belongs to it', async () => {
    // The case the old shortcut guard missed entirely.
    await openScoringWithKeyboard();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.appendChild(editable);

    await act(async () => {
      fireEvent.keyDown(editable, { code: 'KeyA', key: 'a' });
    });

    expect(leftScore()).toBe('0');
    editable.remove();
  });

  test('a keystroke aimed at a combobox belongs to it, because it filters on printable keys', async () => {
    await openScoringWithKeyboard();
    const combo = document.createElement('div');
    combo.setAttribute('role', 'combobox');
    document.body.appendChild(combo);

    await act(async () => {
      fireEvent.keyDown(combo, { code: 'KeyS', key: 's' });
    });

    expect(leftScore()).toBe('0');
    combo.remove();
  });

  test('numeric sequences still work with focus on a scoring button', async () => {
    // The other direction, and it matters: a button does not consume printable scoring keys, so
    // blocking the numeric sequence while one has focus would break the ordinary mixed workflow.
    await openScoringWithKeyboard();
    const button = screen.getByRole('button', { name: 'Sarah Mitchell 10' });
    button.focus();

    await act(async () => {
      fireEvent.keyDown(button, { code: 'Digit5', key: '5' });
      fireEvent.keyDown(button, { code: 'KeyC', key: 'c' });
    });

    await waitFor(() => expect(rightScore()).toContain('10'));
  });
});

describe('a held key', () => {
  test('records once, not once per repeat', async () => {
    await openScoringWithKeyboard();

    await pressKey('KeyA');
    await screen.findByLabelText('Bonus');
    // Nought parts, so the tossup's 10 is the whole score and the repeat guard below is the only thing
    // that can change it.
    await pressKey('Digit0');
    await waitFor(() => expect(screen.getByText('Tossup 2 of 20')).toBeInTheDocument());

    // What the browser sends while a finger rests on the key. Q2 is live here, so a missing repeat
    // guard would record another tossup and add another question to Recent.
    await pressKey('KeyA', { repeat: true });
    await pressKey('KeyA', { repeat: true });
    await pressKey('KeyA', { repeat: true });

    const rail = screen.getByLabelText('Recent activity');
    expect(within(rail).getAllByRole('listitem')).toHaveLength(1);
    await waitFor(() => expect(leftScore()).toContain('10'));
  });

  test('a held undo does not walk back through the game', async () => {
    await openScoringWithKeyboard();
    await pressKey('KeyA');
    await waitFor(() => expect(leftScore()).toContain('10'));

    await pressKey('KeyZ', { ctrl: true, key: 'z' });
    await pressKey('KeyZ', { ctrl: true, key: 'z', repeat: true });
    await pressKey('KeyZ', { ctrl: true, key: 'z', repeat: true });

    await waitFor(() => expect(leftScore()).toBe('0'));
  });
});

describe('undo and redo are unchanged', () => {
  test('undo takes back a keyboard ruling, and redo puts it back', async () => {
    await openScoringWithKeyboard();
    await pressKey('KeyA', { shift: true });
    await waitFor(() => expect(leftScore()).toContain('15'));

    await pressKey('KeyZ', { ctrl: true, key: 'z' });
    await waitFor(() => expect(leftScore()).toBe('0'));

    await pressKey('KeyZ', { ctrl: true, key: 'z', shift: true });
    await waitFor(() => expect(leftScore()).toContain('15'));
  });

  test('undo works with the layer switched off, exactly as it did before', async () => {
    await openScoringWithoutKeyboard();
    // Scored with the mouse, because the keyboard layer is off.
    const button = screen.getByRole('button', { name: 'Sarah Mitchell 10' });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(leftScore()).toContain('10'));

    await pressKey('KeyZ', { ctrl: true, key: 'z' });

    await waitFor(() => expect(leftScore()).toBe('0'));
  });
});

describe('Space is unchanged', () => {
  test('records an unanswered tossup with the layer off', async () => {
    await openScoringWithoutKeyboard();

    await act(async () => {
      fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    });

    await waitFor(() => expect(screen.getByText('Tossup 2 of 20')).toBeInTheDocument());
  });

  test('still defers to a focused button, which is its own long-standing guard', async () => {
    await openScoringWithKeyboard();
    const button = screen.getByRole('button', { name: 'Sarah Mitchell 10' });
    button.focus();

    await act(async () => {
      fireEvent.keyDown(button, { code: 'Space', key: ' ' });
    });

    // With focus on a button, Space *is* that button, and stealing it would score the wrong thing.
    expect(screen.getByText('Tossup 1 of 20')).toBeInTheDocument();
  });
});

describe('the bonus', () => {
  test('the digit is the number of parts converted', async () => {
    await openScoringWithKeyboard();
    await pressKey('KeyA');
    await screen.findByLabelText('Bonus');

    // 0 / 10 / 20 / 30 for this format, so two parts is `2` and is worth 20.
    await act(async () => {
      fireEvent.keyDown(document, { code: 'Digit2', key: '2' });
    });

    // 10 for the tossup plus 20 for the bonus.
    await waitFor(() => expect(leftScore()).toContain('30'));
  });

  test('a bonus nobody converted is 0, which is the key nothing used to be under', async () => {
    await openScoringWithKeyboard();
    await pressKey('KeyA');
    await screen.findByLabelText('Bonus');

    await act(async () => {
      fireEvent.keyDown(document, { code: 'Digit0', key: '0' });
    });

    // The tossup's 10 and nothing else, with the bonus recorded rather than still waiting.
    await waitFor(() => expect(screen.queryByLabelText('Bonus')).toBeNull());
    expect(leftScore()).toContain('10');
  });

  test('the map changes to the bonus choices and stops showing seat keys', async () => {
    await openScoringWithKeyboard();
    await pressKey('KeyA');
    await screen.findByLabelText('Bonus');

    const map = screen.getByLabelText('Keyboard scoring');
    expect(within(map).getByText(/bonus/i)).toBeInTheDocument();
    // Showing seat keys here would be advertising bindings that do nothing.
    expect(within(map).queryByText('Left')).toBeNull();
  });

  test('a seat sequence during the bonus does not score a tossup', async () => {
    await openScoringWithKeyboard();
    await pressKey('KeyA');
    await screen.findByLabelText('Bonus');

    // Eight is a valid seat number but is outside this bonus's four digits. It must not reach the
    // tossup listener while the bonus owns the number row.
    await pressSequence(8, 'c');

    // Still on the bonus, and nothing added.
    expect(screen.getByLabelText('Bonus')).toBeInTheDocument();
    expect(leftScore()).toContain('10');
  });

  test('a digit past the last choice records nothing', async () => {
    await openScoringWithKeyboard();
    await pressKey('KeyA');
    await screen.findByLabelText('Bonus');

    await act(async () => {
      fireEvent.keyDown(document, { code: 'Digit9', key: '9' });
    });

    expect(screen.getByLabelText('Bonus')).toBeInTheDocument();
  });

  test('an irregular bonus is typed, and its digits stay its own', async () => {
    // A format whose bonuses have no fixed per-part value has nothing to enumerate, so the prompt is a
    // number field. Its digits must not also be shortcuts.
    const base = validPackage();
    const irregular = gameFile({
      scorekeeperFormat: {
        ...base.scorekeeperFormat,
        bonus: { ...base.scorekeeperFormat.bonus, regular: false, pointsPerPart: undefined },
      },
    });
    await openScoringWithKeyboard(irregular);
    await pressKey('KeyA');

    const field = await screen.findByLabelText('Bonus points');
    await act(async () => {
      fireEvent.keyDown(field, { code: 'Digit2', key: '2' });
    });

    // Nothing recorded from the keystroke; the field is still waiting.
    expect(screen.getByLabelText('Bonus points')).toBeInTheDocument();
    expect(leftScore()).toContain('10');
  });
});

describe('the readout at the bottom of the screen', () => {
  /** The readout region, which is always mounted so it can be watched. */
  function region(): HTMLElement {
    return screen.getByRole('status', { name: 'Keyboard shortcut status' });
  }

  /** The pill inside it, or null while the readout has nothing to say. */
  function readout(): HTMLElement | null {
    return region().querySelector('p');
  }

  test('a seat on its own names the person it addresses', async () => {
    // The half-finished sequence is the whole reason this exists. Pressing 2 changes nothing else on
    // screen, and the scorekeeper has to be able to see that the next letter will score James Okafor.
    await openScoringWithKeyboard();

    await pressRawKey('Digit2', { key: '2' });

    const status = readout();
    expect(status).not.toBeNull();
    expect(status).toHaveTextContent('2');
    expect(status).toHaveTextContent('James Okafor');
    // Nothing recorded yet — a named seat is not a ruling.
    expect(leftScore()).toBe('0');
  });

  test('the waiting seat offers only the keys this format can pay for', async () => {
    await openScoringWithKeyboard();

    await pressRawKey('Digit1', { key: '1' });

    const status = region();
    for (const key of ['C', 'P', 'N', '0']) {
      expect(within(status).getByText(key)).toBeInTheDocument();
    }
  });

  test('the completed sequence reads back the ruling and its value', async () => {
    await openScoringWithKeyboard();

    await pressSequence(1, 'p');

    const status = region();
    expect(status).toHaveTextContent('Sarah Mitchell');
    // The name of the action and what this format pays for it, not the bare number.
    expect(status).toHaveTextContent('Power +15');
  });

  test('a neg is read back as a neg', async () => {
    await openScoringWithKeyboard();

    await pressSequence(5, 'n');

    expect(region()).toHaveTextContent('Neg −5');
  });

  test('a wrong answer with no penalty says so rather than inventing a ruling', async () => {
    await openScoringWithKeyboard();

    await pressSequence(1, '0');

    expect(region()).toHaveTextContent('Wrong 0');
  });

  test('the ruling clears itself', async () => {
    await openScoringWithKeyboard();

    await pressSequence(1, 'c');
    expect(readout()).not.toBeNull();

    await waitFor(() => expect(readout()).toBeNull(), { timeout: 4000 });
  });

  test('a seat abandoned by a key that is not an action stops being shown', async () => {
    await openScoringWithKeyboard();

    await pressRawKey('Digit1', { key: '1' });
    expect(readout()).not.toBeNull();

    await pressRawKey('KeyQ', { key: 'q' });

    expect(readout()).toBeNull();
    expect(leftScore()).toBe('0');
  });

  test('a seat aimed at nobody says nothing', async () => {
    // The fixture fields three a side. Naming an empty seat would be confirming a ruling that cannot
    // happen, which is worse than the silence the keystroke already gets.
    await openScoringWithKeyboard();

    await pressRawKey('Digit4', { key: '4' });

    expect(readout()).toBeNull();
  });

  test('there is no readout at all with the layer switched off', async () => {
    await openScoringWithoutKeyboard();

    await pressRawKey('Digit1', { key: '1' });

    expect(screen.queryByRole('status', { name: 'Keyboard shortcut status' })).toBeNull();
  });
});
