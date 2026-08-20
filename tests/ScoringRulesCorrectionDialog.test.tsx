/** @vitest-environment jsdom */

/**
 * The two-step correction dialog, and what it does when the write is refused.
 *
 * The refusal case is the one worth a file of its own. `correctFormat` decides whether a correction
 * is *applicable*; nothing it can check says whether this device will accept the write, and a
 * locked-down profile or a full quota can refuse both the journal and the record. A dialog that
 * closed anyway would leave a room believing its scores had been repriced when nothing had happened
 * — the failure mode the whole feature exists to avoid, arriving one layer up.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import ScoringRulesCorrectionDialog from '../src/scorer/ScoringRulesCorrectionDialog';
import { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules, typeIndex } from './rules';
import { event } from './events';

const rules = new ScoringRules(CommonRuleSets.AcfPowers);
rules.maximumPlayersPerTeam = 2;
const format = scoringRulesToScorekeeperFormat(rules);

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah Mitchell', 'James Robinson'] },
  right: { name: 'Greenwood', players: ['Emma Turner', 'Jordan Lee'] },
};

const events: ScoreEvent[] = [
  event({
    type: 'tossup-buzz',
    questionNumber: 1,
    team: 'left',
    playerName: 'Sarah Mitchell',
    answerTypeIndex: typeIndex(format, 15),
  }),
];

function open(onCorrect: (correction: unknown) => void | Promise<void>, onClose = vi.fn()) {
  render(
    <ScoringRulesCorrectionDialog
      format={format}
      events={events}
      setup={setup}
      onCorrect={onCorrect as never}
      onClose={onClose}
    />,
  );
  return onClose;
}

/** Change the power's value in the form, then cross to the confirmation step. */
async function proposeRepricedPower(value: string) {
  const points = screen
    .getAllByLabelText('Points')
    .find((input) => (input as HTMLInputElement).value === '15') as HTMLInputElement;
  fireEvent.input(points, { target: { value } });

  const review = await screen.findByRole('button', { name: /review changes/i });
  await waitFor(() => expect(review).not.toBeDisabled());
  fireEvent.click(review);
  return screen.findByRole('button', { name: /apply corrected rules/i });
}

describe('the confirmation step', () => {
  test('says what will change, and that it moves points already recorded', async () => {
    open(vi.fn());
    await proposeRepricedPower('20');

    expect(screen.getByText(/the scores will move/i)).toBeInTheDocument();
    expect(screen.getByText(/15 points → 20 points/)).toBeInTheDocument();
    expect(screen.getByText(/already recorded in this game/)).toBeInTheDocument();
  });

  test('applies the correction and closes', async () => {
    const onCorrect = vi.fn().mockResolvedValue(undefined);
    const onClose = open(onCorrect);
    const apply = await proposeRepricedPower('20');
    fireEvent.click(apply);

    await waitFor(() => expect(onCorrect).toHaveBeenCalledOnce());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('when the device refuses the write', () => {
  test('stays open, says nothing was written, and does not leave the button stuck', async () => {
    const onCorrect = vi.fn().mockRejectedValue(new Error('no room on this device'));
    const onClose = open(onCorrect);
    const apply = await proposeRepricedPower('20');
    fireEvent.click(apply);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be saved/i));
    expect(screen.getByText(/nothing has changed/i)).toBeInTheDocument();

    // The dialog is still here, and the button has come back so the retry is one press.
    expect(onClose).not.toHaveBeenCalled();
    const retry = screen.getByRole('button', { name: /apply corrected rules/i });
    expect(retry).not.toBeDisabled();
    expect(retry).not.toHaveTextContent(/applying/i);
  });

  test('a retry after a refusal can succeed', async () => {
    const onCorrect = vi
      .fn()
      .mockRejectedValueOnce(new Error('no room on this device'))
      .mockResolvedValueOnce(undefined);
    const onClose = open(onCorrect);
    const apply = await proposeRepricedPower('20');

    fireEvent.click(apply);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /apply corrected rules/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onCorrect).toHaveBeenCalledTimes(2);
  });
});

describe('the form step', () => {
  test('opens on the rules this game is actually being scored under', () => {
    open(vi.fn());
    // The advanced form, filled in from the live format rather than from defaults.
    expect(screen.getAllByLabelText('Points').map((input) => (input as HTMLInputElement).value)).toEqual(
      format.answerTypes.map((answerType) => String(answerType.value)),
    );
  });

  test('will not review a correction that corrects nothing', async () => {
    open(vi.fn());
    const review = await screen.findByRole('button', { name: /review changes/i });
    expect(review).toBeDisabled();
    expect(screen.getByText(/already being scored under/i)).toBeInTheDocument();
  });

  test('refuses a correction the recorded history contradicts, and says why', async () => {
    open(vi.fn());
    // Removing the power that question one was scored with.
    const remove = screen.getAllByRole('button', { name: /remove/i })[0];
    fireEvent.click(remove);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/cannot be removed/i));
    expect(screen.getByRole('button', { name: /review changes/i })).toBeDisabled();
  });
});
