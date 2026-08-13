/**
 * @vitest-environment jsdom
 */

/**
 * Correcting one question, from the Recent activity rail.
 *
 * The correction engine is not what is under test — `RoomQuestionCorrection.test.ts` covers the
 * atomic replace and the revalidation. What is under test is that the screen over it asks the three
 * questions a scorekeeper is actually answering (which team, which player, what was the ruling) and
 * that every option in it comes from the configured format rather than from a rule set somebody
 * assumed. A correction dialog with a hard-coded +10 is a correction dialog that silently rescores
 * a 7-point tournament.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import AnswerType from './AnswerType';
import ScorerHost from '../src/scorer/ScorerHost';
import { RoomConnectionState } from '../src/app/ConnectionState';

const leftTeam = { name: 'Ninety Six', players: [{ name: 'Sarah Mitchell' }, { name: 'James Robinson' }] };
const rightTeam = { name: 'Greenwood', players: [{ name: 'Emma Turner' }, { name: 'Jordan Lee' }] };

function formatFor(mutate: (rules: ScoringRules) => void = () => {}): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  mutate(rules);
  return scoringRulesToScorekeeperFormat(rules);
}

let gameCounter = 0;

function renderScorer(format: IScorekeeperFormat) {
  gameCounter += 1;
  render(
    <ScorerHost
      gameKey={`question-editor-${gameCounter}`}
      format={format}
      leftTeam={leftTeam}
      rightTeam={rightTeam}
      tournamentName="Ninety Six Invitational"
      roundName="Round 4"
      connection={RoomConnectionState.Connected}
      onDownload={() => undefined}
      onSubmit={vi.fn().mockResolvedValue({ ok: true, message: 'Sent' })}
    />,
  );
}

function buttonsFor(player: string) {
  return screen.getAllByRole('button').filter((button) => button.getAttribute('aria-label')?.startsWith(player));
}

function scoreOf(team: string): string {
  return screen.getByLabelText(`${team} score`).textContent ?? '';
}

/** Open the editor the long way: the Game menu, the review list, then one question. */
function openEditor() {
  fireEvent.click(screen.getByText('Game'));
  fireEvent.click(screen.getByText('Full scoresheet review'));
  fireEvent.click(screen.getByText('Edit question'));
}

/** Open the editor the way a scorekeeper does: one press on the question in Recent. */
function openEditorFromRecent(questionNumber: number) {
  fireEvent.click(screen.getByRole('button', { name: `Review question ${questionNumber}` }));
}

function rulingSelect() {
  return screen.getByLabelText('Ruling') as HTMLSelectElement;
}

function chooseRuling(label: string) {
  const select = rulingSelect();
  const option = Array.from(select.options).find((candidate) => candidate.textContent === label);
  if (!option) throw new Error(`No ruling option named "${label}"`);
  fireEvent.change(select, { target: { value: option.value } });
}

/** The correction form itself. A bonus prompt on its way off the scoresheet behind the dialog
 * carries controls with the same names, and this suite is about the dialog. */
function editor(): HTMLElement {
  return document.querySelector('.scorer-question-editor') as HTMLElement;
}

function bounceFormat(): IScorekeeperFormat {
  return formatFor((rules) => {
    rules.bonusesBounceBack = true;
  });
}

/** Q1 to Ninety Six, its bonus recorded as totals — the shape that has no part history. */
function recordBonusTotals(controlled: number, bounceback?: number) {
  fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
  fireEvent.click(within(screen.getByLabelText('Bonus')).getByText(String(controlled)));
  if (bounceback !== undefined) {
    fireEvent.click(within(screen.getByLabelText('Bounceback')).getByText(String(bounceback)));
  }
}

/** Q1 to Ninety Six, its bonus recorded part by part on the live prompt. */
function recordBonusParts(outcomes: string[]) {
  fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
  fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('Parts…'));
  outcomes.forEach((outcome, index) => {
    const row = screen.getByText(`Part ${index + 1}`).closest('.scorer-part-row') as HTMLElement;
    const name =
      outcome === '+10'
        ? new RegExp(`^Part ${index + 1}, .*\\+10$`)
        : outcome === 'Bounce'
          ? new RegExp(`^Part ${index + 1}, .*bounceback$`)
          : new RegExp(`^Part ${index + 1}, .*missed by both teams$`);
    fireEvent.click(within(row).getByRole('button', { name }));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record parts' }));
}

function partOutcomes(partNumber: number): HTMLElement {
  return within(editor()).getByRole('group', { name: `Bonus part ${partNumber} outcome` });
}

function outcomeButton(partNumber: number, name: string): HTMLElement {
  return within(partOutcomes(partNumber)).getByRole('button', { name });
}

/** Which outcome each part is showing as chosen, and `none` for one nobody has answered. */
function chosenOutcomes(partCount: number): string[] {
  return Array.from({ length: partCount }, (_unused, index) => {
    const pressed = within(partOutcomes(index + 1))
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-pressed') === 'true');
    return pressed?.getAttribute('aria-label') ?? 'none';
  });
}

function installLocalStorage() {
  let store: Record<string, string> = {};
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    },
  });
}

