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

function renderScorer(
  format: IScorekeeperFormat,
  procedure?: IRoomProcedure,
  rosterOptions: {
    authoritative?: boolean;
    onSyncRosterPlayer?: (teamName: string, playerName: string) => Promise<{ ok: boolean }>;
  } = {},
) {
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
      authoritativeLeftTeam={rosterOptions.authoritative ? leftTeam : undefined}
      authoritativeRightTeam={rosterOptions.authoritative ? rightTeam : undefined}
      onSyncRosterPlayer={rosterOptions.onSyncRosterPlayer}
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

  test('a newly added player appears immediately, stays unselected, and can then be chosen to start', () => {
    renderScorer(formatFor(2));
    const team = screen.getByLabelText('Ninety Six starters');

    fireEvent.click(within(team).getByText('+ Add player'));
    const input = within(team).getByLabelText('Player name');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'Alex Brown' } });
    fireEvent.click(within(team).getByText('Add'));

    const added = within(team).getByLabelText('Alex Brown') as HTMLInputElement;
    expect(added.checked).toBe(false);
    expect(savedEvents().filter((event) => event.type === 'roster-add').map((event) => event.playerName)).toEqual([
      'Alex Brown',
    ]);

    fireEvent.click(within(team).getByLabelText('Michael Smith'));
    fireEvent.click(added);
    fireEvent.click(within(screen.getByLabelText('Starting lineups')).getByText('Start game'));

    expect(substitutions().find((event) => event.team === 'left')?.activePlayers).toEqual([
      'Michael Smith',
      'Alex Brown',
    ]);
  });

  test('adding to a settled team leaves its existing starters unchanged', () => {
    renderScorer(formatFor(2));
    const settledTeam = screen.getByLabelText('Greenwood starters');

    expect((within(settledTeam).getByLabelText('Emma Turner') as HTMLInputElement).checked).toBe(true);
    expect((within(settledTeam).getByLabelText('Taylor Adams') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(settledTeam).getByText('+ Add player'));
    fireEvent.change(within(settledTeam).getByLabelText('Player name'), { target: { value: 'Casey Reed' } });
    fireEvent.click(within(settledTeam).getByText('Add'));

    const added = within(settledTeam).getByLabelText(/Casey Reed/) as HTMLInputElement;
    expect(added.checked).toBe(false);
    expect(added.disabled).toBe(true);
    chooseStarters(['Sarah Jones', 'Michael Smith']);

    expect(substitutions().some((event) => event.team === 'right')).toBe(false);
    openPlayers();
    const lineup = screen.getByLabelText('Greenwood lineup');
    expect(within(lineup).getByText('Emma Turner').closest('li')?.parentElement?.previousElementSibling?.textContent).toBe(
      'Playing',
    );
    expect(within(lineup).getByText('Casey Reed').closest('li')?.parentElement?.previousElementSibling?.textContent).toBe(
      'Bench',
    );
  });

  test('blank and duplicate names are rejected by the shared roster validation', () => {
    renderScorer(formatFor(2));
    const team = screen.getByLabelText('Ninety Six starters');
    fireEvent.click(within(team).getByText('+ Add player'));
    const input = within(team).getByLabelText('Player name');
    const add = within(team).getByText('Add');

    fireEvent.change(input, { target: { value: '   ' } });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(within(team).getByText('Enter a player name.')).toBeTruthy();
    fireEvent.change(input, { target: { value: '  SARAH JONES  ' } });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(within(team).getByText(/already on this roster/)).toBeTruthy();
    expect(savedEvents().some((event) => event.type === 'roster-add')).toBe(false);
  });

  test('a connected starting-lineup addition uses the ordinary authoritative roster sync', async () => {
    const sync = vi.fn().mockResolvedValue({ ok: true });
    renderScorer(formatFor(2), undefined, { authoritative: true, onSyncRosterPlayer: sync });
    const team = screen.getByLabelText('Ninety Six starters');
    fireEvent.click(within(team).getByText('+ Add player'));
    fireEvent.change(within(team).getByLabelText('Player name'), { target: { value: 'Alex Brown' } });
    fireEvent.click(within(team).getByText('Add'));

    await vi.waitFor(() => expect(sync).toHaveBeenCalledWith('Ninety Six', 'Alex Brown'));
  });

  test('starters can be reordered into seat order without writing another score event', () => {
    renderScorer(formatFor(2));
    const prompt = screen.getByLabelText('Starting lineups');
    const team = within(prompt).getByLabelText('Ninety Six starters');
    fireEvent.click(within(team).getByLabelText('Sarah Jones'));
    fireEvent.click(within(team).getByLabelText('Michael Smith'));

    expect(within(team).getByText('Seat 1')).toBeTruthy();
    expect(within(team).getByText('Seat 2')).toBeTruthy();
    fireEvent.click(within(team).getByText('Reorder starters'));
    fireEvent.click(within(team).getByLabelText('Move Michael Smith up in starting lineup'));
    fireEvent.click(within(team).getByText('Done'));
    fireEvent.click(within(prompt).getByText('Start game'));

    const names = Array.from(screen.getByLabelText('Ninety Six').querySelectorAll('.scorer-player-name'), (node) =>
      (node.textContent ?? '').trim(),
    );
    expect(names).toEqual(['Michael Smith', 'Sarah Jones']);
    expect(savedEvents().filter((event) => event.type === 'substitution')).toHaveLength(1);
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
    fireEvent.click(within(sarahRow).getByText('Replace'));
    fireEvent.click(within(lineup).getByText('Jordan Hall'));
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
    fireEvent.click(within(within(lineup).getByText('Sarah Jones').closest('li') as HTMLElement).getByText('Replace'));
    fireEvent.click(within(lineup).getByText('Jordan Hall'));
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

  test('a full team lets a bench player start a replacement flow', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    const benchRow = within(lineup).getByText('Jordan Hall').closest('li') as HTMLElement;
    fireEvent.click(within(benchRow).getByText('Replace…'));
    expect(within(lineup).getByText('Put Jordan Hall in')).toBeTruthy();
    expect(within(lineup).getByText('Replace:')).toBeTruthy();
    fireEvent.click(within(lineup).getByText('Sarah Jones'));
    fireEvent.click(within(lineup).getByText('Confirm'));

    expect(substitutions().filter((event) => event.team === 'left').at(-1)?.activePlayers).toEqual([
      'Jordan Hall',
      'Michael Smith',
    ]);
  });

  test('the full lineup editor is still there for a multi-player change', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Change lineup'));
    fireEvent.click(within(lineup).getByLabelText(/Sarah Jones/));
    fireEvent.click(within(lineup).getByLabelText(/Michael Smith/));
    fireEvent.click(within(lineup).getByLabelText(/Jordan Hall/));
    fireEvent.click(within(lineup).getByText('Apply lineup'));

    const change = substitutions()
      .filter((event) => event.team === 'left')
      .at(-1);
    expect(change?.activePlayers).toEqual(['Jordan Hall']);
  });

  test('a bench player can still go directly into an open seat', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones']);

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    const michaelRow = within(lineup).getByText('Michael Smith').closest('li') as HTMLElement;
    fireEvent.click(within(michaelRow).getByText('Put in'));
    expect(within(lineup).getByText('Michael Smith comes on')).toBeTruthy();
    fireEvent.click(within(lineup).getByText('Confirm'));

    expect(substitutions().filter((event) => event.team === 'left').at(-1)?.activePlayers).toEqual([
      'Sarah Jones',
      'Michael Smith',
    ]);
  });
});

