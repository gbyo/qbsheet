/**
 * @vitest-environment jsdom
 */

/**
 * The scoring screen, driven the way a scorekeeper drives it.
 *
 * No screenshots and nothing about pixels — what is checked here is that the controls a format
 * implies actually appear, that one click on a player records a whole tossup, and that the screen
 * moves itself to the next thing without being told.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import AnswerType from './AnswerType';
import ScorerHost from '../src/scorer/ScorerHost';
import { operationNoticeMs, recoveryNoticeMs } from '../src/scorer/Scorer';
import type { IScorerSubmitResult } from '../src/scorer/Scorer';
import { saveGame } from '../src/scorer/GameSession';
import { resetKeyboardPreference, saveKeyboardEnabled } from '../src/scorer/keyboardPreference';
import { IRoomProcedure } from '../src/scoring/RoomProcedure';
import { ITeamRoster } from '../src/game/Roster';
import { RoomConnectionState } from '../src/app/ConnectionState';
import {
  ControlRequestState,
  HelpClearResult,
  HelpRequestCategory,
  HelpRequestResult,
} from '../src/app/HelpRequests';

const leftTeam = {
  name: 'Ninety Six',
  players: [{ name: 'Sarah Mitchell' }, { name: 'James Robinson' }],
};
const rightTeam = {
  name: 'Greenwood',
  players: [{ name: 'Emma Turner' }, { name: 'Jordan Lee' }],
};

function formatFor(mutate: (rules: ScoringRules) => void = () => {}): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  mutate(rules);
  return scoringRulesToScorekeeperFormat(rules);
}

let gameCounter = 0;

interface IRosterSyncTestOptions {
  authoritativeLeftTeam?: ITeamRoster;
  authoritativeRightTeam?: ITeamRoster;
  onSyncRosterPlayer?: (
    teamName: string,
    playerName: string,
  ) => Promise<{ ok: boolean; error?: string; rejected?: boolean }>;
}

interface IControlRequestTestOptions {
  controlRequest?: ControlRequestState;
  onRetryControlRequest?: () => Promise<HelpRequestResult | null>;
  onCancelControlRequest?: () => Promise<HelpClearResult | null>;
  onEventsChanged?: (events: unknown[]) => void;
  connection?: RoomConnectionState;
}

/*
 * Spelled out rather than `ReturnType<typeof vi.fn>`. An untyped `vi.fn` is `Mock<Procedure |
 * Constructable>`, which carries no call signature the `onSubmit` prop can match, so the prop only
 * ever type-checked because older Vitest widened that to `any`.
 */
type SubmitMock = Mock<(qbj: object) => Promise<IScorerSubmitResult>>;

function renderScorer(
  format: IScorekeeperFormat,
  onSubmit?: SubmitMock,
  onRequestControl?: (category: HelpRequestCategory, message: string) => Promise<HelpRequestResult>,
  procedure?: IRoomProcedure,
  packetName?: string,
  rosterOptions: IRosterSyncTestOptions = {},
  controlOptions: IControlRequestTestOptions = {},
  recovered = false,
  gameKeyOverride?: string,
) {
  const submit: SubmitMock =
    onSubmit ??
    vi.fn<(qbj: object) => Promise<IScorerSubmitResult>>().mockResolvedValue({ ok: true, message: 'Sent' });
  gameCounter += 1;
  const gameKey = gameKeyOverride ?? `test-game-${gameCounter}`;
  if (recovered) {
    saveGame(
      gameKey,
      {
        left: { name: leftTeam.name, players: leftTeam.players.map((player) => player.name) },
        right: { name: rightTeam.name, players: rightTeam.players.map((player) => player.name) },
      },
      [{ id: 'recovered-event', type: 'tossup-dead', questionNumber: 1 }],
      new Date(),
      window.localStorage,
    );
  }
  const scorer = (connection: RoomConnectionState) => (
    <ScorerHost
      gameKey={gameKey}
      format={format}
      leftTeam={leftTeam}
      rightTeam={rightTeam}
      tournamentName="Ninety Six Invitational"
      roundName="Round 4"
      roomName="Room 204"
      packetName={packetName}
      procedure={procedure}
      connection={connection}
      onDownload={() => undefined}
      onSubmit={submit}
      onRequestControl={onRequestControl}
      controlRequest={controlOptions.controlRequest}
      onRetryControlRequest={controlOptions.onRetryControlRequest}
      onCancelControlRequest={controlOptions.onCancelControlRequest}
      onEventsChanged={(events) => controlOptions.onEventsChanged?.(events)}
      authoritativeLeftTeam={rosterOptions.authoritativeLeftTeam}
      authoritativeRightTeam={rosterOptions.authoritativeRightTeam}
      onSyncRosterPlayer={rosterOptions.onSyncRosterPlayer}
    />
  );
  const view = render(scorer(controlOptions.connection ?? RoomConnectionState.Connected));
  return {
    onSubmit: submit,
    unmount: view.unmount,
    rerenderConnection: (connection: RoomConnectionState) => view.rerender(scorer(connection)),
  };
}

/**
 * The scoring buttons on one player's row.
 *
 * Matched against the roster specifically: a player's name also appears in the activity rail once
 * they have buzzed, and a bare text query would find both.
 */
function buttonsFor(playerName: string): HTMLElement[] {
  const row = Array.from(document.querySelectorAll('.scorer-player')).find(
    (candidate) => candidate.querySelector('.scorer-player-name')?.textContent === playerName,
  );
  if (!row) throw new Error(`No roster row for ${playerName}`);
  // The rulings, in format order, and nothing else. The row also carries the Sub button, which is a
  // personnel control rather than a scoring one and is not disabled by a team having answered.
  const answers = row.querySelector('.scorer-answers');
  if (!answers) throw new Error(`No ruling buttons for ${playerName}`);
  return within(answers as HTMLElement).getAllByRole('button');
}

/** The live bonus prompt. */
function bonusPrompt(): HTMLElement {
  return screen.getByLabelText('Bonus');
}

/** One part row of the live prompt, by its number. */
function partRow(partNumber: number): HTMLElement {
  return within(bonusPrompt()).getByText(`Part ${partNumber}`).closest('.scorer-part-row') as HTMLElement;
}

type LiveOutcome = 'controlled' | 'bounceback' | 'missed';

/** What the live prompt calls one part outcome, for the default two-team fixture. */
function outcomeName(partNumber: number, outcome: LiveOutcome): string {
  if (outcome === 'controlled') return `Part ${partNumber} to Ninety Six, 10 points`;
  if (outcome === 'bounceback') return `Part ${partNumber} to Greenwood, 10 points`;
  return `No points on part ${partNumber}`;
}

function pressPart(partNumber: number, outcome: LiveOutcome) {
  fireEvent.click(
    within(partRow(partNumber)).getByRole('button', { name: outcomeName(partNumber, outcome) }),
  );
}

/** The press that writes the bonus, which is a separate act from answering its parts. */
function recordBonus() {
  fireEvent.click(within(bonusPrompt()).getByRole('button', { name: 'Record bonus' }));
}

/**
 * Press a control wherever it currently lives.
 *
 * The footer and the Game menu trade controls between them as the layout settles, and a test that
 * hard-codes which one holds "Players" is asserting on a layout decision rather than on behaviour.
 * This looks on the footer first, then opens the menu.
 */
function pressControl(name: string | RegExp) {
  const onFooter = screen.queryByRole('button', { name });
  if (onFooter) {
    fireEvent.click(onFooter);
    return;
  }
  fireEvent.click(screen.getByRole('button', { name: 'Game' }));
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

/** The presentation preference lives with the rest of the game definition, not in live-play controls. */
function swapSides() {
  pressControl('Game details');
  fireEvent.click(screen.getByRole('button', { name: 'Swap team sides' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
}

/**
 * Open the Issue dialog the way live play reaches it.
 *
 * Flag is the one entry point now: the Game menu used to carry a second copy of this and of
 * Protests, which meant a scorekeeper mid-round had two places to look for the same workflow.
 */
function openIssue(category = 'Question / packet issue') {
  fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Flag' })).getByText(category));
}

function openProtests() {
  fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Flag' })).getByText('Protest / disputed ruling'),
  );
}

/** Every control the screen offers, footer and Game menu together. */
function availableControls(): string[] {
  fireEvent.click(screen.getByText('Game'));
  return Array.from(document.querySelectorAll('.scorer-footer button, .scorer-menu-item')).map(
    (button) => button.textContent ?? '',
  );
}

function scoreOf(teamName: string): string {
  return screen.getByLabelText(`${teamName} score`).textContent ?? '';
}

/**
 * Answer the starting-lineup question, for the formats whose cap is smaller than the roster.
 *
 * Only those formats ask it. A roster that fits on the floor has one possible lineup and the screen
 * goes straight to tossup one, which is why most tests below never call this.
 */
function editReviewEvent(description: string) {
  const row = Array.from(document.querySelectorAll('.scorer-review-event')).find((candidate) =>
    candidate.textContent?.includes(description),
  );
  if (!row) throw new Error(`No scoresheet entry reading "${description}"`);
  const questionRow = row.closest('.scorer-review-list > li');
  if (!questionRow) throw new Error(`No question row for scoresheet entry reading "${description}"`);
  fireEvent.click(within(questionRow as HTMLElement).getByRole('button', { name: 'Edit question' }));
}

function chooseEditorRuling(label: string) {
  const select = screen.getByLabelText('Ruling') as HTMLSelectElement;
  const option = Array.from(select.options).find((candidate) => candidate.textContent === label);
  if (!option) throw new Error(`No ruling option named "${label}"`);
  fireEvent.change(select, { target: { value: option.value } });
}

/** Add somebody who turned up late, through the panel that keeps that separate from the lineup. */
function addMissingPlayer(teamLabel: string, name: string) {
  const lineup = screen.getByLabelText(teamLabel);
  fireEvent.click(within(lineup).getByText('+ Add player'));
  fireEvent.change(within(lineup).getByLabelText('Player name'), { target: { value: name } });
  fireEvent.click(within(lineup).getByText('Add'));
}

function chooseStarters(names: string[]) {
  const prompt = screen.getByLabelText('Starting lineups');
  for (const name of names) {
    const teamName = ['Sarah Mitchell', 'James Robinson'].includes(name) ? 'Ninety Six' : 'Greenwood';
    const team = within(prompt).getByLabelText(`${teamName} starters`);
    fireEvent.click(within(team).getByRole('button', { name: `Start ${name}` }));
  }
  fireEvent.click(within(prompt).getByText('Start game'));
}

/**
 * The jsdom this repo resolves does not provide localStorage, and the scorer saves through it.
 *
 * Shimmed rather than worked around, because the recovery test below is only meaningful if saving
 * actually happens. What the real storage does when it is full, corrupt or hostile is covered
 * properly in RoomGameSession.test.ts, which injects its own.
 */
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

/** jsdom exposes `<dialog>` but not the modal methods browsers provide. */
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
  saveKeyboardEnabled(false);
  resetKeyboardPreference();
  installDialogMethods();
});

afterEach(() => {
  cleanup();
  saveKeyboardEnabled(false);
  resetKeyboardPreference();
  vi.useRealTimers();
});

describe('what the header says', () => {
  test('it names the tournament, round and room, and not the software', () => {
    renderScorer(formatFor());

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ninety Six Invitational');
    expect(screen.getByText(/Round 4/).textContent).toContain('Room 204');
    expect(document.body.textContent).not.toMatch(/YellowFruit|MODAQ|Fruity/);
  });

  // The round arrives already named, from Round.displayName(). A header that adds "Round" itself
  // reads "Round Round 4" for every numbered round, and renames "Finals" to "Round Finals".
  test('it shows the round name as it was given, without prefixing it again', () => {
    renderScorer(formatFor());

    expect(screen.getByText(/Round 4/).textContent).not.toMatch(/Round Round/);
  });

  test('it shows the connection state and how far the game has got', () => {
    renderScorer(formatFor());

    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Tossup 1 of 20')).toBeTruthy();
  });

  test('the hidden progress copy reserves the digits missing from the painted counter', () => {
    renderScorer(formatFor());

    const layoutCopy = document.querySelector('.scorer-progress-copy') as HTMLElement;
    const paintedNumber = document.querySelector(
      '.scorer-progress-visual .qbsheet-motion-number',
    ) as HTMLElement;
    expect(layoutCopy).toHaveTextContent('Tossup 1 of 20');
    expect(layoutCopy.style.getPropertyValue('--scorer-progress-missing-digit-width')).toBe('1ch');
    expect(paintedNumber.style.getPropertyValue('--qbsheet-number-digits')).toBe('2');
  });
});

describe('scoring buttons come from the format', () => {
  /*
   * Every row also carries a zero: an answer that was simply wrong, which spends the team's chance
   * at the tossup without scoring or penalizing anything. It is not an answer type and never will
   * be — a fabricated 0-point AnswerType would appear in every player's P/TU/I line — so it is
   * checked as the constant it is rather than mixed into the format's own values.
   */
  const wrong = '0';

  test('mACF gives each player +15 / +10 / -5', () => {
    renderScorer(formatFor());

    expect(buttonsFor('Sarah Mitchell').map((button) => button.textContent)).toEqual([
      '+15',
      '+10',
      '-5',
      wrong,
    ]);
  });

  test('a format with no powers gives two', () => {
    renderScorer(formatFor((rules) => rules.applyRuleSet(CommonRuleSets.Acf)));

    expect(buttonsFor('Sarah Mitchell').map((button) => button.textContent)).toEqual(['+10', '-5', wrong]);
  });

  test('a 7-point format with a -3 shows exactly that', () => {
    // MODAQ refuses this outright: its base tossup value is hardcoded at 10.
    renderScorer(
      formatFor((rules) => {
        rules.answerTypes = [new AnswerType(7), new AnswerType(-3)];
      }),
    );

    expect(buttonsFor('Sarah Mitchell').map((button) => button.textContent)).toEqual(['+7', '-3', wrong]);
  });

  test('two power tiers and two negs all appear', () => {
    renderScorer(
      formatFor((rules) => {
        rules.answerTypes = [
          new AnswerType(20),
          new AnswerType(15),
          new AnswerType(10),
          new AnswerType(-5),
          new AnswerType(-10),
        ];
      }),
    );

    expect(buttonsFor('Sarah Mitchell').map((button) => button.textContent)).toEqual([
      '+20',
      '+15',
      '+10',
      '-5',
      '-10',
      wrong,
    ]);
  });

  test('only active players get a row, and no empty seats are drawn', () => {
    renderScorer(
      formatFor((rules) => {
        rules.maximumPlayersPerTeam = 1;
      }),
    );
    // A roster bigger than the floor is a question, not a default. Answer it, then check the floor.
    chooseStarters(['Sarah Mitchell', 'Emma Turner']);

    expect(screen.queryByText('James Robinson')).toBeNull();
    expect(screen.getByText('Sarah Mitchell')).toBeTruthy();
  });
});

describe('scoring a tossup', () => {
  test('one click records the buzz and the score moves', () => {
    renderScorer(formatFor());

    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10

    expect(scoreOf('Ninety Six')).toBe('10');
  });

  test('a conversion goes straight to the bonus, unasked', () => {
    renderScorer(formatFor());

    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    const prompt = screen.getByLabelText('Bonus');
    expect(within(prompt).getByText('Ninety Six', { selector: '.scorer-prompt-team' })).toBeTruthy();
  });

  test('the bonus buttons are generated from the bonus structure', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    const choices = within(screen.getByLabelText('Bonus')).getAllByRole('button');

    /*
     * Totals, because nothing bounces here: one press is the whole bonus and enumerating three parts
     * would be three presses for a number the room already said. Part entry stays one press away.
     */
    expect(choices.map((button) => button.textContent)).toEqual(['0', '10', '20', '30', 'Score by part']);
  });

  test('a four-part bonus offers a fifth button', () => {
    renderScorer(
      formatFor((rules) => {
        rules.minimumPartsPerBonus = 4;
        rules.maximumPartsPerBonus = 4;
        rules.pointsPerBonusPart = 10;
        rules.maximumBonusScore = 40;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    const choices = within(screen.getByLabelText('Bonus')).getAllByRole('button');

    expect(choices.map((button) => button.textContent)).toEqual([
      '0',
      '10',
      '20',
      '30',
      '40',
      'Score by part',
    ]);
  });

  test('recording the bonus scores it and returns to the next tossup', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));

    expect(scoreOf('Ninety Six')).toBe('30');
    expect(screen.getByText('Tossup 2 of 20')).toBeTruthy();
  });

  test('an irregular bonus asks for a number instead of offering buttons', () => {
    renderScorer(
      formatFor((rules) => {
        rules.pointsPerBonusPart = undefined;
      }),
    );

    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    expect(screen.getByLabelText('Ninety Six bonus points')).toBeTruthy();
  });
});

