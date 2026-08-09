/**
 * @vitest-environment jsdom
 */

/**
 * Starters, substitutions and late arrivals, driven the way a scorekeeper drives them.
 *
 * The event model underneath is unchanged and deliberately so: a substitution stores the complete
 * lineup effective at a question boundary, which is what makes tossups heard exact and what makes a
 * reload able to reconstruct who was on the floor for question eleven. What changed is that a
 * scorekeeper no longer has to *compose* that lineup out of checkboxes to record the one thing that
 * actually happens in a game, which is one player for another.
 *
 * So the tests are in two halves: the workflow a scorekeeper sees, and the event it produces. The
 * second half is the one that matters to the standings.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import ScorerHost from '../src/scorer/ScorerHost';
import { RoomConnectionState } from '../src/app/ConnectionState';
import { IRoomProcedure, roomProcedureVersion } from '../src/scoring/RoomProcedure';
import { substitutionSentence } from '../src/scorer/StartingLineupPrompt';
import { loadGame } from '../src/scorer/GameSession';
import { ScoreEvent } from '../src/scoring/ScoreEvents';

const leftTeam = {
  name: 'Ninety Six',
  players: [{ name: 'Sarah Jones' }, { name: 'Michael Smith' }, { name: 'Jordan Hall' }],
};
const rightTeam = { name: 'Greenwood', players: [{ name: 'Emma Turner' }, { name: 'Taylor Adams' }] };

function formatFor(maximumActive: number): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = maximumActive;
  return scoringRulesToScorekeeperFormat(rules);
}

let gameCounter = 0;
let gameKey = '';

function renderScorer(format: IScorekeeperFormat, procedure?: IRoomProcedure) {
  gameCounter += 1;
  gameKey = `lineup-game-${gameCounter}`;
  render(
    <ScorerHost
      gameKey={gameKey}
      format={format}
      leftTeam={leftTeam}
      rightTeam={rightTeam}
      tournamentName="Ninety Six Invitational"
      roundName="Round 4"
      roomName="Room 204"
      procedure={procedure}
      connection={RoomConnectionState.Connected}
      onDownload={() => undefined}
      onSubmit={vi.fn().mockResolvedValue({ ok: true, message: 'Sent' })}
    />,
  );
}

/** Every event this game has recorded, read back the way a reload would read it. */
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
  for (const name of names) fireEvent.click(within(prompt).getByLabelText(name));
  fireEvent.click(within(prompt).getByText('Start game'));
}

function openPlayers() {
  fireEvent.click(screen.getByRole('button', { name: 'Players' }));
}

function buzz(player: string, index: number) {
  const buttons = screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-label')?.startsWith(player));
  fireEvent.click(buttons[index]);
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

describe('who is starting', () => {
  test('a roster bigger than the floor has to be answered before anything can be scored', () => {
    renderScorer(formatFor(2));

    expect(screen.getByLabelText('Starting lineups')).toBeTruthy();
    // Nothing to score against until the question is answered.
    expect(screen.queryByLabelText('Ninety Six score')).toBeNull();
  });

  test('a roster that fits on the floor is never asked', () => {
    renderScorer(formatFor(3));

    expect(screen.queryByLabelText('Starting lineups')).toBeNull();
    expect(screen.getByLabelText('Ninety Six score')).toBeTruthy();
  });

  test('the count comes from the format rather than from a constant', () => {
    renderScorer(formatFor(2));

    expect(screen.getAllByText('0 of 2 selected').length).toBeGreaterThan(0);
    cleanup();

    renderScorer(formatFor(1));
    expect(screen.getAllByText('0 of 1 selected').length).toBeGreaterThan(0);
  });

  test('the starters chosen are the ones charged with tossups heard from question one', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Michael Smith', 'Jordan Hall']);
    buzz('Michael Smith', 1);

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    // Sarah started on the bench, so the tossup she was not on the floor for is not hers.
    expect(within(lineup).getByText('Sarah Jones').closest('li')?.textContent).toContain('0 TUH');
    expect(within(lineup).getByText('Michael Smith').closest('li')?.textContent).toContain('1 TUH');
  });
});

describe('what the starting prompt promises about the bench', () => {
  test('the permissive default says substitutions happen between tossups', () => {
    expect(substitutionSentence(undefined)).toContain('between any two tossups');
  });

  test('a restrictive procedure is not told a rule it does not have', () => {
    const restrictive: IRoomProcedure = {
      version: roomProcedureVersion,
      halves: true,
      timeoutsPerTeam: 1,
      substitutionPolicy: 'breaks-timeouts-overtime',
    };

    const sentence = substitutionSentence(restrictive);
    expect(sentence).not.toContain('between any two tossups');
    expect(sentence).toContain('halftime');
  });

  test('the prompt itself uses the configured sentence', () => {
    renderScorer(formatFor(2), {
      version: roomProcedureVersion,
      halves: true,
      timeoutsPerTeam: 1,
      substitutionPolicy: 'breaks-timeouts-overtime',
    });

    const prompt = screen.getByLabelText('Starting lineups');
    expect(within(prompt).queryByText(/between any two tossups/)).toBeNull();
  });
});

