/**
 * @vitest-environment jsdom
 *
 * A refused timeout must not close the dialog as if the timeout were running.
 *
 * The menu already hides the Timeout entry when the engine would refuse, so the only way to
 * reach a refusal here is a race — game state changing between the menu opening and the tap.
 * Closing on that tap would leave the scorekeeper believing a timeout is running while the
 * room clock keeps going, so the dialog stays open instead.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TimeoutDialog } from '../src/scorer/ProcedureDialogs';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';

afterEach(cleanup);

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah Mitchell', 'James Robinson'] },
  right: { name: 'Greenwood', players: ['Emma Turner', 'Jordan Lee'] },
};

function show(onRecord: (team: 'left' | 'right') => boolean) {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  const format = scoringRulesToScorekeeperFormat(rules);
  const onClose = vi.fn();
  render(
    <TimeoutDialog
      game={deriveGame(format, setup, [])}
      timeoutsPerTeam={1}
      onRecord={onRecord}
      onClose={onClose}
    />,
  );
  return { onClose };
}

describe('a refused timeout', () => {
  test('keeps the dialog open instead of closing as if the timeout were running', () => {
    const { onClose } = show(() => false);

    fireEvent.click(screen.getByRole('button', { name: 'Ninety Six' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Ninety Six' })).toBeInTheDocument();
  });

  test('closes the dialog once the timeout is recorded', () => {
    const onRecord = vi.fn(() => true);
    const { onClose } = show(onRecord);

    fireEvent.click(screen.getByRole('button', { name: 'Greenwood' }));

    expect(onRecord).toHaveBeenCalledWith('right');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
