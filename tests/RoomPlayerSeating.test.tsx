/**
 * @vitest-environment jsdom
 */

/**
 * Arranging the rows to match the table.
 *
 * Two things are being checked, and the second is the one that matters. The first is that the room
 * can put its players in the order the people are actually sitting in, and that each row carries the
 * seat number a paper scoresheet would give it. The second is that doing so touches nothing else:
 * no ScoreEvent, no tossups heard, no QBJ. A seating preference that could reach the scoresheet
 * would be a way for a cosmetic choice to change a result.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import ScorerHost from '../src/scorer/ScorerHost';
import { RoomConnectionState } from '../src/app/ConnectionState';
import { loadGame } from '../src/scorer/GameSession';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import {
  applyOrder,
  loadSeating,
  moveWithin,
  orderBySeating,
  playerSeatingMaxAgeMs,
  saveSeating,
  takeSeat,
} from '../src/scorer/PlayerSeating';

const leftTeam = {
  name: 'Ninety Six',
  players: [{ name: 'Sarah Jones' }, { name: 'Michael Smith' }, { name: 'Alex Brown' }, { name: 'Jordan Hall' }],
};
const rightTeam = { name: 'Greenwood', players: [{ name: 'Emma Turner' }, { name: 'Taylor Adams' }] };

function formatFor(maximumActive: number): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = maximumActive;
  return scoringRulesToScorekeeperFormat(rules);
}

let gameCounter = 0;
let gameKey = '';

/**
 * Four on the roster and three seats, so there is a bench to substitute from and a starting-lineup
 * question to answer first. `chooseStarters` answers it the way a scorekeeper would.
 */
function renderScorer(maximumActive = 3, starters: string[] = ['Sarah Jones', 'Michael Smith', 'Alex Brown']) {
  gameCounter += 1;
  gameKey = `seating-game-${gameCounter}`;
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
  const prompt = screen.queryByLabelText('Starting lineups');
  if (prompt) {
    for (const name of starters) fireEvent.click(within(prompt).getByLabelText(name));
    fireEvent.click(within(prompt).getByText('Start game'));
  }
}

/** The scoring screen's roster for one team, top to bottom. */
function rosterOnScreen(teamName: string): string[] {
  return Array.from(screen.getByLabelText(teamName).querySelectorAll('.scorer-player-name'), (node) =>
    (node.textContent ?? '').trim(),
  );
}

function seatNumbers(teamName: string): string[] {
  return Array.from(screen.getByLabelText(teamName).querySelectorAll('.scorer-player-seat'), (node) =>
    (node.textContent ?? '').trim(),
  );
}

function openPlayers() {
  fireEvent.click(screen.getByRole('button', { name: 'Players' }));
}

