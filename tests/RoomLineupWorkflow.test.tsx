/**
 * @vitest-environment jsdom
 */

/**
 * Starters, substitutions and late arrivals, driven the way a scorekeeper drives them.
 *
 * The event model underneath is unchanged and deliberately so: a substitution stores the complete
 * lineup effective at a question boundary, which is what makes tossups heard exact and what makes a
 * reload able to reconstruct who was on the floor for question eleven. What changed is that a
 * scorekeeper no longer has to compose that lineup out of checkboxes: the starting order is the
 * visible scoresheet, and the bench is directly below it.
 *
 * So the tests are in two halves: the workflow a scorekeeper sees, and the event it produces. The
 * second half is the one that matters to the standings.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  requiredStarterCount?: Partial<Record<'left' | 'right', number>>,
  /** Overridden where a test needs a roster of a particular size against the format's seat count. */
  left: typeof leftTeam = leftTeam,
) {
  gameCounter += 1;
  gameKey = `lineup-game-${gameCounter}`;
  render(
    <ScorerHost
      gameKey={gameKey}
      format={format}
      requiredStarterCount={requiredStarterCount}
      leftTeam={left}
      rightTeam={rightTeam}
      tournamentName="Ninety Six Invitational"
      roundName="Round 4"
      roomName="Room 204"
      procedure={procedure}
      connection={RoomConnectionState.Connected}
      authoritativeLeftTeam={rosterOptions.authoritative ? left : undefined}
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
  for (const name of names) {
    const roster = [leftTeam, rightTeam].find((team) => team.players.some((player) => player.name === name));
    if (!roster) throw new Error(`No test roster contains ${name}`);
    const team = within(prompt).getByLabelText(`${roster.name} starters`);
    fireEvent.click(within(team).getByRole('button', { name: `Start ${name}` }));
  }
  fireEvent.click(within(prompt).getByText('Start game'));
}

/** The Starting rows of one team, in the order they are on screen. */
function starterRows(team: HTMLElement): HTMLElement[] {
  const list = within(team).getByText('Starting').nextElementSibling;
  return list?.tagName === 'UL' ? Array.from(list.querySelectorAll('li')) : [];
}

function starterNames(team: HTMLElement): string[] {
  return starterRows(team).map((row) => row.querySelector('.scorer-lineup-name')?.textContent ?? '');
}

/** The seat each Starting row is showing, read off the row itself rather than off its position. */
function starterSeats(team: HTMLElement): string[] {
  return starterRows(team).map((row) => row.querySelector('.scorer-lineup-seat')?.textContent ?? '');
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

    expect(within(screen.getByLabelText('Ninety Six starters')).getByText('0 starting')).toBeTruthy();
    cleanup();

    renderScorer(formatFor(1));
    expect(within(screen.getByLabelText('Ninety Six starters')).getByText('0 starting')).toBeTruthy();
  });

  test('starting a bench player appends the next seat, and benching closes the order', () => {
    renderScorer(formatFor(2));
    const team = screen.getByLabelText('Ninety Six starters');

    expect(within(team).getByText('No starters selected')).toBeTruthy();
    expect(within(team).queryByRole('checkbox')).toBeNull();
    fireEvent.click(within(team).getByRole('button', { name: 'Start Michael Smith' }));
    fireEvent.click(within(team).getByRole('button', { name: 'Start Jordan Hall' }));
    let rows = within(team).getAllByRole('listitem');
    expect(rows[0].textContent).toContain('Michael Smith');
    expect(rows[0].textContent).toContain('1');
    expect(rows[1].textContent).toContain('Jordan Hall');
    expect(rows[1].textContent).toContain('2');

    fireEvent.click(within(team).getByRole('button', { name: 'Bench Michael Smith' }));
    rows = within(team).getAllByRole('listitem');
    expect(rows[0].textContent).toContain('Jordan Hall');
    expect(rows[0].textContent).toContain('1');
    expect(within(team).getAllByText('Michael Smith')).toHaveLength(1);
    expect(within(team).getByRole('button', { name: 'Start Michael Smith' })).toBeTruthy();
  });

  test('a full starting lineup keeps the bench visible but prevents another player from starting', () => {
    renderScorer(formatFor(2));
    const team = screen.getByLabelText('Ninety Six starters');

    fireEvent.click(within(team).getByRole('button', { name: 'Start Sarah Jones' }));
    fireEvent.click(within(team).getByRole('button', { name: 'Start Michael Smith' }));

    const startJordan = within(team).getByRole('button', { name: 'Start Jordan Hall' });
    expect(startJordan).toBeDisabled();
    expect(within(team).getByText('Jordan Hall')).toBeTruthy();
    expect(within(team).getByText('2 starting')).toBeTruthy();
  });

  test('a shorthanded lineup remains valid when the required starter count permits it', () => {
    renderScorer(formatFor(2), undefined, {}, { left: 1 });
    const prompt = screen.getByLabelText('Starting lineups');
    const team = within(prompt).getByLabelText('Ninety Six starters');

    fireEvent.click(within(team).getByRole('button', { name: 'Start Sarah Jones' }));
    const startGame = within(prompt).getByRole('button', { name: 'Start game' });
    expect(startGame).not.toBeDisabled();
    fireEvent.click(startGame);

    expect(substitutions().find((event) => event.team === 'left')?.activePlayers).toEqual(['Sarah Jones']);
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

    expect(within(team).getByText('Alex Brown')).toBeTruthy();
    expect(within(team).getByRole('button', { name: 'Start Alex Brown' })).toBeTruthy();
    expect(savedEvents().filter((event) => event.type === 'roster-add').map((event) => event.playerName)).toEqual([
      'Alex Brown',
    ]);

    fireEvent.click(within(team).getByRole('button', { name: 'Start Michael Smith' }));
    fireEvent.click(within(team).getByRole('button', { name: 'Start Alex Brown' }));
    fireEvent.click(within(screen.getByLabelText('Starting lineups')).getByText('Start game'));

    expect(substitutions().find((event) => event.team === 'left')?.activePlayers).toEqual([
      'Michael Smith',
      'Alex Brown',
    ]);
  });

  test('adding to a settled team leaves its existing starters unchanged', () => {
    renderScorer(formatFor(2));
    const settledTeam = screen.getByLabelText('Greenwood starters');

    expect(within(settledTeam).queryByRole('checkbox')).toBeNull();
    expect(within(settledTeam).getByText('Lineup set automatically')).toBeTruthy();
    expect(within(settledTeam).getByText('Emma Turner')).toBeTruthy();
    expect(within(settledTeam).getByText('Taylor Adams')).toBeTruthy();
    expect(within(settledTeam).queryByRole('button', { name: 'Bench Emma Turner' })).toBeNull();
    fireEvent.click(within(settledTeam).getByText('+ Add player'));
    fireEvent.change(within(settledTeam).getByLabelText('Player name'), { target: { value: 'Casey Reed' } });
    fireEvent.click(within(settledTeam).getByText('Add'));

    expect(within(settledTeam).getByText('Casey Reed')).toBeTruthy();
    expect(within(settledTeam).queryByRole('button', { name: 'Start Casey Reed' })).toBeNull();
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
    fireEvent.click(within(team).getByRole('button', { name: 'Start Sarah Jones' }));
    fireEvent.click(within(team).getByRole('button', { name: 'Start Michael Smith' }));

    fireEvent.click(within(team).getByLabelText('Move Michael Smith up in starting lineup'));
    fireEvent.click(within(prompt).getByText('Start game'));

    const names = within(screen.getByLabelText('Ninety Six'))
      .getAllByRole('listitem')
      .map((row) => row.textContent?.trim().split(/\s+\d+\s*/).at(-1)?.trim() ?? '');
    expect(names[0]).toContain('Michael Smith');
    expect(names[1]).toContain('Sarah Jones');
    expect(substitutions().find((event) => event.team === 'left')?.activePlayers).toEqual([
      'Michael Smith',
      'Sarah Jones',
    ]);
    expect(savedEvents().filter((event) => event.type === 'substitution')).toHaveLength(1);
  });
});