/**
 * The bonus a moderator actually reads out, when a missed part can become the other team's points.
 *
 * The question a scorekeeper is answering here is "who got this part?" — three times — and not "what
 * was the total, and then what was the bounceback total?". These are about that question being the
 * one on screen, about the answers being given without arithmetic, and about the bonus recording
 * itself once there is nothing left to ask.
 */
describe('a bounceback bonus', () => {
  function bounceFormat(mutate: (rules: ScoringRules) => void = () => {}) {
    return formatFor((rules) => {
      rules.bonusesBounceBack = true;
      mutate(rules);
    });
  }

  test('it opens on its parts, with every part offering both teams and no points', () => {
    renderScorer(bounceFormat());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    const prompt = bonusPrompt();
    // All three parts, in one panel, at once — not part 1 with the rest to follow.
    expect(within(prompt).getAllByRole('group', { name: /^Part \d of 3$/ })).toHaveLength(3);

    for (const partNumber of [1, 2, 3]) {
      expect(
        within(partRow(partNumber))
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label')),
      ).toEqual([
        `Part ${partNumber} to Ninety Six, 10 points`,
        `Part ${partNumber} to Greenwood, 10 points`,
        `No points on part ${partNumber}`,
      ]);
    }

    /*
     * Every button says whose points it is, on every row — not `+10` twice under a heading three
     * rows above it. Which of the two is the bounce is answered where the press is made.
     */
    expect(
      within(partRow(3))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Ninety Six', 'Greenwood', 'No points']);
    expect(within(prompt).queryByRole('button', { name: 'Bounce' })).toBeNull();
    expect(within(prompt).queryByRole('button', { name: 'Miss' })).toBeNull();

    // The format explained once, as a sentence under the title, naming both teams.
    expect(within(prompt).getByText('Greenwood can score any part Ninety Six misses.')).toBeTruthy();
    // What a part is worth, said once rather than on nine buttons.
    expect(within(prompt).getByText(/3 parts, 10 each/)).toBeTruthy();

    // Nothing is written until this is pressed, and it cannot be pressed on a part-answered bonus.
    expect(within(prompt).getByRole('button', { name: 'Record bonus' })).toBeDisabled();
  });

  test('three part outcomes record one ordinary bonus event with the parts on it', () => {
    const events: unknown[][] = [];
    renderScorer(
      bounceFormat(),
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      {
        onEventsChanged: (written) => events.push(written),
      },
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    pressPart(1, 'controlled');
    pressPart(2, 'bounceback');
    pressPart(3, 'controlled');

    // Answering every part is not recording it: the panel is still up and nothing has been written.
    const beforeRecord = events[events.length - 1] as { type: string }[];
    expect(beforeRecord.filter((event) => event.type === 'bonus')).toHaveLength(0);
    expect(screen.getByLabelText('Bonus')).toBeTruthy();

    /*
     * Record has the focus by the time the last part is answered, which is what makes Enter finish
     * a bonus without a shortcut having to be invented for it.
     */
    const record = within(bonusPrompt()).getByRole('button', { name: 'Record bonus' });
    expect(record).toBeEnabled();
    expect(document.activeElement).toBe(record);
    fireEvent.click(record);

    const written = events[events.length - 1] as Record<string, unknown>[];
    const bonuses = written.filter((event) => event.type === 'bonus');
    // One bonus event, indistinguishable from one recorded any other way. No per-part events.
    expect(bonuses).toHaveLength(1);
    expect(written.some((event) => String(event.type).includes('part'))).toBe(false);
    expect(bonuses[0]).toMatchObject({
      type: 'bonus',
      questionNumber: 1,
      team: 'left',
      parts: [
        { controlledPoints: 10 },
        { controlledPoints: 0, bouncebackPoints: 10 },
        { controlledPoints: 10 },
      ],
    });

    // And the totals QBSheet derived from them, which is the arithmetic nobody had to do.
    expect(scoreOf('Ninety Six')).toBe('30'); // the tossup's 10 plus 20 of bonus
    expect(scoreOf('Greenwood')).toBe('10');
  });

  test('changing an answered part before the bonus is complete simply replaces it', () => {
    renderScorer(bounceFormat());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    pressPart(1, 'controlled');
    expect(within(partRow(1)).getByRole('button', { name: outcomeName(1, 'controlled') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    pressPart(1, 'bounceback');

    // No dialog, no edit mode, no reset: the selection moved and the totals followed it.
    expect(within(partRow(1)).getByRole('button', { name: outcomeName(1, 'controlled') })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(partRow(1)).getByRole('button', { name: outcomeName(1, 'bounceback') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Ninety Six 0 points')).toBeTruthy();
    expect(screen.getByLabelText('Greenwood 10 points')).toBeTruthy();

    // And the progress did not walk backwards to the row that was touched.
    expect(partRow(2)).toHaveClass('is-active');
    pressPart(2, 'controlled');
    pressPart(3, 'missed');
    recordBonus();

    expect(scoreOf('Ninety Six')).toBe('20');
    expect(scoreOf('Greenwood')).toBe('10');
  });

  /**
   * The last part is not the last decision.
   *
   * Committing on it read as an ambush: three presses that did nothing and a fourth that ended the
   * bonus and moved the room on, with no moment in between to look at what had been entered. So
   * every part can still be changed after the last one is answered, and the totals follow.
   */
  test('a fully answered bonus can still be corrected before it is recorded', () => {
    renderScorer(bounceFormat());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    pressPart(1, 'controlled');
    pressPart(2, 'controlled');
    pressPart(3, 'controlled');
    expect(screen.getByLabelText('Ninety Six 30 points')).toBeTruthy();

    pressPart(2, 'bounceback');

    expect(screen.getByLabelText('Ninety Six 20 points')).toBeTruthy();
    expect(screen.getByLabelText('Greenwood 10 points')).toBeTruthy();
    expect(scoreOf('Ninety Six')).toBe('10'); // still only the tossup

    recordBonus();

    expect(scoreOf('Ninety Six')).toBe('30');
    expect(scoreOf('Greenwood')).toBe('10');
  });

  test('the active part is the first unanswered one, and every part stays reachable', () => {
    renderScorer(bounceFormat());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    expect(partRow(1)).toHaveClass('is-active');
    expect(partRow(2)).not.toHaveClass('is-active');
    expect(screen.getByText('0 of 3 parts scored')).toBeTruthy();

    pressPart(1, 'controlled');
    expect(partRow(1)).not.toHaveClass('is-active');
    expect(partRow(1)).toHaveClass('is-answered');
    expect(partRow(2)).toHaveClass('is-active');
    expect(screen.getByText('1 of 3 parts scored')).toBeTruthy();

    // Reaching ahead is allowed; no part is disabled to enforce an order.
    pressPart(3, 'missed');
    expect(partRow(2)).toHaveClass('is-active');
    expect(
      [1, 2, 3]
        .flatMap((partNumber) => within(partRow(partNumber)).getAllByRole('button'))
        .every((button) => !(button as HTMLButtonElement).disabled),
    ).toBe(true);
    // Record is the one control that is: a bonus with an unanswered part is not one to write.
    expect(within(bonusPrompt()).getByRole('button', { name: 'Record bonus' })).toBeDisabled();
  });

  test('the running summary names the teams rather than the storage', () => {
    renderScorer(bounceFormat());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    pressPart(1, 'controlled');
    pressPart(2, 'bounceback');

    const summary = bonusPrompt().querySelector('.scorer-part-total') as HTMLElement;
    expect(summary.textContent).toBe('Ninety Six 10 · Greenwood 10');
    expect(summary.textContent).not.toContain('controlled');
    expect(summary.textContent).not.toContain('bounceback');
  });

  describe('entering totals instead', () => {
    function useTotals() {
      fireEvent.click(within(bonusPrompt()).getByRole('button', { name: 'Enter totals instead' }));
    }

    test('both teams stay on one panel and the opponent is bounded by what is left', () => {
      renderScorer(bounceFormat());
      fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
      useTotals();

      const prompt = bonusPrompt();
      const controlling = within(prompt).getByRole('group', { name: 'Ninety Six bonus points' });
      const opponent = within(prompt).getByRole('group', {
        name: 'Greenwood points from missed parts',
      });
      expect(
        within(controlling)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['0', '10', '20', '30']);

      fireEvent.click(within(controlling).getByRole('button', { name: 'Ninety Six, 10 points' }));

      // The same panel, still showing the controlling team's answer, with the opponent's choices
      // now bounded by the twenty points that are actually left on the bonus.
      expect(within(prompt).getByRole('button', { name: 'Ninety Six, 10 points' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(
        within(opponent)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['0', '10', '20']);

      fireEvent.click(within(opponent).getByRole('button', { name: 'Greenwood, 20 points' }));
      expect(scoreOf('Ninety Six')).toBe('20');
      expect(scoreOf('Greenwood')).toBe('20');
    });

    test('a bonus the controlling team swept records at once, with nothing left to press', () => {
      renderScorer(bounceFormat());
      fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
      useTotals();

      fireEvent.click(within(bonusPrompt()).getByRole('button', { name: 'Ninety Six, 30 points' }));

      expect(screen.getByText('Tossup 2 of 20')).toBeTruthy();
      expect(scoreOf('Ninety Six')).toBe('40');
      expect(scoreOf('Greenwood')).toBe('0');
    });

    test('Score by part goes back to parts before anything is recorded', () => {
      renderScorer(bounceFormat());
      fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
      useTotals();
      fireEvent.click(within(bonusPrompt()).getByRole('button', { name: 'Ninety Six, 20 points' }));

      fireEvent.click(within(bonusPrompt()).getByRole('button', { name: 'Score by part' }));

      expect(within(bonusPrompt()).getAllByRole('group', { name: /^Part \d of 3$/ })).toHaveLength(3);
      // Nothing was written on the way through.
      expect(scoreOf('Ninety Six')).toBe('10');
      pressPart(1, 'controlled');
      pressPart(2, 'missed');
      pressPart(3, 'missed');
      recordBonus();
      expect(scoreOf('Ninety Six')).toBe('20');
    });

    test('each new bonus opens on its parts again', () => {
      renderScorer(bounceFormat());
      fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
      useTotals();
      fireEvent.click(within(bonusPrompt()).getByRole('button', { name: 'Ninety Six, 30 points' }));

      fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

      expect(within(bonusPrompt()).getAllByRole('group', { name: /^Part \d of 3$/ })).toHaveLength(3);
    });
  });

  test('an irregular bounceback bonus asks both teams at once and invents no parts', () => {
    renderScorer(
      bounceFormat((rules) => {
        rules.minimumPartsPerBonus = 1;
        rules.maximumPartsPerBonus = 5;
        rules.pointsPerBonusPart = 0;
        rules.bonusDivisor = 1;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    const prompt = bonusPrompt();
    // Nothing here knows what one part of this bonus is worth, so no parts are offered.
    expect(within(prompt).queryByText('Part 1')).toBeNull();
    expect(within(prompt).queryByRole('button', { name: 'Score by part' })).toBeNull();

    fireEvent.change(within(prompt).getByLabelText('Ninety Six bonus points'), {
      target: { value: '17' },
    });
    fireEvent.change(within(prompt).getByLabelText('Greenwood points from missed parts'), {
      target: { value: '8' },
    });
    // One Record for the pair, not one press per team.
    expect(within(prompt).getAllByRole('button', { name: /Record/ })).toHaveLength(1);
    fireEvent.click(within(prompt).getByRole('button', { name: 'Record bonus' }));

    expect(scoreOf('Ninety Six')).toBe('27');
    expect(scoreOf('Greenwood')).toBe('8');
  });

  test('a pair the format cannot hold is refused by the shared bonus validation', () => {
    renderScorer(
      bounceFormat((rules) => {
        rules.minimumPartsPerBonus = 1;
        rules.maximumPartsPerBonus = 5;
        rules.pointsPerBonusPart = 0;
        rules.bonusDivisor = 1;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    fireEvent.change(screen.getByLabelText('Ninety Six bonus points'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Greenwood points from missed parts'), {
      target: { value: '20' },
    });

    // `bonusScoreProblem`'s own wording, so a room reads the same sentence here and in a correction.
    expect(screen.getByText('The bounceback cannot exceed 5 points.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Record bonus' })).toBeDisabled();
  });
});

/**
 * The bonus where only one team can score, which is a different interface for a good reason.
 */
describe('a bonus without bouncebacks', () => {
  test('one total press records it, and part entry is still offered', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    expect(within(bonusPrompt()).queryByText('Part 1')).toBeNull();
    fireEvent.click(within(bonusPrompt()).getByRole('button', { name: '20' }));

    expect(scoreOf('Ninety Six')).toBe('30');
    expect(screen.getByText('Tossup 2 of 20')).toBeTruthy();
  });

  test('Score by part asks who took each part, with no opponent column to answer for', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    fireEvent.click(within(bonusPrompt()).getByRole('button', { name: 'Score by part' }));

    expect(
      within(partRow(1))
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Part 1 to Ninety Six, 10 points', 'No points on part 1']);
    // No bounce, so nothing to explain about one.
    expect(within(bonusPrompt()).queryByText(/can score any part/)).toBeNull();

    pressPart(1, 'controlled');
    pressPart(2, 'controlled');
    pressPart(3, 'missed');
    recordBonus();

    expect(scoreOf('Ninety Six')).toBe('30');
  });
});

describe('a tossup that is not over yet', () => {
  test('a neg leaves the other team able to answer', () => {
    renderScorer(formatFor());

    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // -5

    expect(scoreOf('Ninety Six')).toBe('-5');
    expect(screen.getByText(/Greenwood may still answer/)).toBeTruthy();
    expect(screen.getByText('Tossup 1 of 20')).toBeTruthy();
  });

  test('the team that negged cannot buzz again on the same tossup', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]);

    expect(buttonsFor('Sarah Mitchell').every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(buttonsFor('Emma Turner').every((button) => (button as HTMLButtonElement).disabled)).toBe(false);
  });

  test('the other team converting scores both teams', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]);

    fireEvent.click(buttonsFor('Emma Turner')[1]);

    expect(scoreOf('Ninety Six')).toBe('-5');
    expect(screen.getByLabelText('Bonus')).toBeTruthy();
  });
});

describe('no buzz', () => {
  test('it records an unanswered tossup and advances on its own', () => {
    renderScorer(formatFor());

    fireEvent.click(screen.getByRole('button', { name: 'No buzz' }));

    expect(screen.getByText('Tossup 2 of 20')).toBeTruthy();
    expect(screen.getByText('No buzz', { selector: '.scorer-rail-what' })).toBeTruthy();
  });
});

describe('scoring motion state', () => {
  test('the question counter moves only for an actual question change and reverses on undo', () => {
    renderScorer(formatFor());
    const counter = () => document.querySelector('.scorer-progress .qbsheet-motion-number') as HTMLElement;

    expect(counter().dataset.motionDirection).toBeUndefined();
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    // Tossup -> bonus is a phase change on the same active question, not a counter change.
    expect(counter().dataset.motionDirection).toBeUndefined();

    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));
    expect(counter().dataset.motionDirection).toBe('forward');
    expect(counter().dataset.previousValue).toBe('1');
    const bonusExit = document.querySelector('.scorer-bonus-exit') as HTMLElement;
    expect(bonusExit).toHaveAttribute('data-motion-token');
    expect(within(bonusExit).getByText('Ninety Six bonus')).toBeTruthy();
    expect(
      Array.from(bonusExit.querySelectorAll('.scorer-choice')).map((choice) =>
        choice.getAttribute('data-presentation-label'),
      ),
    ).toEqual(['0', '10', '20', '30']);
    expect(bonusExit.querySelector('[data-presentation-label="20"]')).toHaveClass('is-selected');

    fireEvent.click(screen.getByText('Undo'));
    expect(counter().dataset.motionDirection).toBe('backward');
    expect(counter().dataset.previousValue).toBe('2');
  });

  test('a committed no-buzz creates the neutral acknowledgement over the already-advanced state', () => {
    renderScorer(formatFor());

    const noBuzz = screen.getByRole('button', { name: 'No buzz' });
    fireEvent.pointerDown(noBuzz);
    expect(document.querySelector('.scorer-no-buzz-sweep')).toBeNull();
    fireEvent.click(noBuzz);

    expect(screen.getByText('Tossup 2 of 20')).toBeTruthy();
    const firstToken = document.querySelector('.scorer-no-buzz-sweep')?.getAttribute('data-motion-token');
    expect(firstToken).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'No buzz' }));
    expect(document.querySelector('.scorer-no-buzz-sweep')?.getAttribute('data-motion-token')).not.toBe(
      firstToken,
    );
  });

  test('a pointer ruling identifies the actual player and format-defined answer type', () => {
    renderScorer(
      formatFor((rules) => {
        rules.answerTypes = [new AnswerType(7), new AnswerType(-3)];
      }),
    );

    const button = buttonsFor('Sarah Mitchell')[0];
    fireEvent.click(button);

    const row = button.closest('.scorer-player') as HTMLElement;
    expect(button).toHaveClass('is-recorded');
    expect(button).toHaveTextContent('+7');
    expect(row).toHaveClass('is-ruling-recorded');
    expect(buttonsFor('James Robinson')[0]).not.toHaveClass('is-recorded');
  });

  test('part selection rolls the running total from the actual old total in both directions', () => {
    renderScorer(
      formatFor((rules) => {
        rules.bonusesBounceBack = true;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    pressPart(1, 'controlled');
    let total = screen.getByLabelText('Ninety Six 10 points');
    expect(total).toHaveAttribute('data-motion-direction', 'forward');
    expect(total).toHaveAttribute('data-previous-value', '0');
    expect(within(partRow(1)).getByRole('button', { name: outcomeName(1, 'controlled') })).toHaveClass(
      'is-part-recorded',
    );
    // The row that took the press is washed; the panel around it is not.
    expect(partRow(1)).toHaveClass('is-part-set');
    expect(partRow(1)).toHaveAttribute('data-motion-token');

    pressPart(1, 'missed');
    total = screen.getByLabelText('Ninety Six 0 points');
    expect(total).toHaveAttribute('data-motion-direction', 'backward');
    expect(total).toHaveAttribute('data-previous-value', '10');
  });

  test('a completed part-entry bonus exits as the intact, inert part snapshot', () => {
    renderScorer(
      formatFor((rules) => {
        rules.bonusesBounceBack = true;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    pressPart(1, 'controlled');
    pressPart(2, 'bounceback');
    pressPart(3, 'controlled');
    recordBonus();

    // The next phase is already live underneath: the snapshot describes what happened, it does not
    // hold the scoresheet open while it plays.
    expect(screen.getByText('Tossup 2 of 20')).toBeTruthy();

    const exit = document.querySelector('.scorer-bonus-exit') as HTMLElement;
    expect(exit).toHaveAttribute('data-motion-token');
    expect(exit.querySelector('[data-presentation-label="Part 1"]')).toBeTruthy();
    expect(exit.querySelector('[data-presentation-label="Part 3"]')).toBeTruthy();
    // The teams the parts went to, kept, and the totals they came to.
    expect(exit.querySelector('[data-presentation-label="Ninety Six"]')).toBeTruthy();
    expect(exit.querySelector('[data-presentation-label="Greenwood"]')).toBeTruthy();
    expect(exit.querySelector('.scorer-part-total')?.getAttribute('data-presentation-label')).toBe(
      'Ninety Six 20 · Greenwood 10',
    );
    // Including the press that committed it, which is a copy of the prompt as it actually was.
    expect(exit.querySelector('[data-presentation-label="Record bonus"]')).toHaveClass('is-selected');
    const secondExitPart = exit.querySelectorAll('.scorer-part-row')[1] as HTMLElement;
    const [toControlling, toOpponent] = Array.from(secondExitPart.querySelectorAll('.scorer-choice'));
    expect(toControlling).not.toHaveClass('is-selected');
    expect(toOpponent).toHaveClass('is-selected');
  });

  test('clock motion tokens follow start and stop, while the clock state changes immediately', () => {
    renderScorer(formatFor(), undefined, undefined, {
      version: 1,
      halves: true,
      halfLengthMinutes: 10,
      timeoutsPerTeam: 0,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const clock = document.querySelector('.scorer-clock') as HTMLElement;
    expect(clock).toHaveAttribute('data-clock-state', 'running');
    expect(clock.querySelector('.scorer-clock-digits')).toHaveAttribute('data-motion-token');

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(clock).toHaveAttribute('data-clock-state', 'paused');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
  });

  test('an expired clock presents Reset without a play icon', async () => {
    vi.useFakeTimers();
    renderScorer(formatFor(), undefined, undefined, {
      version: 1,
      halves: true,
      halfLengthMinutes: 1,
      timeoutsPerTeam: 0,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await act(() => vi.advanceTimersByTimeAsync(60_000));

    const reset = screen.getByRole('button', { name: 'Reset' });
    expect(reset.querySelector('.scorer-clock-icons')).toBeNull();
  });

  test('connection recovery is absent on an initially connected mount and retriggers on each real recovery', () => {
    const view = renderScorer(formatFor());
    const connection = () => screen.getByRole('button', { name: /Show connection detail/ });

    expect(connection()).not.toHaveClass('is-recovered');
    view.rerenderConnection(RoomConnectionState.Offline);
    expect(connection()).not.toHaveClass('is-recovered');
    view.rerenderConnection(RoomConnectionState.Connected);
    const firstToken = connection().getAttribute('data-recovery-token');
    expect(connection()).toHaveClass('is-recovered');
    expect(firstToken).toBeTruthy();

    view.rerenderConnection(RoomConnectionState.Offline);
    view.rerenderConnection(RoomConnectionState.Connected);
    const secondToken = connection().getAttribute('data-recovery-token');
    expect(secondToken).not.toBe(firstToken);

    view.rerenderConnection(RoomConnectionState.Degraded);
    view.rerenderConnection(RoomConnectionState.Connected);
    expect(connection()).toHaveClass('is-recovered');
    expect(connection().getAttribute('data-recovery-token')).not.toBe(secondToken);
  });
});

describe('undo', () => {
  test('it takes back the last thing recorded', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[0]); // +15

    fireEvent.click(screen.getByText('Undo'));

    expect(scoreOf('Ninety Six')).toBe('0');
    expect(screen.getByText('Tossup 1 of 20')).toBeTruthy();
  });

  test('it is unavailable before anything has happened', () => {
    renderScorer(formatFor());

    expect((screen.getByText('Undo') as HTMLButtonElement).disabled).toBe(true);
  });

  test('redo becomes available after undo and restores the action', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[0]);
    fireEvent.click(screen.getByText('Undo'));

    const redo = screen.getByText('Redo') as HTMLButtonElement;
    expect(redo.disabled).toBe(false);
    fireEvent.click(redo);

    expect(scoreOf('Ninety Six')).toBe('15');
  });

  test('Ctrl+Z in a scoring input is left to the input', () => {
    renderScorer(
      formatFor((rules) => {
        rules.pointsPerBonusPart = undefined;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    const input = screen.getByLabelText('Bonus points');

    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });

    expect(scoreOf('Ninety Six')).toBe('10');
    expect(screen.getByLabelText('Bonus points')).toBeTruthy();
  });
});

describe('the recent rail', () => {
  test('it shows only what actually happened', () => {
    renderScorer(formatFor());

    expect(screen.getByText('Nothing scored yet.')).toBeTruthy();

    fireEvent.click(buttonsFor('Sarah Mitchell')[0]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));

    const rail = screen.getByLabelText('Recent activity');
    // What happened and what it was worth are separate cells, so the points can be set in their own
    // right-aligned column. Assert on the pairing rather than on one run of text.
    const lines = Array.from(rail.querySelectorAll('.scorer-rail-line')).map((line) => [
      line.querySelector('.scorer-rail-what')?.textContent,
      line.querySelector('.scorer-rail-points')?.textContent,
    ]);

    expect(lines).toEqual([
      ['Sarah Mitchell', '+15'],
      ['Ninety Six bonus', '+20'],
    ]);
  });

  test('a dead tossup reads as one line with nothing in the points column', () => {
    renderScorer(formatFor());

    fireEvent.click(screen.getByRole('button', { name: 'No buzz' }));

    const rail = screen.getByLabelText('Recent activity');
    const line = rail.querySelector('.scorer-rail-line');

    expect(line?.querySelector('.scorer-rail-what')?.textContent).toBe('No buzz');
    expect(line?.querySelector('.scorer-rail-points')?.textContent).toBe('');
  });
});

describe('the game menu', () => {
  test('shows an icon beside every Game menu action', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByRole('button', { name: 'Game' }));

    const menuItems = document.querySelectorAll('.scorer-menu-item');
    expect(document.querySelectorAll('.scorer-menu-item .scorer-control-icon')).toHaveLength(
      menuItems.length,
    );
  });

  test('Flag opens the existing protest workflow', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));

    expect(screen.getByRole('dialog', { name: 'Flag' })).toBeTruthy();
    fireEvent.click(screen.getByText('Protest / disputed ruling'));
    expect(screen.getByText('Record protest and keep playing')).toBeTruthy();
  });

  test('keeps operational tools behind the single Game menu', () => {
    renderScorer(formatFor());
    const controls = availableControls();

    // Matched loosely: what matters is that each tool is reachable from the scoring screen without
    // hunting, not which of the footer or the menu is holding it today.
    for (const tool of [
      /players/i,
      /flag/i,
      /scoresheet review/i,
      /export \/ backup/i,
      /recover from qbj/i,
    ]) {
      expect(
        controls.some((control) => tool.test(control)),
        `${tool} should be reachable`,
      ).toBe(true);
    }
  });

  /*
   * The Game menu used to carry Protests and Issue as well as the permanent Flag control beside it,
   * which gave one live-play workflow two doors. Flag is the one that is always on screen and always
   * in the same place, so it is the one that kept them.
   */
  test('the live-play flag workflows are not duplicated inside Game', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByRole('button', { name: 'Game' }));

    expect(screen.queryByRole('menuitem', { name: 'Protests' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Issue / tournament control' })).toBeNull();
    // The things that are not duplicates stay exactly where they were.
    expect(screen.getByRole('menuitem', { name: 'Notes' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Game details' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Full scoresheet review' })).toBeTruthy();
  });

  test('Flag still reaches both workflows', () => {
    renderScorer(formatFor());
    openProtests();
    expect(screen.getByRole('dialog', { name: 'Protests' })).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Protests' })).getByRole('button', { name: 'Close dialog' }),
    );

    openIssue();
    expect(screen.getByRole('dialog', { name: 'Issue / tournament control' })).toBeTruthy();
  });

  test('quiet rules separate the groups, and nothing can land on one', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByRole('button', { name: 'Game' }));
    const list = screen.getByRole('menu');
    const children = Array.from(list.children);
    const separators = children.filter((child) => child.getAttribute('role') === 'separator');

    expect(separators.length).toBeGreaterThan(0);
    // Never at either end, and never two in a row: a rule is only drawn where groups meet.
    expect(children[0].getAttribute('role')).not.toBe('separator');
    expect(children[children.length - 1].getAttribute('role')).not.toBe('separator');
    children.forEach((child, index) => {
      if (child.getAttribute('role') !== 'separator') return;
      expect(children[index + 1]?.getAttribute('role')).not.toBe('separator');
    });
    // A rule holds nothing to press, so there is nothing on it for focus to reach.
    for (const separator of separators) {
      expect(separator.querySelectorAll('button')).toHaveLength(0);
      expect(separator.hasAttribute('tabindex')).toBe(false);
    }
  });

  test('arrow keys, Home and End move between entries and never onto a rule', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByRole('button', { name: 'Game' }));
    const entries = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(entries[0]);

    // Down through every entry in turn. A rule between two of them is simply not a stop.
    for (let index = 1; index < entries.length; index += 1) {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(entries[index]);
    }
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(entries[entries.length - 2]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(entries[0]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(entries[entries.length - 1]);
  });

  test('the actions that end a game stay last and behind their own rule', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByRole('button', { name: 'Game' }));
    const children = Array.from(screen.getByRole('menu').children);
    const forfeit = screen.getByRole('menuitem', { name: 'Record forfeit' });
    const forfeitRow = forfeit.closest('li');

    expect(forfeit.className).toContain('is-destructive');
    expect(children[children.length - 1]).toBe(forfeitRow);
    // Everything above the destructive group is separated from it by a rule.
    const destructiveStart = children.findIndex(
      (child) => child.querySelector('.scorer-menu-item.is-destructive') !== null,
    );
    expect(children[destructiveStart - 1]?.getAttribute('role')).toBe('separator');
  });

  test('Swap team sides is quiet, discoverable, and maps a displayed-left buzz canonically', () => {
    let latestEvents: unknown[] = [];
    renderScorer(
      formatFor(),
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      {
        onEventsChanged: (events) => {
          latestEvents = events;
        },
      },
    );

    const panelNames = () =>
      Array.from(document.querySelectorAll('.scorer-team-name')).map((team) => team.textContent);
    expect(panelNames()).toEqual(['Ninety Six', 'Greenwood']);

    swapSides();

    expect(panelNames()).toEqual(['Greenwood', 'Ninety Six']);
    // The orientation is a view preference, so it is not itself an event.
    expect(latestEvents).toHaveLength(0);

    fireEvent.click(buttonsFor('Emma Turner')[1]); // displayed left, canonical right

    expect(scoreOf('Greenwood')).toBe('10');
    expect(latestEvents).toContainEqual(
      expect.objectContaining({ type: 'tossup-buzz', team: 'right', playerName: 'Emma Turner' }),
    );
  });

  test('a swapped orientation drives keyboard seat one to the canonical right team', () => {
    renderScorer(formatFor());

    swapSides();
    fireEvent.click(screen.getByRole('button', { name: 'Game' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keyboard scoring: off' }));

    fireEvent.keyDown(document, { code: 'Digit1', key: '1' });
    fireEvent.keyDown(document, { code: 'KeyC', key: 'c' });

    expect(scoreOf('Greenwood')).toBe('10');
    expect(scoreOf('Ninety Six')).toBe('0');
  });

  test('the swapped orientation survives remounting the same game', () => {
    const gameKey = 'display-side-reload';
    const first = renderScorer(
      formatFor(),
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      {},
      false,
      gameKey,
    );

    swapSides();
    first.unmount();

    renderScorer(formatFor(), undefined, undefined, undefined, undefined, {}, {}, false, gameKey);
    expect(
      Array.from(document.querySelectorAll('.scorer-team-name')).map((team) => team.textContent),
    ).toEqual(['Greenwood', 'Ninety Six']);
  });

  test('the displayed-left lineup routes a substitution to the canonical right team', () => {
    let latestEvents: unknown[] = [];
    renderScorer(
      formatFor((rules) => {
        rules.maximumPlayersPerTeam = 1;
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      {
        onEventsChanged: (events) => {
          latestEvents = events;
        },
      },
    );
    chooseStarters(['Sarah Mitchell', 'Emma Turner']);

    swapSides();
    pressControl('Players');

    const displayedLeft = screen.getByLabelText('Greenwood lineup');
    fireEvent.click(within(displayedLeft).getByText('Replace'));
    fireEvent.click(within(displayedLeft).getByText('Jordan Lee'));
    fireEvent.click(within(displayedLeft).getByText('Confirm'));

    expect(within(screen.getByLabelText('Greenwood')).getByText('Jordan Lee')).toBeTruthy();
    expect(latestEvents).toContainEqual(
      expect.objectContaining({ type: 'substitution', team: 'right', activePlayers: ['Jordan Lee'] }),
    );
  });

  test('lightning is offered only when the format has lightning rounds', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByText('Game'));

    expect(screen.queryByText('Lightning / worksheet')).toBeNull();

    cleanup();
    renderScorer(
      formatFor((rules) => {
        rules.lightningCountPerTeam = 1;
      }),
    );
    fireEvent.click(screen.getByText('Game'));

    expect(screen.getByText('Lightning / worksheet')).toBeTruthy();
  });

  test('end regulation is offered only for a timed round', () => {
    renderScorer(formatFor());
    fireEvent.click(screen.getByText('Game'));

    expect(screen.queryByText('End regulation')).toBeNull();

    cleanup();
    renderScorer(
      formatFor((rules) => {
        rules.timed = true;
      }),
    );
    fireEvent.click(screen.getByText('Game'));

    expect(screen.getByText('End regulation')).toBeTruthy();
  });

  test('one Replace, one replacement choice, and one Confirm changes who is on the floor', () => {
    renderScorer(
      formatFor((rules) => {
        rules.maximumPlayersPerTeam = 1;
      }),
    );
    chooseStarters(['Sarah Mitchell', 'Emma Turner']);
    pressControl('Players');

    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Replace'));
    // The bench is offered as the answer to "replace Sarah with", rather than as a grid to audit.
    expect(within(lineup).getByText('Replace Sarah Mitchell')).toBeTruthy();
    fireEvent.click(within(lineup).getByText('James Robinson'));
    expect(within(lineup).getByText('Sarah Mitchell \u2192 James Robinson')).toBeTruthy();
    fireEvent.click(within(lineup).getByText('Confirm'));

    expect(screen.queryByText('Sarah Mitchell')).toBeNull();
    expect(screen.getByText('James Robinson')).toBeTruthy();
  });

  test('the full lineup editor is still there for a multi-player change', () => {
    renderScorer(
      formatFor((rules) => {
        rules.maximumPlayersPerTeam = 1;
      }),
    );
    chooseStarters(['Sarah Mitchell', 'Emma Turner']);
    pressControl('Players');

    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Change lineup'));
    fireEvent.click(within(lineup).getByLabelText(/Sarah Mitchell/));
    fireEvent.click(within(lineup).getByLabelText(/James Robinson/));
    fireEvent.click(within(lineup).getByText('Apply lineup'));

    expect(screen.queryByText('Sarah Mitchell')).toBeNull();
    expect(screen.getByText('James Robinson')).toBeTruthy();
  });

  test('a lineup change after tossup activity is shown as effective on the next tossup', () => {
    renderScorer(
      formatFor((rules) => {
        rules.maximumPlayersPerTeam = 1;
      }),
    );
    chooseStarters(['Sarah Mitchell', 'Emma Turner']);
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // neg starts Tossup 1
    pressControl('Players');

    expect(screen.getByText('Changes apply starting Tossup 2.')).toBeTruthy();
  });

  test('a local roster addition is marked local when no authoritative roster is available', () => {
    renderScorer(formatFor());
    pressControl('Players');

    addMissingPlayer('Ninety Six lineup', 'Taylor Brooks');
    pressControl('Players');

    expect(screen.getByText('Saved in this game')).toBeTruthy();
  });

  test('a failed roster sync is retried by its timer without another React dependency changing', async () => {
    vi.useFakeTimers();
    const sync = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    renderScorer(formatFor(), undefined, undefined, undefined, undefined, {
      authoritativeLeftTeam: leftTeam,
      authoritativeRightTeam: rightTeam,
      onSyncRosterPlayer: sync,
    });
    pressControl('Players');

    addMissingPlayer('Ninety Six lineup', 'Taylor Brooks');

    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith('Ninety Six', 'Taylor Brooks');
  });

  test('a player can be added during a game and the roster change is sent to control', async () => {
    const requestControl = vi.fn().mockResolvedValue({
      kind: 'accepted',
      request: { category: 'roster-change', message: 'Please add Taylor Brooks.' },
    } satisfies HelpRequestResult);
    renderScorer(formatFor(), undefined, requestControl);
    pressControl('Players');

    addMissingPlayer('Ninety Six lineup', 'Taylor Brooks');

    await vi.waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith('roster-change', expect.stringContaining('Taylor Brooks')),
    );
  });

  test('a failed roster help request is reported after the local roster add', async () => {
    const requestControl = vi.fn().mockResolvedValue({
      kind: 'unreachable',
      error: 'Tournament control did not answer.',
    } satisfies HelpRequestResult);
    renderScorer(formatFor(), undefined, requestControl);
    pressControl('Players');

    addMissingPlayer('Ninety Six lineup', 'Taylor Brooks');

    await vi.waitFor(() => expect(screen.getByText(/Added Taylor Brooks .*not reached/)).toBeTruthy());
    expect(requestControl).toHaveBeenCalledWith('roster-change', expect.stringContaining('Taylor Brooks'));
  });

  test('a restricted substitution window adds a player to the bench without changing the lineup', () => {
    renderScorer(
      formatFor((rules) => {
        rules.maximumPlayersPerTeam = 3;
      }),
      undefined,
      undefined,
      { version: 2, halves: false, timeoutsPerTeam: 0, substitutionPolicy: 'breaks-timeouts-overtime' },
    );
    pressControl('Players');
    const panel = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(panel).getByText('+ Add player'));
    // The panel says where they are going before anything is written.
    expect(within(panel).getByText(/come on at the next allowed substitution/)).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('Player name'), { target: { value: 'Taylor Brooks' } });
    fireEvent.click(within(panel).getByText('Add'));

    pressControl('Players');
    const lineup = screen.getByLabelText('Ninety Six lineup');
    const lists = lineup.querySelectorAll('.scorer-lineup-list');
    expect(lists[0].textContent).not.toContain('Taylor Brooks');
    expect(lists[1].textContent).toContain('Taylor Brooks');
  });

  test('reviewing the scoresheet can correct an earlier ruling', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10
    pressControl('Full scoresheet review');
    fireEvent.click(screen.getByText('Edit question'));

    chooseEditorRuling('Power (+15)');
    fireEvent.click(screen.getByText('Save changes'));

    expect(scoreOf('Ninety Six')).toBe('15');
  });

  test('buzz correction uses the players who were active for that tossup', () => {
    renderScorer(
      formatFor((rules) => {
        rules.maximumPlayersPerTeam = 1;
      }),
    );
    chooseStarters(['Sarah Mitchell', 'Emma Turner']);
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    pressControl('Full scoresheet review');
    // The starting lineups are events on question one too, so pick the buzz by what it says.
    editReviewEvent('Sarah Mitchell +10');

    const player = screen.getByLabelText('Player') as HTMLSelectElement;
    expect(Array.from(player.options, (option) => option.value)).toEqual(['Sarah Mitchell']);
    expect(Array.from(player.options, (option) => option.value)).not.toContain('James Robinson');
  });

  test('the correction offers only the bonus totals this format can produce', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));
    pressControl('Full scoresheet review');
    fireEvent.click(screen.getByText('Edit question'));

    const totals = within(screen.getByRole('group', { name: 'Bonus points' })).getAllByRole('button');
    expect(totals.map((button) => button.textContent)).toEqual(['0', '10', '20', '30']);
  });

  test('an invalid bonus correction stays open with an explanation', () => {
    /*
     * An irregular format, because it is the only one that can still express an impossible bonus.
     *
     * A regular format's correction offers quick totals for the whole bonus and three fixed outcomes
     * per part, and neither can name an out-of-range figure. The typed field an irregular bonus has
     * no alternative to can, and it still has to be refused rather than saved.
     */
    renderScorer(
      formatFor((rules) => {
        rules.minimumPartsPerBonus = 1;
        rules.maximumPartsPerBonus = 5;
        rules.pointsPerBonusPart = 0;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.change(screen.getByLabelText('Ninety Six bonus points'), { target: { value: '20' } });
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('Record bonus'));
    pressControl('Full scoresheet review');
    fireEvent.click(screen.getByText('Edit question'));

    // Scoped to the editor: the bonus prompt this correction is about is still on its way off the
    // scoresheet behind the dialog, and it carries a field by the same name.
    const editor = document.querySelector('.scorer-question-editor') as HTMLElement;
    fireEvent.change(within(editor).getByLabelText('Bonus points'), { target: { value: '40' } });
    fireEvent.click(screen.getByText('Save changes'));

    expect(screen.getByText('The most a bonus can be worth is 30.')).toBeTruthy();
    expect(screen.getByText('Save changes')).toBeTruthy();
  });

  test('bonus correction drafts can be cleared without entering zero', () => {
    renderScorer(
      formatFor((rules) => {
        rules.minimumPartsPerBonus = 1;
        rules.maximumPartsPerBonus = 5;
        rules.pointsPerBonusPart = 0;
      }),
    );
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.change(screen.getByLabelText('Ninety Six bonus points'), { target: { value: '20' } });
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('Record bonus'));
    pressControl('Full scoresheet review');
    fireEvent.click(screen.getByText('Edit question'));

    const editor = document.querySelector('.scorer-question-editor') as HTMLElement;
    const points = within(editor).getByLabelText('Bonus points') as HTMLInputElement;
    fireEvent.change(points, { target: { value: '' } });
    expect(points.value).toBe('');
    fireEvent.click(screen.getByText('Save changes'));

    expect(screen.getByText('Enter a valid number for controlled.')).toBeTruthy();
  });

  test('the order of two attempts is changed by one unambiguous control', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // a neg for Ninety Six
    fireEvent.click(buttonsFor('Emma Turner')[1]); // Greenwood answers second
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));
    pressControl('Full scoresheet review');
    fireEvent.click(screen.getByText('Edit question'));

    const teamOf = (attempt: number) =>
      (screen.getByLabelText(`Question 1 attempt ${attempt} team`) as HTMLSelectElement).value;
    expect([teamOf(1), teamOf(2)]).toEqual(['left', 'right']);

    /*
     * A two-row list has exactly one other order, so an Up and a Down on every row were four
     * controls for one decision — and two buttons per row sharing a name is what made them need
     * row-specific labels to be usable at all.
     */
    fireEvent.click(screen.getByRole('button', { name: 'Swap order' }));

    expect([teamOf(1), teamOf(2)]).toEqual(['right', 'left']);
    expect(screen.queryByRole('button', { name: /Move attempt/ })).toBeNull();
  });

  test('the question editor can remove an attempt and replace it atomically', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    pressControl('Full scoresheet review');

    fireEvent.click(screen.getByText('Edit question'));
    fireEvent.click(screen.getByText('Remove'));
    fireEvent.click(screen.getByLabelText('No buzz'));
    fireEvent.click(screen.getByText('Save changes'));

    expect(scoreOf('Ninety Six')).toBe('0');
    expect(screen.getByText('No buzz', { selector: '.scorer-review-event > span' })).toBeTruthy();
  });

  test('the focused question editor can open the existing replacement workflow', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    pressControl('Full scoresheet review');
    fireEvent.click(screen.getByText('Edit question'));
    // The replacement workflow is secondary information, so it lives behind the disclosure.
    fireEvent.click(screen.getByText('Correction details'));
    fireEvent.click(screen.getByText('Edit full question\u2026'));

    const replacementDialog = screen.getByRole('dialog', { name: 'Replace question 1' });
    expect(replacementDialog).toBeTruthy();
    fireEvent.change(within(replacementDialog).getByLabelText('What went wrong?'), {
      target: { value: 'Wrong packet' },
    });
    fireEvent.click(within(replacementDialog).getByRole('button', { name: 'Whole cycle' }));
    fireEvent.click(within(replacementDialog).getByRole('button', { name: 'Replace question 1' }));

    expect(screen.getByText(/Question 1 was cleared/)).toBeTruthy();
  });

  test('an operational issue is saved and can request tournament control', async () => {
    const requestControl = vi.fn().mockResolvedValue({
      kind: 'accepted',
      request: { category: 'protest', message: 'The ruling was disputed.' },
    } satisfies HelpRequestResult);
    renderScorer(formatFor(), undefined, requestControl);
    openIssue();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The buzzers cut out.' } });
    fireEvent.click(screen.getByText('Save and request control'));

    await vi.waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith('question-packet', 'The buzzers cut out.'),
    );
  });

  test('a failed control request never prevents the local issue from being saved', async () => {
    const requestControl = vi.fn().mockResolvedValue({
      kind: 'unreachable',
      error: 'Tournament control did not answer.',
    } satisfies HelpRequestResult);
    let latestEvents: unknown[] = [];
    renderScorer(
      formatFor(),
      undefined,
      requestControl,
      undefined,
      undefined,
      {},
      {
        onEventsChanged: (events) => {
          latestEvents = events;
        },
      },
    );
    openIssue();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The room lost Wi-Fi.' } });
    fireEvent.click(screen.getByText('Save and request control'));

    await vi.waitFor(() =>
      expect(screen.getByText('Issue saved, but tournament control was not reached.')).toBeTruthy(),
    );
    await vi.waitFor(() =>
      expect(latestEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'note',
            text: 'Question / packet issue: The room lost Wi-Fi.',
            flagged: true,
          }),
        ]),
      ),
    );
    expect(requestControl).toHaveBeenCalledTimes(1);
  });

  test('a second issue is saved while one room summons is outstanding, without another request', async () => {
    const requestControl = vi.fn();
    const outstanding: ControlRequestState = {
      kind: 'outstanding',
      request: { id: 'help-1', category: 'question-packet', message: 'The buzzers cut out.' },
      requestedAt: '2026-08-11T14:42:00.000Z',
      requestedAtSource: 'server',
    };
    let latestEvents: unknown[] = [];
    renderScorer(
      formatFor(),
      undefined,
      requestControl,
      undefined,
      undefined,
      {},
      {
        controlRequest: outstanding,
        onEventsChanged: (events) => {
          latestEvents = events;
        },
      },
    );

    openIssue();
    expect(screen.getByRole('dialog', { name: 'Issue / tournament control' })).toHaveTextContent(
      'Tournament control has already been requested.',
    );
    expect(screen.queryByLabelText('Ask tournament control to come')).toBeNull();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'A second issue.' } });
    fireEvent.click(screen.getByText('Save issue'));
    await vi.waitFor(() =>
      expect(latestEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'note', text: 'Question / packet issue: A second issue.' }),
        ]),
      ),
    );
    expect(requestControl).not.toHaveBeenCalled();
  });

  test('the outstanding room summons is shared by ordinary issues and protests', () => {
    const requestControl = vi.fn();
    const outstanding: ControlRequestState = {
      kind: 'outstanding',
      request: { id: 'help-2', category: 'protest', message: 'A ruling needs a director.' },
      requestedAt: '2026-08-11T14:42:00.000Z',
      requestedAtSource: 'server',
    };
    renderScorer(
      formatFor(),
      undefined,
      requestControl,
      undefined,
      undefined,
      {},
      { controlRequest: outstanding },
    );

    openProtests();
    expect(screen.getByRole('dialog', { name: 'Protests' })).toHaveTextContent(
      'Tournament control has already been requested.',
    );
    expect(screen.queryByLabelText('Ask tournament control to come')).toBeNull();
  });

  test('a failed summons offers a retry without asking for the issue again', async () => {
    const retry = vi.fn().mockResolvedValue({
      kind: 'accepted',
      request: { id: 'help-3', category: 'question-packet', message: 'The buzzers cut out.' },
    } satisfies HelpRequestResult);
    const failed: ControlRequestState = {
      kind: 'failed',
      category: 'question-packet',
      message: 'The buzzers cut out.',
      error: 'Could not reach tournament control.',
      retryable: true,
    };
    renderScorer(
      formatFor(),
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      {
        controlRequest: failed,
        onRetryControlRequest: retry,
      },
    );
    openIssue();
    expect(screen.getAllByText('Tournament control was not reached.').length).toBeGreaterThan(0);
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Issue / tournament control' })).getByRole('button', {
        name: 'Try request again',
      }),
    );
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  });

  test('a file-scored issue is saved without offering remote controls', async () => {
    let latestEvents: unknown[] = [];
    renderScorer(
      formatFor(),
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      {
        onEventsChanged: (events) => {
          latestEvents = events;
        },
      },
    );
    openIssue();
    expect(screen.queryByLabelText('Ask tournament control to come')).toBeNull();
    expect(screen.getByText(/remote control requests/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'The packet is damaged.' },
    });
    fireEvent.click(screen.getByText('Save issue'));

    await vi.waitFor(() =>
      expect(latestEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'note', text: 'Question / packet issue: The packet is damaged.' }),
        ]),
      ),
    );
  });

  /*
   * Protests moved out of the Issue dialog and into their own, because a protest is not an issue
   * that gets reported and closed: it has a team, a subject, and a decision that may still be
   * pending when the result is submitted. Asking for a director is still one checkbox away.
   */
  test('a protest can also ask tournament control to come', async () => {
    const requestControl = vi.fn().mockResolvedValue({
      kind: 'accepted',
      request: { category: 'protest', message: 'The ruling was disputed.' },
    } satisfies HelpRequestResult);
    renderScorer(formatFor(), undefined, requestControl);
    openProtests();
    fireEvent.change(screen.getByLabelText('Details'), { target: { value: 'The ruling was disputed.' } });
    fireEvent.click(screen.getByLabelText('Ask tournament control to come'));
    fireEvent.click(screen.getByText('Record protest and keep playing'));

    await vi.waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith(
        'protest',
        expect.stringContaining('The ruling was disputed.'),
      ),
    );
  });
});