function savedEvents(): ScoreEvent[] {
  return loadGame(gameKey)?.events ?? [];
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

describe('the numbers beside the names', () => {
  test('each player on the floor is numbered by their seat', () => {
    renderScorer();

    expect(rosterOnScreen('Ninety Six')).toEqual(['Sarah Jones', 'Michael Smith', 'Alex Brown']);
    expect(seatNumbers('Ninety Six')).toEqual(['1', '2', '3']);
    // Each team has its own column numbering, as a scoresheet does.
    expect(seatNumbers('Greenwood')).toEqual(['1', '2']);
  });

  test('the number is the seat, so it stays with the position when somebody is replaced', () => {
    renderScorer();
    openPlayers();

    const lineup = screen.getByLabelText('Ninety Six lineup');
    const secondSeat = within(lineup).getByText('Michael Smith').closest('li') as HTMLElement;
    fireEvent.click(within(secondSeat).getByText('Replace'));
    fireEvent.click(within(lineup).getByText('Jordan Hall')); // the only bench player
    fireEvent.click(within(lineup).getByText('Confirm'));

    // The replacement sits down where the outgoing player stood up: still the second row.
    expect(rosterOnScreen('Ninety Six')).toEqual(['Sarah Jones', 'Jordan Hall', 'Alex Brown']);
    expect(seatNumbers('Ninety Six')).toEqual(['1', '2', '3']);
  });
});

describe('rearranging the rows', () => {
  test('a player can be moved up, and the scoring screen follows', () => {
    renderScorer();
    openPlayers();

    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Reorder'));
    fireEvent.click(within(lineup).getByLabelText('Move Alex Brown up'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(rosterOnScreen('Ninety Six')).toEqual(['Sarah Jones', 'Alex Brown', 'Michael Smith']);
  });

  test('the ends of the list cannot be moved off it', () => {
    renderScorer();
    openPlayers();

    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Reorder'));
    expect(within(lineup).getByLabelText('Move Sarah Jones up').hasAttribute('disabled')).toBe(true);
    expect(within(lineup).getByLabelText('Move Alex Brown down').hasAttribute('disabled')).toBe(true);
  });

  test('the arrangement survives a reload of the same game', () => {
    renderScorer();
    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Reorder'));
    fireEvent.click(within(lineup).getByLabelText('Move Alex Brown up'));

    const reopened = gameKey;
    cleanup();
    // The same game key: the saved lineup comes back with it, so no starters are asked for again.
    render(
      <ScorerHost
        gameKey={reopened}
        format={formatFor(3)}
        leftTeam={leftTeam}
        rightTeam={rightTeam}
        tournamentName="Ninety Six Invitational"
        roundName="Round 4"
        connection={RoomConnectionState.Connected}
        onDownload={() => undefined}
        onSubmit={vi.fn().mockResolvedValue({ ok: true, message: 'Sent' })}
      />,
    );

    expect(rosterOnScreen('Ninety Six')).toEqual(['Sarah Jones', 'Alex Brown', 'Michael Smith']);
  });

  test('a single player on the floor has nothing to reorder', () => {
    renderScorer(1, ['Sarah Jones', 'Emma Turner']);
    openPlayers();

    expect(screen.queryByText('Reorder')).toBeNull();
    expect(screen.queryByLabelText('Move Sarah Jones up')).toBeNull();
  });
});

describe('what rearranging must not touch', () => {
  test('it writes no scoring event at all', () => {
    renderScorer();
    // Score something first, so there is a history for a stray event to appear in.
    const buzzButtons = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-label')?.startsWith('Sarah Jones'));
    fireEvent.click(buzzButtons[1]);
    fireEvent.click(screen.getByText('20'));
    const before = savedEvents();

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Reorder'));
    fireEvent.click(within(lineup).getByLabelText('Move Alex Brown up'));

    // Byte for byte the same history. The starting lineup is a substitution event and stays the
    // only one; rearranging the rows adds nothing beside it.
    expect(savedEvents()).toEqual(before);
    expect(savedEvents().filter((event) => event.type === 'substitution').length).toBe(
      before.filter((event) => event.type === 'substitution').length,
    );
  });

  test('tossups heard are unchanged by it', () => {
    renderScorer();
    const buzzButtons = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-label')?.startsWith('Sarah Jones'));
    fireEvent.click(buzzButtons[1]);
    fireEvent.click(screen.getByText('20'));

    openPlayers();
    let lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Reorder'));
    fireEvent.click(within(lineup).getByLabelText('Move Alex Brown up'));
    lineup = screen.getByLabelText('Ninety Six lineup');

    // Everybody on the floor heard the tossup, wherever their row now is.
    for (const name of ['Sarah Jones', 'Michael Smith', 'Alex Brown']) {
      expect(within(lineup).getByText(name).closest('li')?.textContent).toContain('1 TUH');
    }
  });
});

describe('the ordering rules themselves', () => {
  const roster = ['Sarah', 'Michael', 'Alex', 'Jordan'];

  test('names the preference does not mention keep their roster order, at the end', () => {
    expect(orderBySeating(roster, ['Alex'], (name) => name)).toEqual(['Alex', 'Sarah', 'Michael', 'Jordan']);
  });

  test('moving past either end is a no-op rather than a wrap', () => {
    expect(moveWithin(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveWithin(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveWithin(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
  });

  test('reordering the players on the floor leaves the bench where it was', () => {
    // Jordan is benched and stays in his place while the other three are rearranged around him.
    expect(applyOrder([], roster, ['Alex', 'Sarah', 'Michael'])).toEqual(['Alex', 'Sarah', 'Michael', 'Jordan']);
  });

  test('a substitute takes the outgoing player’s place', () => {
    expect(takeSeat([], roster, 'Michael', 'Jordan')).toEqual(['Sarah', 'Jordan', 'Michael', 'Alex']);
  });

  test('a preference older than a tournament day is not applied', () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    };
    const saved = new Date('2026-08-08T10:00:00.000Z');
    saveSeating('game-1', { left: ['Alex'], right: [] }, saved, storage);

    expect(loadSeating('game-1', new Date(saved.getTime() + 1000), storage).left).toEqual(['Alex']);
    expect(loadSeating('game-1', new Date(saved.getTime() + playerSeatingMaxAgeMs + 1000), storage).left).toEqual([]);
  });

  test('a corrupt preference degrades to no preference rather than taking the game down', () => {
    const storage = {
      getItem: () => 'not json',
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    expect(loadSeating('game-1', new Date(), storage)).toEqual({ left: [], right: [] });
  });
});