describe('one player for another', () => {
  test('three clicks produce the complete lineup effective at the next question', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    buzz('Sarah Jones', 1); // a power on tossup 1, so the change lands on tossup 2

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    const sarahRow = within(lineup).getByText('Sarah Jones').closest('li') as HTMLElement;
    fireEvent.click(within(sarahRow).getByText('Sub out'));
    fireEvent.click(within(lineup).getByText('Put in'));
    expect(within(lineup).getByText('Effective starting Tossup 2')).toBeTruthy();
    fireEvent.click(within(lineup).getByText('Confirm'));

    // What is stored is still the whole lineup, which is what makes TUH exact.
    const [, change] = substitutions().filter((event) => event.team === 'left');
    expect(change.questionNumber).toBe(2);
    expect(change.activePlayers.slice().sort()).toEqual(['Jordan Hall', 'Michael Smith']);
  });

  test('tossups heard split at the substitution', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    // Finish tossup one, bonus and all, so the substitution lands on a clean boundary.
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));

    openPlayers();
    let lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(within(lineup).getByText('Sarah Jones').closest('li') as HTMLElement).getByText('Sub out'));
    fireEvent.click(within(lineup).getByText('Put in'));
    fireEvent.click(within(lineup).getByText('Confirm'));

    // Tossup two, played by the new lineup.
    buzz('Michael Smith', 1);
    fireEvent.click(screen.getByText('20'));

    openPlayers();
    lineup = screen.getByLabelText('Ninety Six lineup');
    expect(within(lineup).getByText('Sarah Jones').closest('li')?.textContent).toContain('1 TUH');
    expect(within(lineup).getByText('Michael Smith').closest('li')?.textContent).toContain('2 TUH');
    expect(within(lineup).getByText('Jordan Hall').closest('li')?.textContent).toContain('1 TUH');
  });

  test('a full seat offers Sub out rather than an unusable Put in', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    const benchRow = within(lineup).getByText('Jordan Hall').closest('li') as HTMLElement;
    expect(within(benchRow).getByText('Put in').hasAttribute('disabled')).toBe(true);
    expect(within(lineup).getAllByText('Sub out').length).toBe(2);
  });

  test('the full lineup editor is still there for a multi-player change', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Edit full lineup…'));
    fireEvent.click(within(lineup).getByLabelText(/Sarah Jones/));
    fireEvent.click(within(lineup).getByLabelText(/Michael Smith/));
    fireEvent.click(within(lineup).getByLabelText(/Jordan Hall/));
    fireEvent.click(within(lineup).getByText('Apply lineup'));

    const change = substitutions()
      .filter((event) => event.team === 'left')
      .at(-1);
    expect(change?.activePlayers).toEqual(['Jordan Hall']);
  });
});

describe('a procedure that does not allow substitutions right now', () => {
  const restrictive: IRoomProcedure = {
    version: roomProcedureVersion,
    halves: true,
    timeoutsPerTeam: 1,
    substitutionPolicy: 'breaks-timeouts-overtime',
  };

  test('the roster can be read, but nothing can be changed, and the reason is given', () => {
    renderScorer(formatFor(2), restrictive);
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    expect(within(lineup).getByText('Sarah Jones')).toBeTruthy();
    expect(
      within(lineup)
        .getAllByText('Sub out')
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
    expect(screen.getByText(/halftime, timeouts, and phase checkpoints/)).toBeTruthy();
  });
});

describe('somebody who turned up late', () => {
  test('adding to the roster and putting them on are separate decisions', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Add missing player…'));
    // The team is full, so the panel says where they are going rather than silently benching them.
    expect(within(lineup).getByText(/join the bench/)).toBeTruthy();
    fireEvent.change(within(lineup).getByLabelText('Player name'), { target: { value: 'Alex Brown' } });
    fireEvent.click(within(lineup).getByText('Add to roster'));

    const events = savedEvents();
    expect(events.some((event) => event.type === 'roster-add' && event.playerName === 'Alex Brown')).toBe(true);
    // No lineup change was made, so none was recorded: a substitution nobody made would corrupt TUH.
    expect(substitutions().filter((event) => event.team === 'left').length).toBe(1);
  });

  test('a free seat puts them straight on, effective from the current question', () => {
    // Four seats and three players, so there is somewhere for a late arrival to go.
    renderScorer(formatFor(4));
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Add missing player…'));
    expect(within(lineup).getByText(/from Tossup 2/)).toBeTruthy();
    fireEvent.change(within(lineup).getByLabelText('Player name'), { target: { value: 'Alex Brown' } });
    fireEvent.click(within(lineup).getByText('Add to roster'));

    const change = substitutions()
      .filter((event) => event.team === 'left')
      .at(-1);
    expect(change?.questionNumber).toBe(2);
    expect(change?.activePlayers).toContain('Alex Brown');
  });
});