describe('finishing', () => {
  /** Play out a full regulation, with one team ahead so it is not a tie. */
  const playRegulation = () => {
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));
    for (let question = 2; question <= 20; question += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'No buzz' }));
    }
  };

  test('the game ends itself and shows what it is about to send', () => {
    renderScorer(formatFor());

    playRegulation();

    expect(screen.getByText('Game complete')).toBeTruthy();
    expect(screen.getByText('Final score')).toBeTruthy();
    expect(document.querySelector('.scorer-complete')).toHaveClass('is-newly-complete');
    expect(document.querySelector('.scorer-complete')).toHaveAttribute('data-completion-token');
    // The per-player lines are the point of the check: this is where a misattributed buzz shows up.
    expect(screen.getByLabelText('Ninety Six players')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit result' })).toBeTruthy();
  });

  test('the result cannot be sent until the score has been confirmed with both teams', () => {
    const { onSubmit } = renderScorer(formatFor());
    playRegulation();

    fireEvent.click(screen.getByText('Submit result'));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('submitting hands the result over exactly once', async () => {
    const { onSubmit } = renderScorer(formatFor());
    playRegulation();

    fireEvent.click(screen.getByLabelText('Final score confirmed with both teams'));
    fireEvent.click(screen.getByText('Submit result'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // What it hands over is a QBJ match, not the scorer's own state.
    expect(onSubmit.mock.calls[0][0]).toHaveProperty('match_teams');
  });

  test('a tied regulation pauses at the overtime checkpoint', () => {
    renderScorer(formatFor());
    for (let question = 1; question <= 20; question += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'No buzz' }));
    }

    expect(screen.getByLabelText('overtime checkpoint')).toBeTruthy();
    fireEvent.click(screen.getByText('Begin overtime'));

    // Still tied, so the game has not ended: it can now play overtime.
    expect(screen.getByText(/Overtime tossup 1/)).toBeTruthy();
  });

  test('a tied game is called out without offering submission', () => {
    renderScorer(formatFor());
    for (let question = 1; question <= 20; question += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'No buzz' }));
    }

    expect(screen.getByText('This game is a tie.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit result' })).toBeNull();
  });
});

