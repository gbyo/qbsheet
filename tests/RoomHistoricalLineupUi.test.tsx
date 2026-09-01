/**
 * @vitest-environment jsdom
 */

/**
 * Correcting who was playing, hours after they were.
 *
 * This is the same question the live editors ask — who is on the floor — asked about a boundary that
 * has already been played through, which is what makes it a different screen. It has no seat numbers,
 * because the seats belonged to a Chromebook in a room that has since been packed away and printing
 * one here would invite somebody to correct it. It has no reorder controls for the same reason. And
 * it says Playing and Bench rather than Start and Bench, because a substitution corrected to take
 * effect at tossup eight is not a claim about the start of anything.
 *
 * The part with teeth is the roster boundary. A roster grows during a game, and a lineup moved back
 * before somebody's arrival cannot contain them: offering that as an ordinary choice would let a
 * scorekeeper build a history the validator will then refuse, from a dialog that had just presented
 * it as normal.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import ScorerHost from '../src/scorer/ScorerHost';
import { rememberScoringLayoutChoice } from '../src/scorer/scoringLayoutPrompt';
import { RoomConnectionState } from '../src/app/ConnectionState';
import { loadGame } from '../src/scorer/GameSession';
import { ScoreEvent } from '../src/scoring/ScoreEvents';

const leftTeam = {
  name: 'Ninety Six',
  players: [{ name: 'Sarah Jones' }, { name: 'James Robinson' }, { name: 'Olivia Hart' }],
};
const rightTeam = { name: 'Greenwood', players: [{ name: 'Emma Turner' }, { name: 'Taylor Adams' }] };

let gameCounter = 0;
let gameKey = '';

function formatFor(maximumActive: number): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = maximumActive;
  return scoringRulesToScorekeeperFormat(rules);
}

function renderScorer(maximumActive = 2) {
  gameCounter += 1;
  gameKey = `historical-lineup-${gameCounter}`;
  rememberScoringLayoutChoice(gameKey);
  render(
    <ScorerHost
      gameKey={gameKey}
      format={formatFor(maximumActive)}
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

function savedEvents(): ScoreEvent[] {
  return loadGame(gameKey)?.events ?? [];
}

function substitutions(): Extract<ScoreEvent, { type: 'substitution' }>[] {
  return savedEvents().filter(
    (event): event is Extract<ScoreEvent, { type: 'substitution' }> => event.type === 'substitution',
  );
}

function chooseStarters(names: string[]) {
  const prompt = screen.getByLabelText('Starting lineups');
  for (const name of names) {
    const roster = [leftTeam, rightTeam].find((team) => team.players.some((player) => player.name === name));
    if (!roster) throw new Error(`No test roster contains ${name}`);
    const team = within(prompt).getByLabelText(`${roster.name} starters`);
    fireEvent.click(within(team).getByRole('button', { name: `Start ${name}` }));
  }
  fireEvent.click(within(prompt).getByText('Start game'));
}

function buzz(player: string, index: number) {
  const buttons = screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-label')?.startsWith(player));
  fireEvent.click(buttons[index]);
}

/** Add somebody to the roster mid-game, which is what makes a roster boundary exist at all. */
function addLatePlayer(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Players' }));
  const lineup = screen.getByLabelText('Ninety Six lineup');
  fireEvent.click(within(lineup).getByText('+ Add player'));
  fireEvent.change(within(lineup).getByLabelText('Player name'), { target: { value: name } });
  fireEvent.click(within(lineup).getByText('Add'));
}