/**
 * The reorder, watched the way the scorekeeper watches it.
 *
 * The rows now slide between seats rather than swapping in a frame, and the whole point of how that is
 * built is that it changes nothing here: the lineup state is updated on the press and the animation is
 * only the interpolation afterwards. So these assert the order immediately after the click, with no
 * waiting of any kind. If any of them ever needs a timer to pass, the animation has been allowed to
 * become the source of truth and that is the bug.
 */
describe('reordering the starting lineup', () => {
  function twoStarters() {
    renderScorer(formatFor(2));
    const prompt = screen.getByLabelText('Starting lineups');
    const team = within(prompt).getByLabelText('Ninety Six starters');
    fireEvent.click(within(team).getByRole('button', { name: 'Start Sarah Jones' }));
    fireEvent.click(within(team).getByRole('button', { name: 'Start Michael Smith' }));
    return { prompt, team };
  }

  test('Move up changes the order on the press, not when anything finishes', () => {
    const { team } = twoStarters();
    expect(starterNames(team)).toEqual(['Sarah Jones', 'Michael Smith']);

    fireEvent.click(within(team).getByLabelText('Move Michael Smith up in starting lineup'));

    expect(starterNames(team)).toEqual(['Michael Smith', 'Sarah Jones']);
    // The number belongs to the seat, so seat one is still seat one whoever is sitting in it.
    expect(starterSeats(team)).toEqual(['1', '2']);
  });

  test('Move down moves the other way', () => {
    const { team } = twoStarters();

    fireEvent.click(within(team).getByLabelText('Move Sarah Jones down in starting lineup'));

    expect(starterNames(team)).toEqual(['Michael Smith', 'Sarah Jones']);
  });

  test('an arrow pressed faster than any animation still lands on the right order', () => {
    // Four on the roster and three seats, so the prompt appears and there is a middle seat to pass
    // through.
    renderScorer(formatFor(3), undefined, {}, undefined, {
      ...leftTeam,
      players: leftTeam.players.concat({ name: 'Alex Brown' }),
    });
    const team = screen.getByLabelText('Ninety Six starters');
    for (const name of ['Sarah Jones', 'Michael Smith', 'Jordan Hall'])
      fireEvent.click(within(team).getByRole('button', { name: `Start ${name}` }));

    // Three presses with nothing in between them, which is what a scorekeeper correcting a lineup
    // thirty seconds before question one actually does.
    fireEvent.click(within(team).getByLabelText('Move Jordan Hall up in starting lineup'));
    fireEvent.click(within(team).getByLabelText('Move Jordan Hall up in starting lineup'));
    fireEvent.click(within(team).getByLabelText('Move Michael Smith up in starting lineup'));

    expect(starterNames(team)).toEqual(['Jordan Hall', 'Michael Smith', 'Sarah Jones']);
    expect(starterSeats(team)).toEqual(['1', '2', '3']);
    // Reordering is a seating preference, not scoring history, and nothing has been scored yet.
    expect(savedEvents().filter((event) => event.type === 'substitution')).toHaveLength(0);
  });

  test('a reorder is presentation, and writes nothing', () => {
    const { team } = twoStarters();
    const before = savedEvents().length;

    fireEvent.click(within(team).getByLabelText('Move Michael Smith up in starting lineup'));
    fireEvent.click(within(team).getByLabelText('Move Michael Smith down in starting lineup'));

    expect(savedEvents().length).toBe(before);
  });

  test('the row the scorekeeper moved is the one marked, and only for a moment', () => {
    vi.useFakeTimers();
    try {
      const { team } = twoStarters();

      fireEvent.click(within(team).getByLabelText('Move Michael Smith up in starting lineup'));
      const [first, second] = starterRows(team);
      expect(first.className).toContain('is-moved');
      // The displaced starter travels, but it was not the scorekeeper's decision and does not claim
      // the emphasis.
      expect(second.className).not.toContain('is-moved');

      // Long enough for any settling to be over. The exact figure is a design decision and is
      // deliberately not what is asserted; that it goes away is.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(starterRows(team)[0].className).not.toContain('is-moved');
    } finally {
      vi.useRealTimers();
    }
  });

  test('Start and Bench mark the destination row the same way', () => {
    vi.useFakeTimers();
    try {
      renderScorer(formatFor(2));
      const team = screen.getByLabelText('Ninety Six starters');

      fireEvent.click(within(team).getByRole('button', { name: 'Start Michael Smith' }));
      expect(starterRows(team)[0].className).toContain('is-moved');

      fireEvent.click(within(team).getByRole('button', { name: 'Bench Michael Smith' }));
      // Back on the bench, and it is the bench row that is now marked.
      expect(starterRows(team)).toEqual([]);
      const benched = within(team).getByText('Michael Smith').closest('li') as HTMLElement;
      expect(benched.className).toContain('is-moved');
      expect(within(team).getByRole('button', { name: 'Start Michael Smith' })).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(2000);
      });
    } finally {
      vi.useRealTimers();
    }
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
    expect(within(prompt).getByText(/Choose who will play Tossup 1/)).toBeTruthy();
    expect(within(prompt).getByText(/Up to 2 players may start for each team/)).toBeTruthy();
    expect(within(prompt).queryByText(/between any two tossups/)).toBeNull();
    expect(within(prompt).getByText(/halftime, at a timeout, or at a phase checkpoint/)).toBeTruthy();
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

/**
 * The editor for everything a one-for-one substitution is not.
 *
 * Halftime really is four changes at once, and a format change really does need a lineup composed
 * rather than swapped. What that used to cost was a grid of checkboxes, a running total to check by
 * eye, and a lineup array whose order was whatever the ticking happened to leave behind. It is now
 * the same two lists as everywhere else in QBSheet, and the array is worked out rather than collected.
 */
describe('the full lineup editor', () => {
  function openFullEditor(teamLabel = 'Ninety Six lineup'): HTMLElement {
    openPlayers();
    const lineup = screen.getByLabelText(teamLabel);
    fireEvent.click(within(lineup).getByText('Change lineup'));
    return lineup;
  }

  /**
   * The names under one group heading, in the order they are on screen.
   *
   * Found by heading rather than by text, because "Bench" is also the action on every Playing row —
   * which is the vocabulary working: the group and the button that puts somebody in it say the
   * same word.
   */
  function groupNames(editor: HTMLElement, heading: string): string[] {
    const groups = Array.from(editor.querySelectorAll('.scorer-lineup-groups .scorer-lineup-group'));
    const list = groups.find((candidate) => candidate.textContent === heading)?.nextElementSibling;
    if (list?.tagName !== 'UL') return [];
    return Array.from(list.querySelectorAll('.scorer-lineup-name')).map((name) => name.textContent ?? '');
  }

  test('there is not a checkbox in it', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    const editor = openFullEditor();

    expect(editor.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    // Nor a drag handle or an arrow: row order here is not the thing being edited.
    expect(within(editor).queryByLabelText(/Move .* up/)).toBeNull();
    expect(within(editor).queryByLabelText(/Move .* down/)).toBeNull();
  });

  test('every player is under Playing or Bench, once', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    const editor = openFullEditor();

    expect(groupNames(editor, 'Playing')).toEqual(['Sarah Jones', 'Michael Smith']);
    expect(groupNames(editor, 'Bench')).toEqual(['Jordan Hall']);
    const everywhere = groupNames(editor, 'Playing').concat(groupNames(editor, 'Bench'));
    expect(new Set(everywhere).size).toBe(everywhere.length);
  });

  test('Bench takes somebody off and Put in brings somebody on', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    const editor = openFullEditor();

    fireEvent.click(within(editor).getByRole('button', { name: 'Bench Sarah Jones' }));
    expect(groupNames(editor, 'Playing')).toEqual(['Michael Smith']);
    expect(groupNames(editor, 'Bench')).toEqual(['Sarah Jones', 'Jordan Hall']);

    fireEvent.click(within(editor).getByRole('button', { name: 'Put Jordan Hall in' }));
    expect(groupNames(editor, 'Playing')).toEqual(['Michael Smith', 'Jordan Hall']);
    expect(groupNames(editor, 'Bench')).toEqual(['Sarah Jones']);
  });

  test('the format cap is enforced by not offering the action, not by refusing it afterwards', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    const editor = openFullEditor();

    expect(within(editor).getByRole('button', { name: 'Put Jordan Hall in' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: 'Bench Sarah Jones' }));
    expect(within(editor).getByRole('button', { name: 'Put Jordan Hall in' }).hasAttribute('disabled')).toBe(false);
  });

  test('a lineup nobody changed cannot be applied', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    const editor = openFullEditor();
    const apply = within(editor).getByRole('button', { name: 'Apply lineup' });

    expect(apply.hasAttribute('disabled')).toBe(true);
    // Out and straight back in is the same lineup, and is still nothing to record.
    fireEvent.click(within(editor).getByRole('button', { name: 'Bench Sarah Jones' }));
    expect(within(editor).getByRole('button', { name: 'Apply lineup' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(within(editor).getByRole('button', { name: 'Put Sarah Jones in' }));
    expect(within(editor).getByRole('button', { name: 'Apply lineup' }).hasAttribute('disabled')).toBe(true);
  });

  test('one Apply writes one substitution with the whole lineup', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    const before = substitutions().filter((event) => event.team === 'left').length;
    const editor = openFullEditor();

    fireEvent.click(within(editor).getByRole('button', { name: 'Bench Michael Smith' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Put Jordan Hall in' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply lineup' }));

    const left = substitutions().filter((event) => event.team === 'left');
    expect(left.length).toBe(before + 1);
    // Sarah kept the place she already had; Jordan was appended. Nobody was moved by a click order.
    expect(left.at(-1)?.activePlayers).toEqual(['Sarah Jones', 'Jordan Hall']);
  });

  /*
   * The device's row order is a view preference and nothing else — see `PlayerSeating`. Presenting
   * the editor in that order is right; serializing it would be writing a substitution that reordered
   * a lineup nobody touched, into the history a director reads.
   */
  test('a rearranged screen does not rewrite the lineup it is showing', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);

    // Put Michael above Sarah on this Chromebook only.
    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    fireEvent.click(within(lineup).getByText('Reorder'));
    fireEvent.click(within(lineup).getByRole('button', { name: 'Move Michael Smith up' }));
    fireEvent.click(within(lineup).getByText('Done'));
    const recordedBefore = substitutions().filter((event) => event.team === 'left').at(-1)?.activePlayers;
    expect(recordedBefore).toEqual(['Sarah Jones', 'Michael Smith']);

    fireEvent.click(within(lineup).getByText('Change lineup'));
    const editor = screen.getByLabelText('Ninety Six lineup');
    // What is on screen follows the room's order…
    expect(groupNames(editor, 'Playing')).toEqual(['Michael Smith', 'Sarah Jones']);
    fireEvent.click(within(editor).getByRole('button', { name: 'Bench Sarah Jones' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Put Jordan Hall in' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply lineup' }));

    // …and what is written follows the lineup that was already recorded.
    expect(substitutions().filter((event) => event.team === 'left').at(-1)?.activePlayers).toEqual([
      'Michael Smith',
      'Jordan Hall',
    ]);
  });

  test('the row that crossed between groups is the one that is marked', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    const editor = openFullEditor();

    fireEvent.click(within(editor).getByRole('button', { name: 'Bench Sarah Jones' }));

    // The same helper the starting-lineup screen uses; see `LineupMotion`.
    const moved = editor.querySelectorAll('.scorer-lineup-entry.is-moved');
    expect(moved).toHaveLength(1);
    expect(moved[0].querySelector('.scorer-lineup-name')?.textContent).toBe('Sarah Jones');
  });
});