describe('recovering a game', () => {
  test('a reload comes back to the same game rather than an empty one', () => {
    const format = formatFor();
    gameCounter += 1;
    const gameKey = `recovery-${gameCounter}`;
    const submit = vi.fn();
    // The same game, mounted twice, exactly as a reload would.
    const mount = () =>
      render(
        <ScorerHost
          gameKey={gameKey}
          format={format}
          leftTeam={leftTeam}
          rightTeam={rightTeam}
          tournamentName="Ninety Six Invitational"
          roundName="Round 4"
          connection={RoomConnectionState.Connected}
          onDownload={() => undefined}
          onSubmit={submit}
        />,
      );

    const first = mount();
    fireEvent.click(buttonsFor('Sarah Mitchell')[0]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('30'));
    expect(scoreOf('Ninety Six')).toBe('45');
    first.unmount();

    mount();

    expect(scoreOf('Ninety Six')).toBe('45');
    expect(screen.getByText('Tossup 2 of 20')).toBeTruthy();
  });

  test('a durable record reopens the scoresheet when the fast journal is unavailable', () => {
    const format = formatFor();
    gameCounter += 1;
    const gameKey = `durable-recovery-${gameCounter}`;
    const durableSetup = {
      left: { name: leftTeam.name, players: leftTeam.players.map((player) => player.name) },
      right: { name: rightTeam.name, players: rightTeam.players.map((player) => player.name) },
    };

    render(
      <ScorerHost
        gameKey={gameKey}
        format={format}
        leftTeam={leftTeam}
        rightTeam={rightTeam}
        tournamentName="Ninety Six Invitational"
        roundName="Round 4"
        connection={RoomConnectionState.Connected}
        onDownload={() => undefined}
        onSubmit={vi.fn()}
        durableSetup={durableSetup}
        durableEvents={[{ id: 'durable-dead', type: 'tossup-dead', questionNumber: 1 }]}
      />,
    );

    expect(screen.getByText('Tossup 2 of 20')).toBeTruthy();
    expect(screen.getByText('Recovered the in-progress game saved on this device.')).toBeTruthy();
  });

  test('a valid fast journal still takes precedence over its durable mirror', () => {
    const format = formatFor();
    gameCounter += 1;
    const gameKey = `journal-precedence-${gameCounter}`;
    const setup = {
      left: { name: leftTeam.name, players: leftTeam.players.map((player) => player.name) },
      right: { name: rightTeam.name, players: rightTeam.players.map((player) => player.name) },
    };
    saveGame(
      gameKey,
      setup,
      [
        {
          id: 'journal-buzz',
          type: 'tossup-buzz',
          questionNumber: 1,
          team: 'left',
          playerName: 'Sarah Mitchell',
          answerTypeIndex: 0,
        },
      ],
      new Date(),
      window.localStorage,
    );

    render(
      <ScorerHost
        gameKey={gameKey}
        format={format}
        leftTeam={leftTeam}
        rightTeam={rightTeam}
        tournamentName="Ninety Six Invitational"
        roundName="Round 4"
        connection={RoomConnectionState.Connected}
        onDownload={() => undefined}
        onSubmit={vi.fn()}
        durableSetup={setup}
        durableEvents={[{ id: 'durable-dead', type: 'tossup-dead', questionNumber: 1 }]}
      />,
    );

    expect(scoreOf('Ninety Six')).toBe('15');
  });
});