/**
 * The substitution made without leaving the scoresheet.
 *
 * The same event as the dialog's, written from the row of the player coming off. What matters here is
 * that it really is the same event — the complete lineup at the right question boundary, with the
 * replacement in the outgoing player's seat — because a shortcut that stored anything less would put
 * tossups heard wrong for the rest of the game.
 */
describe('the Sub button on a player row', () => {
  function subRow(team: string, player: string) {
    const panel = screen.getByLabelText(team);
    const row = within(panel).getByText(player).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: `Substitute for ${player}` }));
    return row;
  }

  test('the control is the swap glyph, not the word repeated down every row', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);

    const panel = screen.getByLabelText('Ninety Six');
    const row = within(panel).getByText('Sarah Jones').closest('li') as HTMLElement;
    const control = within(row).getByRole('button', { name: 'Substitute for Sarah Jones' });
    // The name is what has to be read at a glance on this line; the control says its job with arrows.
    expect(control.textContent).toBe('\u21c4');
    expect(within(panel).queryAllByText('Sub')).toEqual([]);
  });

  test('two presses record the complete lineup, effective at the next question', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    buzz('Sarah Jones', 1); // a power on tossup 1, so the change lands on tossup 2

    const row = subRow('Ninety Six', 'Sarah Jones');
    expect(within(row).getByText(/Effective starting Tossup 2/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Jordan Hall' }));

    const change = substitutions()
      .filter((event) => event.team === 'left')
      .at(-1);
    expect(change?.questionNumber).toBe(2);
    // The replacement takes the outgoing player's seat rather than being appended.
    expect(change?.activePlayers).toEqual(['Jordan Hall', 'Michael Smith']);
    expect(screen.getByText('Jordan Hall came on for Sarah Jones (Ninety Six), starting Tossup 2.')).toBeTruthy();
  });

  test('it only offers the bench, and says so when the bench is empty', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);

    const row = subRow('Ninety Six', 'Sarah Jones');
    expect(within(row).getByRole('button', { name: 'Jordan Hall' })).toBeTruthy();
    // Somebody already on the floor is not a replacement for somebody else on the floor.
    expect(within(row).queryByRole('button', { name: 'Michael Smith' })).toBeNull();

    // Greenwood's roster is exactly the size of the floor, so it has nobody to bring on.
    const full = subRow('Greenwood', 'Emma Turner');
    expect(within(full).getByText(/Everybody on this roster is already playing/)).toBeTruthy();
  });

  test('cancelling leaves the lineup alone', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    const before = substitutions().length;

    const row = subRow('Ninety Six', 'Sarah Jones');
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));

    expect(within(row).queryByText(/Who comes on for/)).toBeNull();
    expect(substitutions().length).toBe(before);
  });

  test('tossups heard still split at the substitution', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));

    const row = subRow('Ninety Six', 'Sarah Jones');
    fireEvent.click(within(row).getByRole('button', { name: 'Jordan Hall' }));

    buzz('Michael Smith', 1);
    fireEvent.click(screen.getByText('20'));

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    expect(within(lineup).getByText('Sarah Jones').closest('li')?.textContent).toContain('1 TUH');
    expect(within(lineup).getByText('Michael Smith').closest('li')?.textContent).toContain('2 TUH');
    expect(within(lineup).getByText('Jordan Hall').closest('li')?.textContent).toContain('1 TUH');
  });
});

