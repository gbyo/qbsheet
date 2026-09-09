/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { isRulingPickerOpen, keystrokeBelongsToControl } from './KeyboardScoring';
import RulingPicker from './RulingPicker';
import type { TossupChoice } from './tossupChoices';

const choices: TossupChoice[] = [
  {
    kind: 'answer',
    answerType: {
      index: 0,
      value: 15,
      label: 'Power',
      shortLabel: 'P',
      isPower: true,
      isNeg: false,
      awardsBonus: true,
      qbjId: 'AnswerType_Power',
    },
    label: '+15',
    name: 'Power',
  },
  {
    kind: 'answer',
    answerType: {
      index: 1,
      value: 10,
      label: 'Correct',
      shortLabel: 'C',
      isPower: false,
      isNeg: false,
      awardsBonus: true,
      qbjId: 'AnswerType_Correct',
    },
    label: '+10',
    name: '',
  },
  { kind: 'wrong', label: '0', name: '' },
];

function openPicker() {
  const onChoose = vi.fn();
  const onDismiss = vi.fn();
  // The picker measures against its anchor before first paint; without one it
  // stays hidden and exposes no accessible roles.
  const anchor = document.createElement('button');
  anchor.textContent = 'Sarah tile';
  document.body.appendChild(anchor);
  const rendered = render(
    <>
      <button type="button">Outside</button>
      <RulingPicker
        playerName="Sarah"
        teamName="Aiken"
        choices={choices}
        anchor={anchor}
        id="ruling-test"
        onChoose={onChoose}
        onDismiss={onDismiss}
      />
    </>,
  );
  return { ...rendered, onChoose, onDismiss };
}

function seatKey(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: '3', bubbles: true });
}

test('global shortcuts stay suppressed while the picker is open even after focus leaves it', () => {
  const { unmount } = openPicker();
  expect(isRulingPickerOpen()).toBe(true);

  screen.getByRole('button', { name: 'Outside' }).focus();
  expect(document.activeElement?.textContent).toBe('Outside');
  expect(keystrokeBelongsToControl(seatKey())).toBe(true);

  unmount();
  expect(isRulingPickerOpen()).toBe(false);
  // The whole tree (including the Outside button) unmounted; activeElement is
  // back on body with nothing to suppress the keystroke.
  expect(keystrokeBelongsToControl(seatKey())).toBe(false);
});

test('ordinary scorer buttons keep their shortcuts when no picker is open', () => {
  render(<button type="button">Outside</button>);
  screen.getByRole('button', { name: 'Outside' }).focus();
  expect(keystrokeBelongsToControl(seatKey())).toBe(false);
});

test('Tab cycles from the last choice back to the first', () => {
  openPicker();
  const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
  const first = buttons[0]!;
  const last = buttons[buttons.length - 1]!;

  last.focus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(document.activeElement).toBe(first);
});

test('Shift+Tab cycles from the first choice back to the last', () => {
  openPicker();
  const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
  const first = buttons[0]!;
  const last = buttons[buttons.length - 1]!;

  first.focus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
});

test('Escape dismisses without choosing and choosing still closes via callback', () => {
  const { onChoose, onDismiss } = openPicker();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onDismiss).toHaveBeenCalledWith(true);
  expect(onChoose).not.toHaveBeenCalled();

  const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
  fireEvent.click(buttons[0]!);
  expect(onChoose).toHaveBeenCalledWith(choices[0]);
});