function installDialogMethods() {
  if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== 'function') {
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
  }
}

beforeEach(() => {
  installLocalStorage();
  installDialogMethods();
});

afterEach(() => {
  cleanup();
});

describe('what the editor leads with', () => {
  test('the question, and what it did to the score', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[0]); // +15
    openEditor();

    expect(screen.getByRole('heading', { name: 'Edit Question 1' })).toBeTruthy();
    expect(screen.getByText('Score impact')).toBeTruthy();
    const score = screen.getByRole('table', { name: 'Question 1 score impact' });
    chooseRuling('Neg (-5)');
    expect(within(score).getByRole('row', { name: /Ninety Six: \+15 -5 20-point change/ })).toBeTruthy();
  });

  test('the lineup and the technical explanation wait behind Correction details', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    openEditor();

    expect(screen.queryByText(/On the floor/)).toBeNull();
    fireEvent.click(screen.getByText('Correction details'));
    expect(screen.getByText(/On the floor/)).toBeTruthy();
  });

  test('the score after previews the correction before it is saved', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
    fireEvent.click(screen.getByText('20'));
    openEditor();

    const score = screen.getByRole('table', { name: 'Question 1 score impact' });
    expect(within(score).getByRole('row', { name: /Ninety Six: unchanged at \+30/ })).toBeTruthy();

    chooseRuling('Power (+15)');

    expect(within(score).getByRole('row', { name: /Ninety Six: \+30 \+35 5-point change/ })).toBeTruthy();
  });

  test('a completed tossup does not offer an impossible second attempt', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    openEditor();

    expect(screen.queryByText('+ Add attempt')).toBeNull();

    chooseRuling('Neg (-5)');

    expect(within(screen.getByRole('region', { name: 'Tossup attempts' })).getByRole('button', { name: '+ Add attempt' })).toBeTruthy();
  });

  /**
   * The three things the one checkbox used to mean.
   *
   * It was labelled `No buzz` with nothing on the question and `End question without a bonus` with
   * an attempt on it, and in the second case ticking it deleted the correct answer and killed the
   * tossup — an operation several times larger than its label. They are separated now: the control
   * says what the tossup came to, the ruling control is the only way to remove a correct answer, and
   * whether a bonus applies is derived and stated rather than chosen.
   */
  test('the tossup outcome is never a way to delete a correct answer', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    openEditor();

    const outcome = () => screen.getByLabelText('No team converted') as HTMLInputElement;
    expect(outcome().disabled).toBe(true);
    expect(screen.getByText(/Ninety Six converted this tossup/)).toBeTruthy();

    // Taking the conversion away is the ruling control's job, one row up, where the ruling is.
    chooseRuling('Neg (-5)');

    expect(outcome().disabled).toBe(false);
    fireEvent.click(outcome());
    expect(outcome().checked).toBe(true);
    // The attempt is still there: this said nobody converted, not that nobody buzzed.
    expect(screen.getByLabelText('Ruling')).toBeTruthy();
  });

  test('an empty question calls its outcome No buzz', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByRole('button', { name: 'No buzz' }));
    openEditor();

    expect((screen.getByLabelText('No buzz') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('No team converted')).toBeNull();
  });

  test('a zero-point answer remains editable when the other team never converts', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByLabelText('Sarah Mitchell 0 after readout wrong, no penalty'));
    fireEvent.click(screen.getByText('No buzz'));
    openEditor();

    expect(screen.getByLabelText('Ruling')).toBeTruthy();
    const outcome = screen.getByLabelText('No team converted') as HTMLInputElement;
    expect(outcome.checked).toBe(true);
    expect(outcome.disabled).toBe(false);
  });
});

/**
 * Getting out again.
 *
 * A correction dialog somebody cannot leave is a correction dialog they will save something wrong
 * from rather than abandon. Every exit is checked, and each one has to land where the scorekeeper
 * came from: Recent goes back to the scoresheet, the review list goes back to the review list.
 */
