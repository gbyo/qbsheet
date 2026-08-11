/**
 * The keyboard drill, driven by real keystrokes.
 *
 * Two things are worth pinning here beyond "the happy path works". The first is that the drill reads a
 * keystroke the way the scoresheet's own listener does — a digit is a seat, `0` is the no-penalty ruling,
 * and an innocent key is ignored rather than called a mistake. The second is the recovery: a wrong second
 * key throws the whole sequence away, because that is what the scoresheet does, and a drill that quietly
 * kept the seat would be teaching a recovery that does not exist.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import KeyboardDrill, { drillKeystroke, drillStart } from '../src/practice/KeyboardDrill';
import { drillTasks, readKeystrokeLabel } from '../src/practice/KeyboardDrillScenario';
import PracticeScreen from '../src/practice/PracticeScreen';
import PracticeSummary from '../src/practice/PracticeSummary';
import { resetKeyboardPreference, saveKeyboardEnabled } from '../src/scorer/keyboardPreference';

beforeEach(() => {
  saveKeyboardEnabled(false);
  resetKeyboardPreference();
});

afterEach(() => {
  // Unmounted first: the preference is module state with live subscribers, and resetting it while a
  // screen is still mounted pushes a React update from outside the test's own act().
  cleanup();
  saveKeyboardEnabled(false);
  resetKeyboardPreference();
});

/** Press one key at the document, the way the real listener receives it. */
function press(
  code: string,
  options: { key?: string; shift?: boolean; ctrl?: boolean; meta?: boolean; repeat?: boolean } = {},
): void {
  act(() => {
    fireEvent.keyDown(document, {
      code,
      key: options.key ?? code.replace(/^Key/, '').toLowerCase(),
      shiftKey: options.shift ?? false,
      ctrlKey: options.ctrl ?? false,
      metaKey: options.meta ?? false,
      altKey: false,
      repeat: options.repeat ?? false,
    });
  });
}

function digit(number: number): void {
  press(`Digit${number}`, { key: String(number) });
}

/** The keystrokes that clear the drill, in order, so a case can get to any point in it. */
function pressWholeDrill(): void {
  digit(1);
  digit(4);
  digit(7);
  digit(5);
  press('KeyC');
  digit(1);
  press('KeyP');
  digit(2);
  press('KeyN');
  digit(3);
  press('Digit0', { key: '0' });
  press('Space', { key: ' ' });
  digit(2);
  press('KeyZ', { ctrl: true, key: 'z' });
  press('KeyZ', { ctrl: true, shift: true, key: 'z' });
}

describe('reading a keystroke', () => {
  function read(init: KeyboardEventInit): string | null {
    return readKeystrokeLabel(new KeyboardEvent('keydown', init));
  }

  test('names the keys the scoresheet binds and ignores the ones it does not', () => {
    expect(read({ code: 'Digit1', key: '1' })).toBe('1');
    expect(read({ code: 'Numpad8', key: '8' })).toBe('8');
    expect(read({ code: 'KeyC', key: 'c' })).toBe('C');
    expect(read({ code: 'KeyP', key: 'P' })).toBe('P');
    // A digit is a seat before it is anything else, which is the precedence the live listener has too.
    expect(read({ code: 'Digit3', key: '3' })).toBe('3');
    expect(read({ code: 'Digit0', key: '0' })).toBe('0');
    expect(read({ code: 'Space', key: ' ' })).toBe('Space');
    expect(read({ code: 'KeyZ', key: 'z', ctrlKey: true })).toBe('Ctrl/⌘ + Z');
    expect(read({ code: 'KeyZ', key: 'z', metaKey: true, shiftKey: true })).toBe('Ctrl/⌘ + Shift + Z');

    // Nothing the layout uses, so the drill leaves them to the browser rather than marking them wrong.
    expect(read({ code: 'Tab', key: 'Tab' })).toBeNull();
    expect(read({ code: 'KeyQ', key: 'q' })).toBeNull();
    expect(read({ code: 'Digit9', key: '9' })).toBeNull();
    expect(read({ code: 'Escape', key: 'Escape' })).toBeNull();
    expect(read({ code: 'KeyC', key: 'C', shiftKey: true })).toBeNull();
  });
});