describe('a wrong answer that costs nothing', () => {
  /*
   * NAQT's answer types are 15, 10 and -5, and it has a fourth tossup outcome none of them can
   * express: an answer given after the question has been read in full is worth zero. `No buzz` is
   * not the same thing, because the other team is still owed its chance.
   */
  test("the zero ends this team's chance and leaves the other team eligible", () => {
    renderScorer(formatFor());

    fireEvent.click(screen.getByLabelText('Sarah Mitchell 0 after readout wrong, no penalty'));

    expect(scoreOf('Ninety Six')).toBe('0');
    expect(screen.getByText(/Greenwood may still answer/)).toBeTruthy();
    expect(screen.getByText('Tossup 1 of 20')).toBeTruthy();
  });

  test('the second team is offered its positive values and a zero, but not a neg', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // -5

    expect(buttonsFor('Emma Turner').map((button) => button.textContent)).toEqual(['+15', '+10', '0']);
  });

  test('the first team still has the neg available', () => {
    renderScorer(formatFor());

    expect(buttonsFor('Sarah Mitchell').map((button) => button.textContent)).toContain('-5');
  });
});

describe('one action, however many times the button is pressed', () => {
  test('two clicks on the same buzz score it once', () => {
    renderScorer(formatFor());
    const tenPoints = buttonsFor('Sarah Mitchell')[1];

    // Both dispatched against the render that was on screen, which is what a double-tap produces.
    fireEvent.click(tenPoints);
    fireEvent.click(tenPoints);

    expect(scoreOf('Ninety Six')).toBe('10');
  });

  test('a team that has answered has no buttons left to press', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[2]); // -5

    // The engine refuses a second answer outright; the screen simply stops offering one.
    expect(buttonsFor('Sarah Mitchell').every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe('halves and timeouts, when the tournament asked for them', () => {
  const procedure = { version: 1, halves: true, timeoutsPerTeam: 1 };

  test('neither appears for a tournament that configured neither', () => {
    renderScorer(formatFor());

    expect(availableControls()).not.toContain('Timeout');
    expect(availableControls()).not.toContain('End first half');
  });

  test('the break stops the game for a score check, and continuing resumes it', () => {
    renderScorer(formatFor(), undefined, undefined, procedure);
    fireEvent.click(screen.getByRole('button', { name: 'No buzz' }));
    pressControl('End first half');

    expect(screen.getByLabelText('Halftime score check')).toHaveClass('scorer-score-check');
    fireEvent.click(screen.getByText('Score confirmed · Continue'));

    expect(screen.getByText('Tossup 2 of 20')).toBeTruthy();
  });

  test('a timeout is recorded against one team and shown on its panel', () => {
    renderScorer(formatFor(), undefined, undefined, procedure);
    pressControl('Timeout');
    fireEvent.click(within(screen.getByLabelText('Timeout')).getByText('Ninety Six'));

    expect(screen.getByText('0 remaining (1 used)')).toBeTruthy();
  });

  test('a swapped timeout choice is displayed first but records the canonical right team', () => {
    let latestEvents: unknown[] = [];
    renderScorer(
      formatFor(),
      undefined,
      undefined,
      procedure,
      undefined,
      {},
      {
        onEventsChanged: (events) => {
          latestEvents = events;
        },
      },
    );

    swapSides();
    pressControl('Timeout');
    const timeout = screen.getByLabelText('Timeout');
    expect(
      Array.from(timeout.querySelectorAll('.scorer-choice')).map((button) => button.textContent),
    ).toEqual(['Greenwood', 'Ninety Six']);
    fireEvent.click(within(timeout).getByText('Greenwood'));

    expect(screen.getByText('0 remaining (1 used)')).toBeTruthy();
    expect(latestEvents).toContainEqual(expect.objectContaining({ type: 'timeout-start', team: 'right' }));
  });
});

describe('replacing a spoiled question', () => {
  test('the cycle is cleared and played again as the same question', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10 on tossup 1
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));
    fireEvent.click(buttonsFor('Emma Turner')[1]); // +10 on tossup 2

    pressControl('Replace question 2');
    // The bonus is owed, so the dialog offers the narrower fix first; this cycle needs the whole one.
    fireEvent.click(screen.getByText('Whole cycle'));
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'Wrong packet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace question 2' }));

    expect(scoreOf('Greenwood')).toBe('0');
    expect(scoreOf('Ninety Six')).toBe('30');
    expect(screen.getByText('Tossup 2 of 20')).toBeTruthy();
  });
});