describe('leaving the editor', () => {
  test('Recent opens one question, and leaving it returns to the scoresheet', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    openEditorFromRecent(1);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Question 1')).toBeNull();
    // Not the review list, which is somewhere this scorekeeper never asked to be.
    expect(screen.queryByText('Full scoresheet review')).toBeNull();
    expect(screen.getByLabelText('Ninety Six score')).toBeTruthy();
  });

  test('the review list opens one question, and leaving it returns to the list', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    openEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('Full scoresheet review')).toBeTruthy();
    expect(screen.getByText('Edit question')).toBeTruthy();
  });

  test('the dialog head keeps a close icon whatever the editor was opened from', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    openEditorFromRecent(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    expect(screen.queryByText('Question 1')).toBeNull();
    expect(screen.getByLabelText('Ninety Six score')).toBeTruthy();
  });

  test('Escape is one of the ways out', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    openEditorFromRecent(1);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByText('Question 1')).toBeNull();
    expect(screen.getByLabelText('Ninety Six score')).toBeTruthy();
  });

  test('leaving without saving changes nothing', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
    fireEvent.click(screen.getByText('20'));
    expect(scoreOf('Ninety Six')).toBe('30');
    openEditorFromRecent(1);

    chooseRuling('Power (+15)');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(scoreOf('Ninety Six')).toBe('30');
  });
});

describe('the first time somebody opens a correction', () => {
  test('the screen explains itself, once, and then stops', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    openEditorFromRecent(1);

    expect(screen.getByLabelText('About editing this question')).toBeTruthy();
    // The three things nothing else on screen says: what the scope is, that saving is the commit, and
    // how to get out.
    expect(screen.getByText(/every buzz on it and its bonus/)).toBeTruthy();
    expect(screen.getByText(/Nothing changes until you choose Save changes/)).toBeTruthy();
    expect(screen.getByText(/To leave it exactly as it is/)).toBeTruthy();

    fireEvent.click(screen.getByText('Got it — don’t show this again'));
    expect(screen.queryByLabelText('About editing this question')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    openEditorFromRecent(1);
    expect(screen.queryByLabelText('About editing this question')).toBeNull();
  });
});