describe('applying a keystroke', () => {
  /** Two keys arriving with no render between them, which is what a fast pair of presses looks like. */
  test('the second key is judged against what the first one left, not against a stale step', () => {
    const afterSeat = drillKeystroke(drillStart, '1');
    expect(afterSeat.index).toBe(1);

    // The second seat wants 4. Judged against step 1 instead, 4 would read as a wrong key.
    const afterSecond = drillKeystroke(afterSeat, '4');
    expect(afterSecond.index).toBe(2);
    expect(afterSecond.mistake).toBe('');
  });

  test('a wrong key clears a half-finished ruling and names both keys', () => {
    // Three seats, then Tucker's seat, leaving the ruling outstanding.
    let progress = ['1', '4', '7', '5'].reduce(drillKeystroke, drillStart);
    expect(progress.pressed).toBe(1);

    progress = drillKeystroke(progress, 'N');
    expect(progress.pressed).toBe(0);
    expect(progress.mistake).toContain('You pressed N');
    expect(progress.mistake).toContain('This step wants C');
    expect(progress.mistake).toContain('start again from 5');
  });

  test('the last key finishes rather than running off the end of the list', () => {
    const finished = drillTasks
      .flatMap((task) => task.keys)
      .reduce(drillKeystroke, drillStart);

    expect(finished.done).toBe(true);
    expect(finished.index).toBe(drillTasks.length - 1);
    // A keystroke after the end changes nothing rather than throwing.
    expect(drillKeystroke(finished, '1')).toEqual(finished);
  });
});