describe('ending a game short', () => {
  test('the game stops at the score it had, with the reason on the result', async () => {
    const { onSubmit } = renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));

    pressControl('End game early…');
    fireEvent.change(screen.getByLabelText('Why is the game ending early?'), {
      target: { value: 'Director stopped the round' },
    });
    fireEvent.click(screen.getByText('End the game now'));

    expect(screen.getAllByText(/ended early/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText('Final score confirmed with both teams'));
    fireEvent.click(screen.getByText('Submit result'));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect((onSubmit.mock.calls[0][0] as { notes: string }).notes).toContain('Director stopped the round');
  });

  /**
   * A required box, said out loud, with the cursor already in it.
   *
   * The dialog shell focuses the first thing it finds, which is the close button in its own header,
   * so every one of these opened one Tab away from the only field it has. And the primary action is
   * disabled until that field has something in it — which, with nothing next to it saying so, is a
   * screen that knows what it is waiting for and will not say. A room ending a round early is doing
   * it because somebody is standing there waiting, which is the worst moment to make them guess.
   */
  test('the reason box has the cursor, and the greyed-out button says what it is waiting for', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));

    pressControl('End game early…');

    expect(screen.getByLabelText('Why is the game ending early?')).toHaveFocus();
    expect(screen.getByText(/^Required\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'End the game now' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Why is the game ending early?'), {
      target: { value: 'Packet ran out' },
    });
    expect(screen.getByRole('button', { name: 'End the game now' })).toBeEnabled();
  });
});