/**
 * The seat, held still while the person in it changes.
 *
 * The event this produces is already covered above. What is checked here is the one thing a
 * scorekeeper watches for after they press Confirm: that the row they were looking at is the row the
 * replacement appeared in, and that it said so.
 */
describe('a substitution landing in a seat', () => {
  function playerRows(teamLabel: string): HTMLElement[] {
    return Array.from(screen.getByLabelText(teamLabel).querySelectorAll('.scorer-player'));
  }

  function nameAt(teamLabel: string, seat: number): string {
    return playerRows(teamLabel)[seat]?.querySelector('.scorer-player-name')?.textContent ?? '';
  }

  test('the incoming player appears in the row the substitution started from', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    expect(nameAt('Ninety Six', 1)).toBe('Michael Smith');

    const row = playerRows('Ninety Six')[1];
    fireEvent.click(within(row).getByRole('button', { name: 'Substitute for Michael Smith' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Jordan Hall' }));

    // Seat two, still seat two, with somebody else in it.
    expect(nameAt('Ninety Six', 0)).toBe('Sarah Jones');
    expect(nameAt('Ninety Six', 1)).toBe('Jordan Hall');
    expect(playerRows('Ninety Six')[1].querySelector('.scorer-player-seat')?.textContent).toBe('2');
  });

  test('the destination row is emphasised, and only that row', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);

    const row = playerRows('Ninety Six')[1];
    fireEvent.click(within(row).getByRole('button', { name: 'Substitute for Michael Smith' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Jordan Hall' }));

    const emphasised = playerRows('Ninety Six').filter((candidate) =>
      candidate.className.includes('is-substituted'),
    );
    expect(emphasised).toHaveLength(1);
    expect(emphasised[0].querySelector('.scorer-player-name')?.textContent).toBe('Jordan Hall');
    // The other team's sheet is not involved in this at all.
    expect(playerRows('Greenwood').some((candidate) => candidate.className.includes('is-substituted'))).toBe(false);
  });

  test('it is still exactly one substitution event, and tossups heard are untouched by the emphasis', () => {
    renderScorer(formatFor(2));
    chooseStarters(['Sarah Jones', 'Michael Smith']);
    buzz('Sarah Jones', 1);
    fireEvent.click(screen.getByText('20'));
    const before = substitutions().filter((event) => event.team === 'left').length;

    const row = playerRows('Ninety Six')[1];
    fireEvent.click(within(row).getByRole('button', { name: 'Substitute for Michael Smith' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Jordan Hall' }));

    const left = substitutions().filter((event) => event.team === 'left');
    expect(left.length).toBe(before + 1);
    expect(left.at(-1)?.questionNumber).toBe(2);
    expect(left.at(-1)?.activePlayers).toEqual(['Sarah Jones', 'Jordan Hall']);

    openPlayers();
    const lineup = screen.getByLabelText('Ninety Six lineup');
    expect(within(lineup).getByText('Michael Smith').closest('li')?.textContent).toContain('1 TUH');
    expect(within(lineup).getByText('Jordan Hall').closest('li')?.textContent).toContain('0 TUH');
  });
});