describe('the drill itself', () => {
  test('walks the layout the scoresheet actually binds', () => {
    expect(drillTasks.map((task) => task.keys)).toEqual([
      ['1'],
      ['4'],
      ['7'],
      ['5', 'C'],
      ['1', 'P'],
      ['2', 'N'],
      ['3', '0'],
      ['Space'],
      // Two bonus parts, which is the digit 2 rather than the third button on the row.
      ['2'],
      ['Ctrl/⌘ + Z'],
      ['Ctrl/⌘ + Shift + Z'],
    ]);
  });

  test('advances on the asked-for key and says who it addressed', () => {
    render(<KeyboardDrill onBack={vi.fn()} onHome={vi.fn()} />);

    expect(screen.getByText(`Step 1 of ${drillTasks.length} · Find the seat`)).toBeTruthy();
    expect(screen.getByText('Gibson is in Ninety Six’s first seat.')).toBeTruthy();

    digit(1);

    expect(screen.getByRole('status').textContent).toContain('1 is Gibson.');
    expect(screen.getByText(`Step 2 of ${drillTasks.length} · Find the seat`)).toBeTruthy();
  });

  test('a wrong key names what was pressed and clears a half-finished ruling', () => {
    render(<KeyboardDrill onBack={vi.fn()} onHome={vi.fn()} />);
    digit(1);
    digit(4);
    digit(7);

    // Tucker's ruling: seat 5, then C. The seat lands, then the wrong ruling key arrives.
    digit(5);
    expect(screen.getByText('— waiting for the ruling')).toBeTruthy();
    press('KeyP');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('You pressed P');
    expect(alert.textContent).toContain('This step wants C');
    // The seat is gone, exactly as the scoresheet drops it, so C on its own must not record anything.
    expect(screen.queryByText('— waiting for the ruling')).toBeNull();
    press('KeyC');
    expect(screen.getByRole('alert').textContent).toContain('You pressed C');
    expect(screen.getByText(`Step 4 of ${drillTasks.length} · Record the ruling`)).toBeTruthy();

    // Started again from the seat, the same two keys land the ruling.
    digit(5);
    press('KeyC');
    expect(screen.getByRole('status').textContent).toContain('Correct +10 for Tucker, Greenwood.');
  });

  test('a held key does not walk through the drill', () => {
    render(<KeyboardDrill onBack={vi.fn()} onHome={vi.fn()} />);

    press('Digit1', { key: '1', repeat: true });

    expect(screen.getByText(`Step 1 of ${drillTasks.length} · Find the seat`)).toBeTruthy();
  });

  test('finishing it leaves the same map the scoresheet shows, and it can be run again', () => {
    render(<KeyboardDrill onBack={vi.fn()} onHome={vi.fn()} />);

    pressWholeDrill();

    expect(screen.getByText('You have pressed every key the layout has.')).toBeTruthy();
    // The live legend, drawing the practice format's own labels — not a picture of one in this file.
    const map = screen.getByLabelText('Keyboard scoring');
    expect(within(map).getByText('seat → P')).toBeTruthy();
    expect(within(map).getByText('+10')).toBeTruthy();
    expect(within(map).getByText('wrong · 0')).toBeTruthy();
    expect(within(map).getByText('no buzz')).toBeTruthy();
    expect(within(map).getByText('undo')).toBeTruthy();

    fireEvent.click(screen.getByText('Run the drill again'));
    expect(screen.getByText(`Step 1 of ${drillTasks.length} · Find the seat`)).toBeTruthy();
  });

  test('skipping a step moves on without claiming the key was pressed', () => {
    render(<KeyboardDrill onBack={vi.fn()} onHome={vi.fn()} />);

    fireEvent.click(screen.getByText('Skip this step'));

    expect(screen.getByRole('status').textContent).toContain('Skipped.');
    expect(screen.getByRole('status').textContent).not.toContain('✓');
    expect(screen.getByText(`Step 2 of ${drillTasks.length} · Find the seat`)).toBeTruthy();
  });

  test('it offers the device preference rather than turning it on by itself', () => {
    render(<KeyboardDrill onBack={vi.fn()} onHome={vi.fn()} />);

    const offer = screen.getByText('Turn keyboard scoring on');
    expect(screen.getByText(/Keyboard scoring is switched off on this device/)).toBeTruthy();

    fireEvent.click(offer);

    expect(screen.queryByText('Turn keyboard scoring on')).toBeNull();
    expect(window.localStorage.getItem('qbsheet.scorer.keyboard.v1')).toBe('on');
  });
});

describe('the way in', () => {
  test('the practice summary offers the drill without competing with Practice again', () => {
    const onDrill = vi.fn();
    render(<PracticeSummary onRestart={vi.fn()} onHome={vi.fn()} onDrill={onDrill} />);

    const offer = screen.getByText('Learn keyboard scoring');
    // Optional means optional: the one blue button on this screen is still the practice game itself.
    expect(offer.className).not.toContain('is-primary');
    expect(screen.getByText('Practice again').className).toContain('is-primary');

    fireEvent.click(offer);
    expect(onDrill).toHaveBeenCalledOnce();
  });

  test('the offer belongs to a finished game, not to one in progress', async () => {
    render(<PracticeScreen onHome={vi.fn()} />);

    const prompt = screen.getByLabelText('Starting lineups');
    const left = within(prompt).getByLabelText('Ninety Six starters');
    const right = within(prompt).getByLabelText('Greenwood starters');
    for (const name of ['Gibson', 'Jeremy', 'Owen', 'Lachlan']) fireEvent.click(within(left).getByLabelText(name));
    for (const name of ['Tucker', 'Phillip', 'Efren', 'Valerie']) fireEvent.click(within(right).getByLabelText(name));
    fireEvent.click(within(prompt).getByText('Start game'));
    await vi.waitFor(() => expect(screen.getByText('Reader: “Power, Gibson on Ninety Six.”')).toBeTruthy());

    expect(screen.queryByText('Learn keyboard scoring')).toBeNull();
  });
});
