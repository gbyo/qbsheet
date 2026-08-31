/** @vitest-environment jsdom */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { LeftOrRight } from '../src/scoring/types';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import useScorerKeyboard from '../src/scorer/useScorerKeyboard';

const format = scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.AcfPowers));

/** Model the scorer's displayed seating and map its display-side callback back to canonical teams. */
function KeyboardLayoutHarness(props: { onBuzz: (team: LeftOrRight, playerName: string) => void }) {
  const [swapped, setSwapped] = useState(false);
  const displayedToCanonical: Record<LeftOrRight, LeftOrRight> = swapped
    ? { left: 'right', right: 'left' }
    : { left: 'left', right: 'right' };
  const seatedPlayers = swapped
    ? { left: ['Right player'], right: ['Left player'] }
    : { left: ['Left player'], right: ['Right player'] };

  useScorerKeyboard({
    keyboardEnabled: true,
    format,
    scoringEnabled: true,
    negsAvailable: () => true,
    eligible: () => true,
    seatedPlayers,
    dialogOpen: false,
    noBuzzAllowed: true,
    seatLayoutKey: swapped ? 'swapped' : 'default',
    onBuzz: (displaySide, playerName) => props.onBuzz(displayedToCanonical[displaySide], playerName),
    onWrongNoPenalty: () => undefined,
    onNoBuzz: () => undefined,
    onUndo: () => undefined,
    onRedo: () => undefined,
  });

  return (
    <button type="button" onClick={() => setSwapped(true)}>
      Swap layout
    </button>
  );
}

afterEach(cleanup);

test('a layout change clears an armed seat before an action uses the new canonical mapping', () => {
  const onBuzz = vi.fn();
  render(<KeyboardLayoutHarness onBuzz={onBuzz} />);

  fireEvent.keyDown(document, { code: 'Digit1', key: '1' });
  fireEvent.click(screen.getByRole('button', { name: 'Swap layout' }));
  fireEvent.keyDown(document, { code: 'KeyC', key: 'c' });

  expect(onBuzz).not.toHaveBeenCalled();

  fireEvent.keyDown(document, { code: 'Digit1', key: '1' });
  fireEvent.keyDown(document, { code: 'KeyC', key: 'c' });

  expect(onBuzz).toHaveBeenCalledTimes(1);
  expect(onBuzz.mock.calls[0]?.slice(0, 2)).toEqual(['right', 'Right player']);
});