describe('a procedure that does not allow substitutions right now', () => {
  const restrictive: IRoomProcedure = {
    version: roomProcedureVersion,
    halves: true,
    timeoutsPerTeam: 1,
    substitutionPolicy: 'breaks-timeouts-overtime',
  };

  test('the row cannot start a substitution the procedure forbids', () => {
    renderScorer(formatFor(2), restrictive);
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));

    const panel = screen.getByLabelText('Ninety Six');
    const row = within(panel).getByText('Sarah Jones').closest('li') as HTMLElement;
    const sub = within(row).getByRole('button', { name: 'Substitute for Sarah Jones' });
    expect(sub.hasAttribute('disabled')).toBe(true);
    expect(sub.getAttribute('title')).toContain('halftime, timeouts, and phase checkpoints');
  });

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
        .getAllByText('Replace')
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
    fireEvent.click(within(lineup).getByText('+ Add player'));
    expect(within(lineup).getByText('Sarah Jones')).toBeTruthy();
    // The team is full, so the panel says where they are going rather than silently benching them.
    expect(within(lineup).getByText(/join the bench/)).toBeTruthy();
    fireEvent.change(within(lineup).getByLabelText('Player name'), { target: { value: 'Alex Brown' } });
    fireEvent.click(within(lineup).getByText('Add'));

    const events = savedEvents();
    expect(events.some((event) => event.type === 'roster-add' && event.playerName === 'Alex Brown')).toBe(true);
    expect(screen.getByText('Added Alex Brown to the bench.')).toBeTruthy();
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
    fireEvent.click(within(lineup).getByText('+ Add player'));
    expect(within(lineup).getByText(/from Tossup 2/)).toBeTruthy();
    fireEvent.change(within(lineup).getByLabelText('Player name'), { target: { value: 'Alex Brown' } });
    fireEvent.click(within(lineup).getByText('Add'));

    const change = substitutions()
      .filter((event) => event.team === 'left')
      .at(-1);
    expect(screen.getByText('Added Alex Brown and put them in starting Tossup 2.')).toBeTruthy();
    expect(change?.questionNumber).toBe(2);
    expect(change?.activePlayers).toContain('Alex Brown');
  });
});
