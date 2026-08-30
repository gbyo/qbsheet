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
import { readQbjScoringRules } from '../src/qbj/QbjScoringRules';
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

  /*
   * A disabled button with nothing to read is the failure this covers.
   *
   * `scoringRulesInputFormat` returns null for any form the rules screens would refuse, and
   * `correctFormat` needs a format before it can have an opinion — so a scorekeeper who cleared one
   * field got an empty problem list, a greyed `Review changes`, and no way to find out which field.
   * The sentence below is the one `ScoringRulesSetup` was already showing for the same edit.
   */
  test('says which field is wrong rather than only disabling the button', async () => {
    open(vi.fn());
    fireEvent.input(screen.getByLabelText(/tossups in regulation/i), { target: { value: '' } });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/tossups in regulation must be at least 1/i),
    );
    expect(screen.getByRole('button', { name: /review changes/i })).toBeDisabled();
  });
});

/*
 * A round with no bonuses in it, scored from a tournament's own file.
 *
 * This is a whole describe because the format has to come through the reader rather than be built
 * here: the bug was that `advancedFromFormat` carried `awardsBonus` across from a format with
 * bonuses switched off, the trip back out wrote it as `awards_bonus: true`, and `bonusesAreUsed`
 * read that as bonuses being in play. The dialog then opened permanently unusable — six complaints
 * about bonus structure for bonuses nobody asked for, and because `advancedScorekeeperFormat`
 * returns null while any of them stand, not one of them reached the screen. A tossup-only room could
 * not correct its rules and was told nothing.
 */
describe('a tossup-only game whose rules arrived in a QBJ', () => {
  const read = readQbjScoringRules(
    {
      answer_types: [{ value: 10 }, { value: -5 }],
      regulation_tossup_count: 20,
      maximum_regulation_tossup_count: 20,
      minimum_overtime_question_count: 1,
      maximum_players_per_team: 4,
    },
    false,
  );

  function openTossupsOnly() {
    if (!read.ok) throw new Error('the fixture rules should be readable');
    render(
      <ScoringRulesCorrectionDialog
        format={read.format}
        events={[]}
        setup={setup}
        onCorrect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  }

  test('opens with no complaints on it', () => {
    openTossupsOnly();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/already being scored under/i)).toBeInTheDocument();
  });

  test('can actually correct something', async () => {
    openTossupsOnly();
    const tossupValue = screen
      .getAllByLabelText('Points')
      .find((input) => (input as HTMLInputElement).value === '10') as HTMLInputElement;
    fireEvent.input(tossupValue, { target: { value: '15' } });

    const review = await screen.findByRole('button', { name: /review changes/i });
    await waitFor(() => expect(review).not.toBeDisabled());
    fireEvent.click(review);
    expect(await screen.findByRole('button', { name: /apply corrected rules/i })).toBeInTheDocument();
  });
});