function openReview() {
  fireEvent.click(screen.getByRole('button', { name: 'Game' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Full scoresheet review' }));
}

/** Open the inline editor on the historical event whose description contains `text`. */
function editEvent(text: string): HTMLElement {
  const row = Array.from(document.querySelectorAll('.scorer-review-event')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!row) throw new Error(`No scoresheet entry reading "${text}"`);
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Edit' }));
  return (row as HTMLElement).querySelector('.scorer-event-edit') as HTMLElement;
}

function groupNames(editor: HTMLElement, heading: string): string[] {
  const groups = Array.from(editor.querySelectorAll('.scorer-lineup-group'));
  const list = groups.find((candidate) => candidate.textContent === heading)?.nextElementSibling;
  if (list?.tagName !== 'UL') return [];
  return Array.from(list.querySelectorAll('.scorer-lineup-name')).map((name) => name.textContent ?? '');
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

describe('the historical lineup editor', () => {
  test('it is two lists of people, not a column of checkboxes', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');

    expect(editor.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(within(editor).queryByText('Active players')).toBeNull();
    expect(groupNames(editor, 'Playing')).toEqual(['Sarah Jones', 'James Robinson']);
    expect(groupNames(editor, 'Bench')).toEqual(['Olivia Hart']);
  });

  test('it says Playing and Bench, not Starting and Start', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');

    // A substitution may become effective at tossup eight, so nothing here claims to be a start.
    expect(within(editor).getByRole('button', { name: 'Bench Sarah Jones' })).toBeTruthy();
    expect(within(editor).getByRole('button', { name: 'Put Olivia Hart in' })).toBeTruthy();
    expect(within(editor).queryByRole('button', { name: /^Start / })).toBeNull();
  });

  test('there are no seat numbers and nothing that reorders', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');

    // A seat is a fact about a device in a room, not about scoring history.
    expect(editor.querySelectorAll('.scorer-lineup-seat')).toHaveLength(0);
    expect(within(editor).queryByLabelText(/Move .* up/)).toBeNull();
    expect(within(editor).queryByLabelText(/Move .* down/)).toBeNull();
  });

  test('the effective tossup field is still there and still decides the boundary', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');

    const boundary = within(editor).getByLabelText('Effective tossup');
    expect((boundary as HTMLInputElement).value).toBe('1');
    fireEvent.change(boundary, { target: { value: '3' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save correction' }));

    expect(substitutions().find((event) => event.team === 'left')?.questionNumber).toBe(3);
  });

  test('a player the roster gained later is not offered at an earlier boundary', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));
    // Tossup two, so Priya joins the roster at the tossup-two boundary and not before it.
    addLatePlayer('Priya Raman');

    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');

    expect(groupNames(editor, 'Bench')).toEqual(['Olivia Hart']);
    expect(within(editor).queryByRole('button', { name: 'Put Priya Raman in' })).toBeNull();
  });

  test('moving the boundary forward makes that player available', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));
    addLatePlayer('Priya Raman');

    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');
    fireEvent.change(within(editor).getByLabelText('Effective tossup'), { target: { value: '2' } });

    expect(groupNames(editor, 'Bench')).toEqual(['Olivia Hart', 'Priya Raman']);
    expect(within(editor).getByRole('button', { name: 'Put Priya Raman in' })).toBeTruthy();
  });

  test('Bench and Put in compose the lineup, and the recorded order survives a change of mind', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');

    // Out and back in is not a reorder: the event must still read in the order it already did.
    fireEvent.click(within(editor).getByRole('button', { name: 'Bench Sarah Jones' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Put Sarah Jones in' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save correction' }));

    expect(substitutions().find((event) => event.team === 'left')?.activePlayers).toEqual([
      'Sarah Jones',
      'James Robinson',
    ]);
  });

  test('one swap writes the corrected lineup', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');

    fireEvent.click(within(editor).getByRole('button', { name: 'Bench James Robinson' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Put Olivia Hart in' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save correction' }));

    expect(substitutions().find((event) => event.team === 'left')?.activePlayers).toEqual([
      'Sarah Jones',
      'Olivia Hart',
    ]);
  });

  test('the format cap is enforced by withholding the action', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');

    expect(within(editor).getByRole('button', { name: 'Put Olivia Hart in' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(within(editor).getByRole('button', { name: 'Bench Sarah Jones' }));
    expect(within(editor).getByRole('button', { name: 'Put Olivia Hart in' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  test('a row that crossed between groups is marked, by the same helper the lineup screens use', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');

    fireEvent.click(within(editor).getByRole('button', { name: 'Bench James Robinson' }));

    const moved = editor.querySelectorAll('.scorer-lineup-entry.is-moved');
    expect(moved).toHaveLength(1);
    expect(moved[0].querySelector('.scorer-lineup-name')?.textContent).toBe('James Robinson');
  });

  /*
   * The editor keeps a scorekeeper out of histories that cannot have happened; it does not become
   * the authority on whether one did. That stays with the derived game and the scoresheet validator,
   * which is what the review list is already showing.
   */
  test('a correction that contradicts what was scored is still called out', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));

    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');
    fireEvent.click(within(editor).getByRole('button', { name: 'Bench Sarah Jones' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Put Olivia Hart in' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save correction' }));

    // Sarah buzzed on a tossup the lineup now says she was not playing.
    expect(screen.getByText(/Sarah Jones was not active/)).toBeTruthy();
  });

  /*
   * Withholding the row is not enough on its own. The boundary and the membership are two fields
   * that can each be edited after the other, so moving the boundary forward, putting somebody on,
   * and moving it back again reaches the same impossible lineup by a different route.
   */
  test('a player put on at a later boundary cannot be carried back before they were rostered', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));
    addLatePlayer('Priya Raman');

    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');
    fireEvent.change(within(editor).getByLabelText('Effective tossup'), { target: { value: '2' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Bench James Robinson' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Put Priya Raman in' }));
    // Back before she existed on the roster.
    fireEvent.change(within(editor).getByLabelText('Effective tossup'), { target: { value: '1' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save correction' }));

    expect(
      within(editor).getByText(
        'Priya Raman was not on the roster at Tossup 1. Take them off, or move the tossup later.',
      ),
    ).toBeTruthy();
    // Nothing was written, and the lineup on record is the one it always was.
    expect(substitutions().find((event) => event.team === 'left')?.activePlayers).toEqual([
      'Sarah Jones',
      'James Robinson',
    ]);
    expect(substitutions().find((event) => event.team === 'left')?.questionNumber).toBe(1);
  });

  test('either way out of that refusal saves', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));
    addLatePlayer('Priya Raman');

    openReview();
    const editor = editEvent('Before Tossup 1, lineup changed');
    fireEvent.change(within(editor).getByLabelText('Effective tossup'), { target: { value: '2' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Bench James Robinson' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Put Priya Raman in' }));

    // Moving the tossup past her arrival is one of them, and it is the lineup as edited.
    fireEvent.click(within(editor).getByRole('button', { name: 'Save correction' }));
    expect(substitutions().find((event) => event.team === 'left')?.activePlayers).toEqual([
      'Sarah Jones',
      'Priya Raman',
    ]);
    expect(substitutions().find((event) => event.team === 'left')?.questionNumber).toBe(2);
  });

  test('a name the roster had not reached yet is shown rather than hidden, so it can be taken off', () => {
    renderScorer();
    chooseStarters(['Sarah Jones', 'James Robinson']);
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));
    addLatePlayer('Priya Raman');

    // Put Priya into the tossup-two lineup, then move that lineup back before she was rostered.
    openReview();
    let editor = editEvent('Before Tossup 1, lineup changed');
    fireEvent.change(within(editor).getByLabelText('Effective tossup'), { target: { value: '2' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Bench James Robinson' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Put Priya Raman in' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save correction' }));

    editor = editEvent('Before Tossup 2, lineup changed');
    fireEvent.change(within(editor).getByLabelText('Effective tossup'), { target: { value: '1' } });

    // Still on screen, still under Playing, and now saying why it cannot be right.
    expect(groupNames(editor, 'Playing')).toContain('Priya Raman');
    expect(within(editor).getByText('not on the roster until Tossup 2')).toBeTruthy();
    expect(within(editor).getByRole('button', { name: 'Bench Priya Raman' })).toBeTruthy();
  });
});
