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

function rulingGroup() {
  return screen.getByRole('group', { name: 'Ruling' });
}

function chooseRuling(label: string) {
  fireEvent.click(within(rulingGroup()).getByRole('button', { name: label }));
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
    fireEvent.click(screen.getByText('20'));
    openEditor();

    expect(screen.getByRole('heading', { name: 'Edit Question 1' })).toBeTruthy();
    expect(screen.getByText('Score impact')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Question 1 score change' })).getByRole('row', {
      name: 'Ninety Six 0 35',
    })).toBeTruthy();
  });

  test('the lineup and the technical explanation wait behind More', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    openEditor();

    expect(screen.queryByText(/On the floor/)).toBeNull();
    fireEvent.click(screen.getByText('More context'));
    expect(screen.getByText(/On the floor/)).toBeTruthy();
  });

  test('the score after previews the correction before it is saved', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
    fireEvent.click(screen.getByText('20'));
    openEditor();

    const score = screen.getByRole('table', { name: 'Question 1 score change' });
    expect(within(score).getByRole('row', { name: 'Ninety Six 0 30' })).toBeTruthy();

    chooseRuling('Power (+15)');

    expect(within(score).getByRole('row', { name: 'Ninety Six 0 35' })).toBeTruthy();
  });

  test('a completed tossup does not offer an impossible second attempt', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    openEditor();

    expect(screen.queryByText('+ Add attempt')).toBeNull();

    chooseRuling('Neg (-5)');

    expect(screen.getByText('+ Add attempt')).toBeTruthy();
  });

  test('No buzz clears outcomes that cannot coexist with it', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    openEditor();

    fireEvent.click(screen.getByText('Remove bonus'));
    fireEvent.click(screen.getByLabelText('End question without a bonus'));

    expect(screen.queryByLabelText('Ruling')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Bonus points' })).toBeNull();
    expect(screen.getByText('This tossup was recorded with no buzz.')).toBeTruthy();
  });

  test('a zero-point answer remains editable when the other team never converts', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByLabelText('Sarah Mitchell 0 after readout wrong, no penalty'));
    fireEvent.click(screen.getByText('Greenwood has no answer'));
    openEditor();

    expect(screen.getByLabelText('Ruling')).toBeTruthy();
    expect(screen.getByLabelText('End question without a bonus')).toBeTruthy();
    expect(screen.getByText('No team converted this tossup.')).toBeTruthy();
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

    // The exit says where it goes, because "Cancel" gave no clue that it led to an event list.
    fireEvent.click(screen.getByRole('button', { name: 'Close without saving' }));

    expect(screen.queryByText('Question 1')).toBeNull();
    // Not the review list, which is somewhere this scorekeeper never asked to be.
    expect(screen.queryByText('Full scoresheet review')).toBeNull();
    expect(screen.getByLabelText('Ninety Six score')).toBeTruthy();
  });

  test('the review list opens one question, and leaving it returns to the list', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    openEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Back to review' }));

    expect(screen.getByText('Full scoresheet review')).toBeTruthy();
    expect(screen.getByText('Edit question')).toBeTruthy();
  });

  test('the dialog head keeps a Close whatever the editor was opened from', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    openEditorFromRecent(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'Close without saving' }));

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
    expect(screen.getByText(/Nothing changes until you choose Save correction/)).toBeTruthy();
    expect(screen.getByText(/To leave it exactly as it is/)).toBeTruthy();

    fireEvent.click(screen.getByText('Got it — don’t show this again'));
    expect(screen.queryByLabelText('About editing this question')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close without saving' }));
    openEditorFromRecent(1);
    expect(screen.queryByLabelText('About editing this question')).toBeNull();
  });
});

describe('the ruling is one control', () => {
  test('it offers exactly the format’s answer values plus the wrong answer that costs nothing', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
    openEditor();

    expect(within(rulingGroup()).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Power (+15)',
      'Correct (+10)',
      'Neg (-5)',
      'Wrong (0)',
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

    expect(within(rulingGroup()).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Correct (+7)',
      'Neg (-3)',
      'Wrong (0)',
    ]);
  });

  test('choosing a different value rescores the question and everything after it', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
    fireEvent.click(screen.getByText('20'));
    expect(scoreOf('Ninety Six')).toBe('30');

    openEditor();
    chooseRuling('Power (+15)');
    fireEvent.click(screen.getByText('Save correction'));

    expect(scoreOf('Ninety Six')).toBe('35');
  });

  test('the same control turns a buzz into a wrong answer worth nothing', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // -5
    openEditor();

    chooseRuling('Wrong (0)');
    fireEvent.click(screen.getByText('Save correction'));

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

describe('the bonus', () => {
  test('a question that earned no bonus does not open a bonus form', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // a neg: no conversion, no bonus
    openEditor();

    expect(screen.queryByRole('group', { name: 'Bonus points' })).toBeNull();
    expect(screen.getByText('Add bonus')).toBeTruthy();
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

  test('bouncebacks appear only when the format has them', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    openEditor();
    expect(screen.queryByLabelText('Bonus bounceback points')).toBeNull();
    cleanup();

    renderScorer(
      formatFor((rules) => {
        rules.bonusesBounceBack = true;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));
    // With bouncebacks the scorer asks the opponent's share before the cycle is finished.
    fireEvent.click(within(screen.getByLabelText('Bounceback')).getByText('10'));
    openEditor();
    expect(screen.getByLabelText('Bonus bounceback points')).toBeTruthy();
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
    expect(screen.getByLabelText('Points')).toBeTruthy();
  });

  test('a correction that creates a conversion can add the bonus it earns', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // -5
    fireEvent.click(buttonsFor('Emma Turner')[1]); // Greenwood converts
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('0'));

    openEditor();

    // The bonus control is present and attributed to the team that converted.
    expect(screen.getByRole('group', { name: 'Bonus points' })).toBeTruthy();
    expect(screen.getByText(/Bonus — GREENWOOD/)).toBeTruthy();
  });
});