/**
 * Where the cursor lands when a dialog opens.
 *
 * Each of these exists to have something typed into it, and each used to open on the close button in
 * the shell's header — one wasted keystroke for a scorekeeper, and, for anybody listening to the
 * screen instead of looking at it, a dialog that announces itself as "Close dialog".
 *
 * Replace question asks for something other than typing. It wants a scope voided before it wants a
 * reason, so the cursor stops on that decision rather than past it — putting it in the reason box
 * would make the default the only scope a keyboard reaches without going backwards.
 */
describe('a dialog opens on the thing it is asking for', () => {
  test('Notes starts in the note', () => {
    renderScorer(formatFor());

    pressControl('Notes');

    expect(screen.getByLabelText(/^Note on question/)).toHaveFocus();
  });

  test('Issue starts in the description', () => {
    renderScorer(formatFor());

    openIssue();

    expect(screen.getByLabelText('What happened?')).toHaveFocus();
  });

  /*
   * Game details opens as a summary rather than as a form, so there is no field to land in: somebody
   * checking which packet this round is on must not be one keystroke from renaming the moderator.
   * Editing the one thing it has always been able to change is still one press, and *that* lands in
   * the field.
   */
  test('Game details opens on the summary, and Edit starts in the moderator name', () => {
    renderScorer(formatFor());

    pressControl('Game details');
    expect(screen.queryByLabelText('Moderator / reader')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('Moderator / reader')).toHaveFocus();
  });

  test('Replace question starts on the scope it would void, ahead of the reason', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    pressControl(/^Replace question/);

    // Landing anywhere else means landing on the header's close button, which is the fallback and
    // announces itself as "Close dialog" — the thing every other dialog here was fixed to stop.
    const dialog = screen.getByRole('dialog', { name: /^Replace question/ });
    expect(within(dialog).getByRole('button', { pressed: true })).toHaveFocus();
    expect(screen.getByLabelText('What went wrong?')).not.toHaveFocus();
  });
});

describe('a protest is a thing with a state', () => {
  test('it is recorded, the game carries on, and control is warned before submission', () => {
    renderScorer(formatFor());
    openProtests();
    fireEvent.change(screen.getByLabelText('Details'), { target: { value: 'The ruling was disputed.' } });
    fireEvent.click(screen.getByText('Record protest and keep playing'));
    fireEvent.click(within(screen.getByLabelText('Protests')).getByRole('button', { name: 'Close dialog' }));

    // Scoring is untouched by it: the game is still on tossup one and still scoreable.
    expect(screen.getByText('Tossup 1 of 20')).toBeTruthy();
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));
    for (let question = 2; question <= 20; question += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'No buzz' }));
    }

    expect(screen.getByText('Unresolved protests')).toBeTruthy();
  });
});

describe('the header identifies the packet when the tournament named one', () => {
  test('it says which packet, and nothing about what is in it', () => {
    renderScorer(formatFor(), undefined, undefined, undefined, 'Packet 4');

    expect(screen.getByText(/Round 4/).textContent).toContain('Packet 4');
  });
});

describe('the Recent rail is a way back into the scoresheet', () => {
  test('clicking a question opens its editor', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));

    fireEvent.click(screen.getByLabelText('Review question 1'));

    expect(screen.getByText('Edit Question 1')).toBeTruthy();
    expect(screen.getByLabelText('Ruling')).toBeTruthy();
  });

  test('it carries the score as it stood after each question', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(within(screen.getByLabelText('Bonus')).getByText('20'));

    expect(screen.getAllByLabelText('Score after this question')[0].textContent).toBe('30–0');
  });
});

/**
 * Saying what was taken back.
 *
 * Undo has always altered the event list correctly and said nothing about it, which on a scoresheet
 * is the wrong half of the job: a scorekeeper presses it because they believe something is wrong,
 * and the screen answering with a silently different set of numbers gives them nothing to check
 * their belief against. The stack is unchanged — this is a sentence about what came off it.
 */
describe('undo and redo say what they changed', () => {
  function notice(): string {
    return document.querySelector('.scorer-banner.is-info')?.textContent ?? '';
  }

  test('it names the question and the action it removed', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]); // +10 on tossup 1

    fireEvent.click(screen.getByText('Undo'));

    expect(notice()).toBe('Undid Q1 · Sarah Mitchell +10');
    expect(scoreOf('Ninety Six')).toBe('0');
    const undoRow = document.querySelector('.scorer-rail-item.is-undoing');
    expect(undoRow).toHaveTextContent('Q1');
    expect(undoRow).toHaveAttribute('aria-hidden', 'true');
  });

  test('redo says the same thing the other way round', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('Undo'));

    fireEvent.click(screen.getByText('Redo'));

    expect(notice()).toBe('Redid Q1 · Sarah Mitchell +10');
    expect(scoreOf('Ninety Six')).toBe('10');
    expect(document.querySelector('.scorer-rail-item.is-redoing')).toHaveTextContent('Q1');
  });

  /*
   * The footer and the keyboard are one act with two switches. They used to call the event stack
   * separately, so anything added to one of them would simply not exist on the other — and the
   * keyboard is used by the scorekeepers least likely to be looking at the screen when it happens.
   */
  test('the keyboard shortcut goes through the same feedback', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });

    expect(notice()).toBe('Undid Q1 · Sarah Mitchell +10');
    expect(scoreOf('Ninety Six')).toBe('0');

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true, shiftKey: true });

    expect(notice()).toBe('Redid Q1 · Sarah Mitchell +10');
    expect(scoreOf('Ninety Six')).toBe('10');
  });

  test('a question still in Recent is pointed at, and stays clickable while it is', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByText('20'));
    fireEvent.click(buttonsFor('Emma Turner')[1]);
    fireEvent.click(screen.getByText('20'));

    // The bonus comes off and question 2 is still a question, so there is a row to point at.
    fireEvent.click(screen.getByText('Undo'));

    const emphasised = document.querySelectorAll('.scorer-rail-item.is-emphasized');
    expect(emphasised).toHaveLength(1);
    expect(emphasised[0].textContent).toContain('Q2');
    // Emphasis is a background and nothing else; the row still opens the question.
    expect(
      within(emphasised[0] as HTMLElement).getByRole('button', { name: 'Review question 2' }),
    ).toBeTruthy();
  });

  test('a multi-event action is still one undo, described as one thing', () => {
    // Replacing a spoiled cycle writes the void and the note explaining it together, and a
    // scorekeeper who takes that back means both halves of it.
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Game' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Replace question 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Replace question 1' });
    fireEvent.change(within(dialog).getByLabelText('What went wrong?'), {
      target: { value: 'Wrong packet' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Whole cycle' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace question 1' }));

    fireEvent.click(screen.getByText('Undo'));

    expect(notice()).toBe('Undid Q1 · 2 changes');
    // One press, one frame: the buzz underneath it is still there, and is the next thing to undo.
    expect(scoreOf('Ninety Six')).toBe('10');
    expect((screen.getByText('Undo').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * One question about what kind of issue this is, asked once.
 *
 * Flag exists to ask it, and the Issue dialog used to open with a complete category selector as its
 * first field — so a scorekeeper who had just pressed "Question / packet issue" was immediately
 * asked which kind of issue this was. Reasonably, some of them concluded the first press had not
 * taken.
 */
describe('the issue category carries forward from Flag', () => {
  test('the chosen category is stated rather than asked again', () => {
    renderScorer(formatFor());
    openIssue('Equipment / technical issue');

    const dialog = screen.getByRole('dialog', { name: 'Issue / tournament control' });
    expect(within(dialog).getByText('Equipment / technical issue')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Issue')).toBeNull();
    // And the thing it actually wants is right there.
    expect(within(dialog).getByLabelText('What happened?')).toBeTruthy();
  });

  test('it is the category the issue is saved under', async () => {
    const requestControl = vi.fn().mockResolvedValue({ kind: 'accepted', request: {} } as HelpRequestResult);
    renderScorer(formatFor(), undefined, requestControl);
    openIssue('Equipment / technical issue');
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The buzzers cut out.' } });
    fireEvent.click(screen.getByText('Save and request control'));

    await vi.waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith('equipment-technical', 'The buzzers cut out.'),
    );
  });

  test('Change type reveals the chooser without losing anything already entered', () => {
    renderScorer(formatFor(), undefined, vi.fn());
    openIssue('Equipment / technical issue');
    const dialog = screen.getByRole('dialog', { name: 'Issue / tournament control' });
    fireEvent.change(within(dialog).getByLabelText('What happened?'), {
      target: { value: 'Half a sentence so far' },
    });
    const control = within(dialog).getByLabelText('Ask tournament control to come') as HTMLInputElement;
    fireEvent.click(control);
    const controlBefore = control.checked;

    fireEvent.click(within(dialog).getByRole('button', { name: 'Change type' }));
    fireEvent.change(within(dialog).getByLabelText('Issue'), { target: { value: 'rules-question' } });

    expect((within(dialog).getByLabelText('Issue') as HTMLSelectElement).value).toBe('rules-question');
    expect((within(dialog).getByLabelText('What happened?') as HTMLTextAreaElement).value).toBe(
      'Half a sentence so far',
    );
    expect(
      (within(dialog).getByLabelText('Ask tournament control to come') as HTMLInputElement).checked,
    ).toBe(controlBefore);
  });

  test('a corrected category is the one that is used', async () => {
    const requestControl = vi.fn().mockResolvedValue({ kind: 'accepted', request: {} } as HelpRequestResult);
    renderScorer(formatFor(), undefined, requestControl);
    openIssue('Equipment / technical issue');
    fireEvent.click(screen.getByRole('button', { name: 'Change type' }));
    fireEvent.change(screen.getByLabelText('Issue'), { target: { value: 'rules-question' } });
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'A ruling needs a director.' },
    });
    fireEvent.click(screen.getByText('Save and request control'));

    await vi.waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith('rules-question', 'A ruling needs a director.'),
    );
  });
});