describe('the ruling is one dropdown', () => {
  test('it offers exactly the format’s answer values plus the wrong answer that costs nothing', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
    openEditor();

    expect(Array.from(rulingSelect().options, (option) => option.textContent)).toEqual([
      'Power (+15)',
      'Correct (+10)',
      'Neg (-5)',
      'Wrong, no penalty (0)',
    ]);
  });

  test('a custom rule set produces custom rulings, with nothing assumed', () => {
    renderScorer(
      formatFor((rules) => {
        rules.answerTypes = [new AnswerType(7), new AnswerType(-3)];
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[0]); // +7
    openEditor();

    expect(Array.from(rulingSelect().options, (option) => option.textContent)).toEqual([
      'Correct (+7)',
      'Neg (-3)',
      'Wrong, no penalty (0)',
    ]);
  });

  /**
   * A tournament's own zero-point answer type, and the wrong answer that costs nothing.
   *
   * Custom rules may define a real 0 answer type, and an unlabelled one used to come out as
   * `Wrong (0)` — the same words as the synthetic no-penalty ruling this list adds itself. Two
   * options reading identically and behaving differently is worse than either name being imperfect:
   * one records a buzz of that answer type, the other records `tossup-no-penalty`.
   */
  test('a tournament’s own zero answer never reads as the no-penalty ruling', () => {
    renderScorer(
      formatFor((rules) => {
        rules.answerTypes = [new AnswerType(10), new AnswerType(0), new AnswerType(-5)];
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[0]); // +10
    openEditor();

    const labels = Array.from(rulingSelect().options, (option) => option.textContent);
    expect(labels).toEqual(['Correct (+10)', 'No points (0)', 'Neg (-5)', 'Wrong, no penalty (0)']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  /**
   * A new attempt has no ruling until somebody chooses one.
   *
   * `format.answerTypes` is ordered highest-value first, so taking the first positive one made an
   * added attempt open as Power (+15) under 15/10/−5 rules, and as the top tier of a three-tier
   * custom format. A ruling is the one thing on the row that cannot be inferred from anything else.
   */
  test('an added attempt starts with no ruling rather than the most valuable one', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // a neg, so a second attempt is possible
    openEditor();

    fireEvent.click(screen.getByRole('button', { name: '+ Add attempt' }));

    const second = screen.getByLabelText('Question 1 attempt 2 ruling') as HTMLSelectElement;
    expect(second.value).toBe('');
    expect(second.options[0].textContent).toBe('Choose ruling…');
    // Nothing is proposed, so nothing can be saved by accident.
    fireEvent.click(screen.getByText('Save changes'));

    expect(screen.getByText('Choose a valid ruling for Question 1.')).toBeTruthy();
  });

  test('choosing a different value rescores the question and everything after it', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
    fireEvent.click(screen.getByText('20'));
    expect(scoreOf('Ninety Six')).toBe('30');

    openEditor();
    chooseRuling('Power (+15)');
    fireEvent.click(screen.getByText('Save changes'));

    expect(scoreOf('Ninety Six')).toBe('35');
  });

  test('the same control turns a buzz into a wrong answer worth nothing', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // -5
    openEditor();

    chooseRuling('Wrong, no penalty (0)');
    fireEvent.click(screen.getByText('Save changes'));

    // The neg is gone, and nothing replaced it in the score.
    expect(scoreOf('Ninety Six')).toBe('0');
  });
});

describe('two attempts', () => {
  test('a neg then a conversion is edited as two numbered lines with one order control', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // -5 for Ninety Six
    fireEvent.click(buttonsFor('Emma Turner')[1]); // +10 for Greenwood
    fireEvent.click(screen.getByText('30'));
    expect(scoreOf('Ninety Six')).toBe('-5');
    expect(scoreOf('Greenwood')).toBe('40');

    openEditor();
    expect(screen.getByLabelText('Question 1 attempt 1 ruling')).toBeTruthy();
    expect(screen.getByLabelText('Question 1 attempt 2 ruling')).toBeTruthy();
    // One control for order, rather than an Up and a Down on every row of a two-row list.
    expect(screen.getByText('Swap order')).toBeTruthy();
    expect(screen.queryByText('Up')).toBeNull();
    expect(screen.queryByText('Down')).toBeNull();
  });
});

/**
 * A bonus is offered exactly when the rules award one.
 *
 * `expectsBonus` is the engine's `bonusFollows` asked of an edit in progress, which is the same rule
 * `validateEditableQuestion` applies at Save. Add bonus used to appear whenever the format used
 * bonuses at all, so the dialog could invite an action its own validator would then refuse: a
 * conversion on an answer type with `awardsBonus: false`, or an overtime tossup under rules whose
 * overtime excludes bonuses.
 */
describe('the bonus', () => {
  test('a question with no conversion is not offered a bonus at all', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // a neg: no conversion, no bonus
    openEditor();

    expect(screen.queryByRole('group', { name: 'Bonus points' })).toBeNull();
    expect(screen.queryByText('Add bonus')).toBeNull();
    expect(screen.getByText(/No team converted this one/)).toBeTruthy();
  });

  test('an answer type that awards no bonus is not offered one either', () => {
    // `awards_bonus` is a QBJ field the validator has always enforced. A format can have a positive
    // answer type that earns nothing after it, and this dialog used to offer a bonus for it anyway.
    const format = formatFor();
    const correct = format.answerTypes.find((answerType) => answerType.value === 10)!;
    format.answerTypes[correct.index] = { ...correct, awardsBonus: false };
    renderScorer(format);
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10, which now earns nothing

    openEditor();

    expect(screen.queryByText('Add bonus')).toBeNull();
    expect(screen.getByText(/Correct \(\+10\) does not earn a bonus/)).toBeTruthy();
  });

  test('a conversion missing its bonus is offered one', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    openEditor();

    fireEvent.click(screen.getByText('Remove bonus'));

    expect(screen.getByText('Add bonus')).toBeTruthy();
  });

  /**
   * Dependent state follows the edit rather than waiting for Save to complain.
   *
   * The bonus belongs to whoever converted, and the controlling-team selector is not shown while a
   * conversion exists — so changing the converting team used to leave the bonus owned by a team that
   * no longer converted anything, discovered only when Save refused the whole correction.
   */
  test('changing the converting team moves the bonus with it', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // Ninety Six converts
    fireEvent.click(screen.getByText('20'));
    openEditor();
    expect(screen.getByText('Controlled by Ninety Six')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Question 1 attempt 1 team'), { target: { value: 'right' } });

    expect(screen.getByText('Controlled by Greenwood')).toBeTruthy();
    fireEvent.click(screen.getByText('Save changes'));

    expect(scoreOf('Ninety Six')).toBe('0');
    expect(scoreOf('Greenwood')).toBe('30');
  });

  test('a ruling that stops earning a bonus takes the bonus with it, and says so', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    openEditor();

    chooseRuling('Neg (-5)');

    expect(screen.queryByRole('group', { name: 'Bonus points' })).toBeNull();
    expect(screen.getByText(/The bonus recorded here will be removed when you save/)).toBeTruthy();
    fireEvent.click(screen.getByText('Save changes'));

    expect(scoreOf('Ninety Six')).toBe('-5');
  });

  test('the quick totals are generated from the configured bonus structure', () => {
    renderScorer(
      formatFor((rules) => {
        rules.maximumBonusScore = 20;
        rules.pointsPerBonusPart = 5;
        rules.bonusDivisor = 5;
        rules.minimumPartsPerBonus = 4;
        rules.maximumPartsPerBonus = 4;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('10'));
    openEditor();

    const totals = within(screen.getByRole('group', { name: 'Bonus points' })).getAllByRole('button');
    expect(totals.map((button) => button.textContent)).toEqual(['0', '5', '10', '15', '20']);
  });

  test('bouncebacks appear only when the format has them, and name both teams', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    openEditor();
    // Nothing bounces, so there is one side to enter and no reason to name it in every control.
    expect(within(editor()).getByRole('group', { name: 'Bonus points' })).toBeTruthy();
    expect(within(editor()).queryByRole('group', { name: /bounceback/i })).toBeNull();
    cleanup();

    renderScorer(bounceFormat());
    recordBonusTotals(20, 10);
    openEditor();

    // Two sides, each named, rather than "Points" and "Bounceback" saying nothing about who scores.
    const bonus = within(editor()).getByRole('group', { name: 'Ninety Six bonus' });
    expect(within(bonus).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '0',
      '10',
      '20',
      '30',
    ]);
    expect(within(bonus).getByRole('button', { name: '20' })).toHaveAttribute('aria-pressed', 'true');
    // The opponent is offered only what the controlling team left on the bonus.
    const bounceback = within(editor()).getByRole('group', { name: 'Greenwood bounceback' });
    expect(within(bounceback).getAllByRole('button').map((button) => button.textContent)).toEqual(['0', '10']);
    expect(within(bounceback).getByRole('button', { name: '10' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('an irregular bonus asks for a number, because its parts are not enumerable', () => {
    renderScorer(
      formatFor((rules) => {
        rules.minimumPartsPerBonus = 1;
        rules.maximumPartsPerBonus = 5;
        rules.pointsPerBonusPart = 0;
        rules.bonusDivisor = 5;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.change(screen.getByLabelText(/Bonus points/), { target: { value: '25' } });
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('Record'));
    openEditor();

    expect(screen.queryByRole('group', { name: 'Bonus points' })).toBeNull();
    expect(within(editor()).getByLabelText('Bonus points')).toBeTruthy();
    // Nothing here knows what one part of an irregular bonus is worth, so no part outcomes are offered.
    expect(screen.queryByText('Edit individual parts\u2026')).toBeNull();
  });

  /**
   * Parts, asked the way the live prompt asks them.
   *
   * `Edit individual parts…` used to turn each part into one number box for the controlling team and, under
   * bouncebacks, a second one for the opponent — so the screen read `Part 1 [0] [10]` with the teams
   * named only in the accessible labels. A regular part has three outcomes and no other value it may
   * take, so the three buttons are both clearer and narrower than the pair of boxes they replace.
   */
  test('bonus parts ask who took each one, with the teams named on screen', () => {
    renderScorer(
      formatFor((rules) => {
        rules.bonusesBounceBack = true;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10 for Ninety Six
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));
    fireEvent.click(within(screen.getByLabelText('Bounceback')).getByText('10'));
    openEditor();

    fireEvent.click(screen.getByText('Edit individual parts…'));

    const parts = screen.getByText('Part 1').closest('.scorer-question-parts') as HTMLElement;
    const head = parts.querySelector('.scorer-question-part-head') as HTMLElement;
    expect(within(head).getByText('Ninety Six')).toBeTruthy();
    expect(within(head).getByText('Greenwood bounceback')).toBeTruthy();
    expect(screen.queryByLabelText('Bonus part 1 controlled points')).toBeNull();

    fireEvent.click(screen.getByLabelText('Bonus part 1 to Ninety Six'));
    fireEvent.click(screen.getByLabelText('Bonus part 2 bounced back to Greenwood'));
    fireEvent.click(screen.getByLabelText('Bonus part 3 missed'));
    fireEvent.click(screen.getByText('Save changes'));

    expect(scoreOf('Ninety Six')).toBe('20');
    expect(scoreOf('Greenwood')).toBe('10');
  });

  /**
   * Opening the parts view is a way of looking at the bonus, not a way of clearing it — and not a
   * way of deciding something the bonus never recorded.
   *
   * It used to fill the parts with zeros, so pressing it on a recorded 20 rewrote the bonus to 0 —
   * and now that a part shows a chosen outcome rather than an empty box, that also asserted
   * something false on screen: three Misses on a bonus that scored 20. Seeding the outcomes from the
   * total instead would fix the figures and keep the false assertion: a 20 does not say which two
   * parts made it. So the parts open unanswered, over the total that is still recorded.
   */
  test('opening the parts view keeps the bonus that was recorded', () => {
    renderScorer(
      formatFor((rules) => {
        rules.bonusesBounceBack = true;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));
    fireEvent.click(within(screen.getByLabelText('Bounceback')).getByText('10'));
    openEditor();
    const score = screen.getByRole('table', { name: 'Question 1 score impact' });

    fireEvent.click(screen.getByText('Edit individual parts…'));

    // Nothing pressed: which parts made the 20 is exactly what the total does not record.
    expect(chosenOutcomes(3)).toEqual(['none', 'none', 'none']);
    // And nothing lost: the bonus is still the one that was recorded.
    expect(within(editor()).getByText('Ninety Six +20 · Greenwood +10 bounceback')).toBeTruthy();
    expect(within(score).getByRole('row', { name: /Ninety Six: unchanged at \+30/ })).toBeTruthy();
    expect(within(score).getByRole('row', { name: /Greenwood: unchanged at \+10/ })).toBeTruthy();

    // Answering them keeps the same figures, now with the parts the scorekeeper actually named.
    fireEvent.click(screen.getByLabelText('Bonus part 1 to Ninety Six'));
    fireEvent.click(screen.getByLabelText('Bonus part 2 to Ninety Six'));
    fireEvent.click(screen.getByLabelText('Bonus part 3 bounced back to Greenwood'));
    fireEvent.click(screen.getByText('Save changes'));

    expect(scoreOf('Ninety Six')).toBe('30');
    expect(scoreOf('Greenwood')).toBe('10');
  });

  test('a format without bouncebacks asks only who took the part or nobody', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    openEditor();

    fireEvent.click(screen.getByText('Edit individual parts…'));

    expect(screen.getByLabelText('Bonus part 1 to Ninety Six')).toBeTruthy();
    expect(screen.queryByLabelText('Bonus part 1 bounced back to Greenwood')).toBeNull();
    expect(screen.getByLabelText('Bonus part 1 missed')).toBeTruthy();
  });

  test('a correction that creates a conversion can add the bonus it earns', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // -5
    fireEvent.click(buttonsFor('Emma Turner')[1]); // Greenwood converts
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('0'));

    openEditor();

    // The bonus control is present and attributed to the team that converted.
    expect(screen.getByRole('group', { name: 'Bonus points' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Bonus' })).toBeTruthy();
    expect(screen.getByText('Controlled by Greenwood')).toBeTruthy();
  });
});

/**
 * The bonus, asked the way the live prompt asks it.
 *
 * The correction editor used to expose the storage: two unlabelled number boxes per part, the first
 * of them the controlling team's points and the second the bounceback's, with nothing on screen
 * saying so. A scorekeeper cannot answer that question. They can answer "who got part 2?", which is
 * what `BonusPrompt` has always asked, so that is what this asks too — in the same three outcomes,
 * from the same format-derived helpers, with the same meaning.
 */
describe('who got each bonus part', () => {
  test('a bounceback bonus opens as outcomes, not as pairs of numbers', () => {
    renderScorer(bounceFormat());
    recordBonusParts(['+10', 'Bounce', 'Miss']);
    openEditorFromRecent(1);

    // Both teams are identified: the one that converted, and the one that can take the rest.
    expect(screen.getByRole('heading', { name: 'Bonus' })).toBeTruthy();
    expect(screen.getByText('Controlled by Ninety Six')).toBeTruthy();
    const head = editor().querySelector('.scorer-question-part-head') as HTMLElement;
    expect(Array.from(head.querySelectorAll('span'), (span) => span.textContent).filter(Boolean)).toEqual([
      'Ninety Six',
      'Greenwood bounceback',
    ]);

    // One control per outcome, each saying whose points it is and what it is worth.
    expect(within(partOutcomes(2)).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Bonus part 2 to Ninety Six',
      'Bonus part 2 bounced back to Greenwood',
      'Bonus part 2 missed',
    ]);

    // Nothing left of the storage: no unexplained number pairs, and no dead "Points" box.
    expect(within(editor()).queryAllByRole('spinbutton')).toHaveLength(0);
    expect(within(editor()).queryByLabelText('Points')).toBeNull();
    expect(within(editor()).queryByLabelText('Bonus part 1 controlled points')).toBeNull();
  });

  test('the recorded outcomes are the ones showing, in the parts they were recorded on', () => {
    renderScorer(bounceFormat());
    recordBonusParts(['+10', 'Bounce', 'Miss']);
    openEditorFromRecent(1);

    expect(chosenOutcomes(3)).toEqual([
      'Bonus part 1 to Ninety Six',
      'Bonus part 2 bounced back to Greenwood',
      'Bonus part 3 missed',
    ]);
    expect(within(editor()).getByText('Ninety Six +10 · Greenwood +10 bounceback')).toBeTruthy();
  });

  test('changing a part moves the whole part, so no part can pay both teams', () => {
    renderScorer(bounceFormat());
    recordBonusParts(['+10', 'Bounce', 'Miss']);
    openEditorFromRecent(1);

    fireEvent.click(outcomeButton(1, 'Bonus part 1 bounced back to Greenwood'));
    expect(outcomeButton(1, 'Bonus part 1 to Ninety Six')).toHaveAttribute('aria-pressed', 'false');
    expect(outcomeButton(1, 'Bonus part 1 bounced back to Greenwood')).toHaveAttribute('aria-pressed', 'true');
    expect(outcomeButton(1, 'Bonus part 1 missed')).toHaveAttribute('aria-pressed', 'false');
    expect(within(editor()).getByText('Ninety Six 0 · Greenwood +20 bounceback')).toBeTruthy();

    fireEvent.click(outcomeButton(2, 'Bonus part 2 missed'));
    expect(chosenOutcomes(3)).toEqual(['Bonus part 1 bounced back to Greenwood', 'Bonus part 2 missed', 'Bonus part 3 missed']);
    expect(within(editor()).getByText('Ninety Six 0 · Greenwood +10 bounceback')).toBeTruthy();
  });

  test('a bonus nobody scored says so rather than showing a row of zeroes', () => {
    renderScorer(bounceFormat());
    recordBonusParts(['+10', 'Bounce', 'Miss']);
    openEditorFromRecent(1);

    fireEvent.click(outcomeButton(1, 'Bonus part 1 missed'));
    fireEvent.click(outcomeButton(2, 'Bonus part 2 missed'));

    expect(within(editor()).getByText('Nobody scored this bonus.')).toBeTruthy();
  });

  test('the totals, the score preview and the saved game all follow the parts', () => {
    renderScorer(bounceFormat());
    recordBonusParts(['+10', 'Bounce', 'Miss']);
    expect(scoreOf('Ninety Six')).toBe('20');
    expect(scoreOf('Greenwood')).toBe('10');
    openEditorFromRecent(1);

    fireEvent.click(outcomeButton(3, 'Bonus part 3 to Ninety Six'));

    expect(within(editor()).getByText('Ninety Six +20 · Greenwood +10 bounceback')).toBeTruthy();
    const score = screen.getByRole('table', { name: 'Question 1 score impact' });
    expect(within(score).getByRole('row', { name: /Ninety Six: \+20 \+30 10-point change/ })).toBeTruthy();
    expect(within(score).getByRole('row', { name: /Greenwood: unchanged at \+10/ })).toBeTruthy();

    fireEvent.click(screen.getByText('Save changes'));

    expect(scoreOf('Ninety Six')).toBe('30');
    expect(scoreOf('Greenwood')).toBe('10');
  });

  test('a regular bonus without bouncebacks asks the two questions it has', () => {
    renderScorer(formatFor());
    recordBonusTotals(20);
    openEditorFromRecent(1);
    fireEvent.click(screen.getByText('Edit individual parts…'));

    expect(within(partOutcomes(1)).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Bonus part 1 to Ninety Six',
      'Bonus part 1 missed',
    ]);
    expect(editor().querySelector('.scorer-question-part-head')?.textContent).toBe('Ninety Six');

    fireEvent.click(outcomeButton(1, 'Bonus part 1 to Ninety Six'));
    fireEvent.click(outcomeButton(2, 'Bonus part 2 to Ninety Six'));
    fireEvent.click(outcomeButton(3, 'Bonus part 3 missed'));

    expect(within(editor()).getByText('Ninety Six +20')).toBeTruthy();
    fireEvent.click(screen.getByText('Save changes'));
    expect(scoreOf('Ninety Six')).toBe('30');
  });

  test('what a part is worth and how many there are come from the format', () => {
    renderScorer(
      formatFor((rules) => {
        rules.bonusesBounceBack = true;
        rules.maximumBonusScore = 20;
        rules.pointsPerBonusPart = 5;
        rules.bonusDivisor = 5;
        rules.minimumPartsPerBonus = 4;
        rules.maximumPartsPerBonus = 4;
      }),
    );
    recordBonusTotals(10, 5);
    openEditorFromRecent(1);
    fireEvent.click(screen.getByText('Edit individual parts…'));

    expect(within(editor()).getAllByRole('group', { name: /^Bonus part \d+ outcome$/ })).toHaveLength(4);
    expect(outcomeButton(4, 'Bonus part 4 to Ninety Six')).toBeTruthy();
    expect(outcomeButton(4, 'Bonus part 4 bounced back to Greenwood')).toBeTruthy();
    // No outcome is worth ten points here, however familiar a ten-point part is elsewhere.
    const parts = editor().querySelector('.scorer-question-parts') as HTMLElement;
    const awards = within(parts)
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .filter((face) => face.includes('+'));
    expect(awards).toHaveLength(8);
    expect(awards.every((face) => face.endsWith('+5'))).toBe(true);

    fireEvent.click(outcomeButton(1, 'Bonus part 1 to Ninety Six'));
    fireEvent.click(outcomeButton(2, 'Bonus part 2 to Ninety Six'));
    fireEvent.click(outcomeButton(3, 'Bonus part 3 bounced back to Greenwood'));
    fireEvent.click(outcomeButton(4, 'Bonus part 4 missed'));

    expect(within(editor()).getByText('Ninety Six +10 · Greenwood +5 bounceback')).toBeTruthy();
  });
});

/**
 * The one thing this screen must never do quietly.
 *
 * A bonus recorded as a total of 20 does not say which two parts made it. Opening part entry used
 * to answer that question by writing three zero parts, which replaced a 20-point bonus with a
 * 0-point one and told nobody. Neither half of the fix is optional: it may not reset the bonus, and
 * it may not guess a part history either.
 */
describe('turning a recorded total into parts', () => {
  test('the recorded total stands until every part has been answered', () => {
    renderScorer(bounceFormat());
    recordBonusTotals(20, 10);
    expect(scoreOf('Ninety Six')).toBe('30');
    expect(scoreOf('Greenwood')).toBe('10');
    openEditorFromRecent(1);

    fireEvent.click(screen.getByText('Edit individual parts…'));

    // Nothing invented: no part claims to know what happened to it.
    expect(chosenOutcomes(3)).toEqual(['none', 'none', 'none']);
    // And nothing lost: the bonus is still the one that was recorded.
    expect(within(editor()).getByText('Ninety Six +20 · Greenwood +10 bounceback')).toBeTruthy();
    expect(within(editor()).getByText(/Still to answer: part 1, part 2 and part 3/)).toBeTruthy();
    const score = screen.getByRole('table', { name: 'Question 1 score impact' });
    expect(within(score).getByRole('row', { name: /Ninety Six: unchanged at \+30/ })).toBeTruthy();
  });

  test('an unfinished breakdown cannot be saved, and says which parts are missing', () => {
    renderScorer(bounceFormat());
    recordBonusTotals(20, 10);
    openEditorFromRecent(1);
    fireEvent.click(screen.getByText('Edit individual parts…'));

    fireEvent.click(outcomeButton(1, 'Bonus part 1 to Ninety Six'));
    fireEvent.click(screen.getByText('Save changes'));

    expect(screen.getByText('Choose who got bonus part 2 and part 3, or enter totals instead.')).toBeTruthy();
    // Still open, and the game is untouched.
    expect(screen.getByRole('heading', { name: 'Edit Question 1' })).toBeTruthy();
    expect(scoreOf('Ninety Six')).toBe('30');
    expect(scoreOf('Greenwood')).toBe('10');
  });

  test('once every part is answered the breakdown replaces the total', () => {
    renderScorer(bounceFormat());
    recordBonusTotals(20, 10);
    openEditorFromRecent(1);
    fireEvent.click(screen.getByText('Edit individual parts…'));

    fireEvent.click(outcomeButton(1, 'Bonus part 1 to Ninety Six'));
    fireEvent.click(outcomeButton(2, 'Bonus part 2 bounced back to Greenwood'));
    fireEvent.click(outcomeButton(3, 'Bonus part 3 missed'));

    expect(within(editor()).queryByText(/Still to answer/)).toBeNull();
    expect(within(editor()).getByText('Ninety Six +10 · Greenwood +10 bounceback')).toBeTruthy();

    fireEvent.click(screen.getByText('Save changes'));

    expect(scoreOf('Ninety Six')).toBe('20');
    expect(scoreOf('Greenwood')).toBe('10');
  });

  test('going back to totals keeps what the bonus is worth and drops only the detail', () => {
    renderScorer(bounceFormat());
    recordBonusParts(['+10', 'Bounce', '+10']);
    openEditorFromRecent(1);

    fireEvent.click(screen.getByText('Enter totals instead'));

    expect(within(editor()).queryByRole('group', { name: 'Bonus part 1 outcome' })).toBeNull();
    const bonus = within(editor()).getByRole('group', { name: 'Ninety Six bonus' });
    expect(within(bonus).getByRole('button', { name: '20' })).toHaveAttribute('aria-pressed', 'true');
    const bounceback = within(editor()).getByRole('group', { name: 'Greenwood bounceback' });
    expect(within(bounceback).getByRole('button', { name: '10' })).toHaveAttribute('aria-pressed', 'true');

    const score = screen.getByRole('table', { name: 'Question 1 score impact' });
    expect(within(score).getByRole('row', { name: /Ninety Six: unchanged at \+30/ })).toBeTruthy();
    expect(within(score).getByRole('row', { name: /Greenwood: unchanged at \+10/ })).toBeTruthy();

    fireEvent.click(screen.getByText('Save changes'));

    expect(scoreOf('Ninety Six')).toBe('30');
    expect(scoreOf('Greenwood')).toBe('10');
  });
});