/**
 * A correction that landed, said out loud.
 *
 * The modal closes and the totals become different numbers, which is indistinguishable from a modal
 * that closed without saving. Both halves of the answer are temporary: being corrected is something
 * that happened to a question, not a property it now carries.
 */
describe('a historical correction lands visibly', () => {
  /** Reopen question one from Recent and rescore the buzz on it as `label`. */
  function correctQ1To(label: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Review question 1' }));
    const editor = screen.getByRole('dialog', { name: 'Edit Question 1' });
    const ruling = within(editor).getByLabelText('Ruling') as HTMLSelectElement;
    const option = Array.from(ruling.options).find((candidate) => candidate.textContent === label);
    if (!option) throw new Error(`No ruling option named "${label}"`);
    fireEvent.change(ruling, { target: { value: option.value } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }));
  }

  test('it says so, and points at the row it changed', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[0]); // +15
    fireEvent.click(screen.getByText('20'));

    correctQ1To('Correct (+10)');

    expect(screen.getByText('Question 1 corrected.')).toBeTruthy();
    const emphasised = document.querySelectorAll('.scorer-rail-item.is-emphasized');
    expect(emphasised).toHaveLength(1);
    expect(emphasised[0].textContent).toContain('Q1');
    // Nothing permanent is left behind: no badge, no mark, no colour.
    expect(emphasised[0].querySelector('.scorer-rail-mark')).toBeNull();
  });

  test('the emphasised row still opens the question', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[0]);
    fireEvent.click(screen.getByText('20'));
    correctQ1To('Correct (+10)');

    const emphasised = document.querySelector('.scorer-rail-item.is-emphasized') as HTMLElement;
    fireEvent.click(within(emphasised).getByRole('button', { name: 'Review question 1' }));

    expect(screen.getByRole('dialog', { name: 'Edit Question 1' })).toBeTruthy();
  });

  test('a refused correction is not called a success', () => {
    renderScorer(formatFor());
    fireEvent.click(buttonsFor('Sarah Mitchell')[0]);
    fireEvent.click(screen.getByText('20'));

    fireEvent.click(screen.getByRole('button', { name: 'Review question 1' }));
    const editor = screen.getByRole('dialog', { name: 'Edit Question 1' });
    // Somebody who was not on the floor for this team cannot have buzzed on it.
    fireEvent.change(within(editor).getByLabelText('Player'), { target: { value: 'Emma Turner' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }));

    expect(screen.queryByText('Question 1 corrected.')).toBeNull();
    expect(document.querySelectorAll('.scorer-rail-item.is-emphasized')).toHaveLength(0);
  });
});

/**
 * Messages that are receipts, and messages that are situations.
 *
 * The screen used to keep both forever, so a room accumulated a permanent line saying a substitution
 * from twenty minutes ago had worked — above the place the actual problems go. Timers here, because
 * the whole behaviour is about time; nothing waits on CSS and no duration is asserted beyond the one
 * this file owns.
 */
describe('operation notices', () => {
  function notice(): string | null {
    return document.querySelector('.scorer-banner.is-info')?.textContent ?? null;
  }

  test('the local recovery notice can be closed with its X', () => {
    renderScorer(formatFor(), undefined, undefined, undefined, undefined, {}, {}, true);

    expect(screen.getByText('Recovered the in-progress game saved on this device.')).toBeTruthy();
    const dismiss = screen.getByRole('button', { name: 'Dismiss recovery notice' });
    // The × is drawn by .scorer-notice-dismiss::before, so it is a class here rather than text.
    expect(dismiss.classList.contains('scorer-notice-dismiss')).toBe(true);
    expect(dismiss.textContent).toBe('');

    fireEvent.click(dismiss);

    expect(screen.queryByText('Recovered the in-progress game saved on this device.')).toBeNull();
  });

  test('the local recovery notice dismisses itself after fifteen seconds', () => {
    vi.useFakeTimers();
    try {
      renderScorer(formatFor(), undefined, undefined, undefined, undefined, {}, {}, true);

      act(() => {
        vi.advanceTimersByTime(recoveryNoticeMs - 1);
      });
      expect(screen.getByText('Recovered the in-progress game saved on this device.')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByText('Recovered the in-progress game saved on this device.')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('an acknowledgement goes away on its own', () => {
    vi.useFakeTimers();
    try {
      renderScorer(formatFor());
      pressControl('Players');
      addMissingPlayer('Ninety Six lineup', 'Alex Brown');
      expect(notice()).toBe('Added Alex Brown to the bench.');

      act(() => {
        vi.advanceTimersByTime(operationNoticeMs + 10);
      });

      expect(notice()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a newer acknowledgement gets its own full time on screen', () => {
    vi.useFakeTimers();
    try {
      renderScorer(formatFor());
      pressControl('Players');
      addMissingPlayer('Ninety Six lineup', 'Alex Brown');
      act(() => {
        vi.advanceTimersByTime(operationNoticeMs - 200);
      });

      pressControl('Players');
      addMissingPlayer('Ninety Six lineup', 'Casey Doyle');
      // The first one's time is up, and the second one is still there because its clock restarted.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(notice()).toBe('Added Casey Doyle to the bench.');

      act(() => {
        vi.advanceTimersByTime(operationNoticeMs);
      });
      expect(notice()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('it is announced without interrupting anybody', () => {
    renderScorer(formatFor());
    pressControl('Players');
    addMissingPlayer('Ninety Six lineup', 'Alex Brown');

    expect(document.querySelector('.scorer-banner.is-info')?.getAttribute('role')).toBe('status');
  });

  test('a rejected replacement stays discoverable as a warning', () => {
    vi.useFakeTimers();
    try {
      renderScorer(formatFor());
      fireEvent.click(screen.getByRole('button', { name: 'Game' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Replace question 1' }));
      const dialog = screen.getByRole('dialog', { name: 'Replace question 1' });
      fireEvent.change(within(dialog).getByLabelText('What went wrong?'), {
        target: { value: 'Wrong packet' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Whole cycle' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Replace question 1' }));

      act(() => {
        vi.advanceTimersByTime(operationNoticeMs * 3);
      });

      expect(screen.getByText('Nothing has been recorded on that question yet.')).toBeTruthy();
      expect(
        screen.getByText('Nothing has been recorded on that question yet.').closest('[role="alert"]'),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a rejected event is its own banner and is not swept up by the timer', () => {
    vi.useFakeTimers();
    try {
      renderScorer(formatFor());
      // Replacing a cycle nothing has been recorded on: the engine refuses it outright.
      fireEvent.click(screen.getByRole('button', { name: 'Game' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Replace question 1' }));
      const dialog = screen.getByRole('dialog', { name: 'Replace question 1' });
      fireEvent.change(within(dialog).getByLabelText('What went wrong?'), {
        target: { value: 'Wrong packet' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Whole cycle' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Replace question 1' }));
      expect(screen.getByText('Nothing has been recorded on that question yet.')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(operationNoticeMs * 3);
      });

      // Still there: `events.rejection` has its own state and its own reason to disappear, and the
      // notice timer knows nothing about it.
      expect(screen.getByText('Nothing has been recorded on that question yet.')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('an outstanding room summons is not cleared by an acknowledgement expiring over it', () => {
    vi.useFakeTimers();
    try {
      const outstanding: ControlRequestState = {
        kind: 'outstanding',
        request: { id: 'help-9', category: 'question-packet', message: 'The buzzers cut out.' },
        requestedAt: '2026-08-11T14:42:00.000Z',
        requestedAtSource: 'server',
      };
      renderScorer(
        formatFor(),
        undefined,
        undefined,
        undefined,
        undefined,
        {},
        { controlRequest: outstanding },
      );
      pressControl('Players');
      addMissingPlayer('Ninety Six lineup', 'Alex Brown');

      act(() => {
        vi.advanceTimersByTime(operationNoticeMs + 10);
      });

      expect(screen.queryByText('Added Alex Brown to the bench.')).toBeNull();
      expect(screen.getByText(/Tournament control requested/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * The other side of the same split. With no `controlRequest` supplied there is no banner that owns
   * the network fact, so this screen keeps it — and a message a scorekeeper has to act on is a
   * warning that interrupts, not a receipt that waits its turn.
   */
  test('a control failure nothing else owns is a warning that interrupts', async () => {
    const requestControl = vi.fn().mockResolvedValue({
      kind: 'unreachable',
      error: 'Tournament control did not answer.',
    } satisfies HelpRequestResult);
    vi.useFakeTimers();
    try {
      renderScorer(formatFor(), undefined, requestControl);
      openIssue();
      fireEvent.change(screen.getByLabelText('What happened?'), {
        target: { value: 'The room lost Wi-Fi.' },
      });
      fireEvent.click(screen.getByText('Save and request control'));

      await vi.waitFor(() => expect(document.querySelector('.scorer-banner.is-warning')).toBeTruthy());
      const banner = document.querySelector('.scorer-banner.is-warning');
      expect(banner?.getAttribute('role')).toBe('alert');
      expect(banner?.textContent).toBe('Issue saved, but tournament control was not reached.');

      // And it is a situation rather than an acknowledgement, so it does not clear itself.
      act(() => {
        vi.advanceTimersByTime(operationNoticeMs * 3);
      });
      expect(document.querySelector('.scorer-banner.is-warning')?.textContent).toBe(
        'Issue saved, but tournament control was not reached.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * When the room models the control request, its banner is the persistent copy of a network
   * failure. Two permanent lines about one problem, with two places to clear it, is how a room ends
   * up ignoring both.
   */
  test('a control failure the room already owns is not copied into a second permanent warning', async () => {
    const requestControl = vi.fn().mockResolvedValue({
      kind: 'unreachable',
      error: 'Tournament control did not answer.',
    } satisfies HelpRequestResult);
    renderScorer(
      formatFor(),
      undefined,
      requestControl,
      undefined,
      undefined,
      {},
      {
        controlRequest: { kind: 'unavailable' },
      },
    );
    openIssue();
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The room lost Wi-Fi.' } });
    fireEvent.click(screen.getByText('Save and request control'));

    // The local fact, which is the half this screen is authoritative about and the half that is
    // finished. The network fact belongs to `controlRequest`, which renders it with the retry.
    await vi.waitFor(() => expect(screen.getByText('Issue saved on the scoresheet.')).toBeTruthy());
    expect(screen.queryByText('Issue saved, but tournament control was not reached.')).toBeNull();
  });
});
