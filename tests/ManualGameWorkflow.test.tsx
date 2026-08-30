/**
 * Creating a game by hand, through the real screens.
 *
 * The claim being defended is the one the whole feature rests on: a manually created game is only
 * special while it is being set up. So these drive the front door, the setup form, the scorer, a
 * reload, and the completion screen, and check at every step that what is on screen is the ordinary
 * QBSheet — the same starting-lineup prompt, the same journal, the same Recent Games, the same QBJ
 * builder — and not a second scorer wearing its clothes.
 *
 * The two places it is legitimately different are checked as hard as the places it is not: nothing
 * is created until Start game is pressed, and nobody is owed the finished file.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { bonus, openApp, openGameFile, press, pressControl, score, startLineups } from './appHarness';
import { claimResponseTimeoutMs } from '../src/persistence/TabClaim';

afterEach(cleanup);

/** Capture what a download would have written, instead of writing it. Same shape as `FileWorkflow`. */
function captureDownloads(): { files: { name: string; contents: string }[] } {
  const files: { name: string; contents: string }[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const OriginalBlob = globalThis.Blob;
  const originalClick = HTMLAnchorElement.prototype.click;
  let pending = '';

  class RecordingBlob extends OriginalBlob {
    readonly recordedText: string;

    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      this.recordedText = parts.map((part) => String(part)).join('');
    }
  }
  globalThis.Blob = RecordingBlob as unknown as typeof Blob;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      pending = (blob as RecordingBlob).recordedText ?? '';
      return 'blob:captured';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    files.push({ name: this.download, contents: pending });
  };

  afterEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke });
    globalThis.Blob = OriginalBlob;
    HTMLAnchorElement.prototype.click = originalClick;
  });

  return { files };
}

/** What a reload is: a fresh application against the same storage. */
async function reload(): Promise<void> {
  cleanup();
  await openApp();
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

interface ISetupValues {
  label?: string;
  leftName?: string;
  leftPlayers?: string[];
  rightName?: string;
  rightPlayers?: string[];
  /** Applied after the names, so the roster boxes are found by their team name. */
  rules?: Record<string, string>;
}

const defaults: Required<Omit<ISetupValues, 'rules' | 'label'>> = {
  leftName: 'Ninety Six',
  leftPlayers: ['Sarah', 'James', 'Alex'],
  rightName: 'Greenwood',
  rightPlayers: ['Emma', 'Jordan'],
};

/** Open the setup form from the front door and fill it in. Does not press Start game. */
async function fillSetup(values: ISetupValues = {}): Promise<void> {
  await press('Create game');
  await screen.findByRole('heading', { name: 'Create a game' });

  const filled = { ...defaults, ...values };
  await act(async () => {
    if (values.label !== undefined) type('Game label', values.label);
    type('Left team name', filled.leftName);
    type('Right team name', filled.rightName);
  });
  await act(async () => {
    type(`${filled.leftName} players`, filled.leftPlayers.join('\n'));
    type(`${filled.rightName} players`, filled.rightPlayers.join('\n'));
    for (const [field, value] of Object.entries(values.rules ?? {})) type(field, value);
  });
}

/** Press Start game and let the record be written and the tab claim settle. */
async function startGame(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
  });
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, claimResponseTimeoutMs + 50);
    });
  });
}

async function createGame(values: ISetupValues = {}): Promise<void> {
  await fillSetup(values);
  await startGame();
}

/**
 * Choose starters and begin, one press at a time.
 *
 * The shared harness fills every seat inside a single `act`, which is fine for a game that never
 * shows the prompt. This one is about the prompt, so each press is its own flush and the button's
 * enabled state is read after the press that changed it rather than before.
 */
async function chooseStarters(team: string, players: string[]): Promise<void> {
  const section = screen.getByLabelText(`${team} starters`);
  for (const player of players) {
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: `Start ${player}` }));
    });
  }
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
  });
}

/** Stop the game where it is and submit the result. */
async function finishGame(): Promise<void> {
  await pressControl('End game early…');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Why is the game ending early?'), {
      target: { value: 'Practice over' },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByText('End the game now'));
  });
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Final score confirmed with both teams'));
  });
  await act(async () => {
    fireEvent.click(screen.getByText('Submit result'));
  });
  await screen.findByText('Final');
}

describe('the front door', () => {
  test('offers all three ways into a game, and the tutorial separately', async () => {
    await openApp();

    expect(screen.getByText('Connect to tournament control')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open game file' })).toBeInTheDocument();
    expect(screen.getByText('Create a game')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create game' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Practice scoring' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'About QBSheet' })).toHaveAttribute('href', 'about/');
  });

  test('creating a game is stated as scoring, not as a tutorial', async () => {
    await openApp();

    expect(screen.getByText('Enter teams, players, and scoring rules yourself.')).toBeInTheDocument();
    expect(
      screen.getByText('Learn the workflow with a guided game using the real scoresheet. No setup needed.'),
    ).toBeInTheDocument();
  });

  test('Create game opens the setup form and nothing else', async () => {
    await openApp();

    await press('Create game');

    expect(screen.getByRole('heading', { name: 'Create a game' })).toBeInTheDocument();
    // No record was written by arriving here.
    await reload();
    expect(screen.queryByText('Unfinished game')).toBeNull();
  });

  test('Cancel goes home without creating anything', async () => {
    await openApp();
    await fillSetup();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      await press('Cancel');
    } finally {
      confirm.mockRestore();
    }

    expect(await screen.findByText('Start scoring')).toBeInTheDocument();
    expect(screen.queryByText('Unfinished game')).toBeNull();
  });
});

describe('the setup form', () => {
  test('Start game is pressable from the outset, and says what is missing', async () => {
    await openApp();
    await press('Create game');

    const start = screen.getByRole('button', { name: 'Start game' });
    expect(start).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(start);
    });

    expect(screen.getByText('Enter a name for the left team.')).toBeInTheDocument();
    expect(screen.getByText('Enter a name for the right team.')).toBeInTheDocument();
    // Still on the form, and nothing was created.
    expect(screen.getByRole('heading', { name: 'Create a game' })).toBeInTheDocument();
  });

  test('the setup is a form so keyboard submission reaches the same validation', async () => {
    await openApp();
    await press('Create game');

    const form = screen.getByRole('form', { name: 'Create a game' });
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(screen.getByText('Enter a name for the left team.')).toBeInTheDocument();
    expect(screen.getByText('Enter a name for the right team.')).toBeInTheDocument();
  });

  test('a refused submission puts an alert on screen and moves focus to it', async () => {
    await openApp();
    await press('Create game');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    });

    const alerts = screen.getAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(alerts[0]);
  });

  test('nothing is complained about before anything is submitted', async () => {
    await openApp();
    await press('Create game');

    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('each side needs at least one player, by name', async () => {
    await openApp();
    await fillSetup({ rightPlayers: [] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    });

    expect(screen.getByText('Greenwood needs at least one player.')).toBeInTheDocument();
  });

  test('two teams cannot have the same name', async () => {
    await openApp();
    await fillSetup({ rightName: 'ninety six', rightPlayers: ['Emma'] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    });

    expect(screen.getByText('Team names must be different.')).toBeInTheDocument();
  });

  test('a player listed twice on one roster is refused', async () => {
    await openApp();
    await fillSetup({ leftPlayers: ['Sarah', 'James', 'Sarah'] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    });

    expect(screen.getByText('Ninety Six: "Sarah" is listed more than once.')).toBeInTheDocument();
  });

  test('a rule that cannot be played is refused in the reader’s own words', async () => {
    await openApp();
    await fillSetup({ rules: { 'Players playing at once': '0' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    });

    expect(screen.getByText('Players playing at once must be at least 1.')).toBeInTheDocument();
  });

  test('an out-of-range round option is reported rather than clamped', async () => {
    await openApp();
    await fillSetup();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Timeouts per team'), { target: { value: '40' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    });

    expect(screen.getByText('Timeouts per team must be between 0 and 9.')).toBeInTheDocument();
    expect((screen.getByLabelText('Timeouts per team') as HTMLInputElement).value).toBe('40');
  });

  test('the roster boxes have distinct accessible names based on their side', async () => {
    await openApp();
    await press('Create game');

    // Before either team is named, they are still told apart.
    expect(screen.getByLabelText('Left team players')).toBeInTheDocument();
    expect(screen.getByLabelText('Right team players')).toBeInTheDocument();

    await act(async () => {
      type('Left team name', 'Ninety Six');
    });
    expect(screen.getByLabelText('Ninety Six players')).toBeInTheDocument();
  });

  test('the optional settings only appear once they apply', async () => {
    await openApp();
    await press('Create game');

    expect(screen.queryByLabelText('Minutes of play between breaks')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('The round has breaks'));
    });
    expect(screen.getByLabelText('Minutes of play between breaks')).toBeInTheDocument();

    expect(screen.queryByLabelText('Timeout length in seconds')).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Timeouts per team'), { target: { value: '1' } });
    });
    expect(screen.getByLabelText('Timeout length in seconds')).toBeInTheDocument();
  });

  test('substitutions default to between any tossups', async () => {
    await openApp();
    await press('Create game');

    expect(screen.getByLabelText('Between any tossups')).toBeChecked();
    expect(screen.getByLabelText('Only at breaks, timeouts, or phase checkpoints')).not.toBeChecked();
  });

  test('there is no lineup chooser here; roster membership is the only question', async () => {
    await openApp();
    await press('Create game');

    expect(screen.queryByText('Who is starting?')).toBeNull();
    expect(screen.queryByLabelText('Starting lineups')).toBeNull();
  });
});

describe('starting the game', () => {
  test('a roster that fits on the floor goes straight to tossup one', async () => {
    await openApp();
    await createGame();

    expect(await screen.findByText('Sarah')).toBeInTheDocument();
    expect(screen.queryByText('Who is starting?')).toBeNull();
    expect(screen.getByText(/Tossup 1 of/)).toBeInTheDocument();
  });

  test('a roster bigger than the floor reaches the existing Starting / Bench screen', async () => {
    await openApp();
    await createGame({ leftPlayers: ['Sarah', 'James', 'Alex', 'Chris', 'Robin'] });

    expect(await screen.findByText('Who is starting?')).toBeInTheDocument();
    // The existing prompt, unchanged: the side that has a choice to make is asked, and the side
    // that fits on the floor is shown as already settled rather than hidden.
    expect(screen.getByLabelText('Ninety Six starters')).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Greenwood starters')).getByText('Lineup set automatically'),
    ).toBeInTheDocument();

    await chooseStarters('Ninety Six', ['Sarah', 'James', 'Alex', 'Chris']);
    expect(await screen.findByText(/Tossup 1 of/)).toBeInTheDocument();
  });

  test('nothing asks the room to confirm an assignment nobody made', async () => {
    await openApp();
    await createGame();

    expect(screen.queryByRole('button', { name: 'Everything matches' })).toBeNull();
    expect(screen.queryByText('Ninety Six vs Greenwood')).toBeNull();
  });

  test('the entered rules are the rules being scored under', async () => {
    await openApp();
    await createGame({ rules: { 'Correct tossup': '10', 'Power (blank for none)': '15' } });

    // The power exists because it was typed in, and is worth what was typed in.
    await score('Sarah', 'P');
    await bonus('20');

    await waitFor(() => expect(screen.getByLabelText('Ninety Six score')).toHaveTextContent('35'));
  });

  test('a smaller floor than the roster is honoured rather than kept at four', async () => {
    await openApp();
    await createGame({
      leftPlayers: ['Sarah', 'James', 'Alex'],
      rules: { 'Players playing at once': '2' },
    });

    expect(await screen.findByText('Who is starting?')).toBeInTheDocument();
    const left = screen.getByLabelText('Ninety Six starters');
    await act(async () => {
      fireEvent.click(within(left).getByRole('button', { name: 'Start Sarah' }));
    });
    await act(async () => {
      fireEvent.click(within(left).getByRole('button', { name: 'Start James' }));
    });
    // The floor is two, so the third player cannot be added to it.
    expect(within(left).getByRole('button', { name: 'Start Alex' })).toBeDisabled();
  });

  test('the game is filed under the label it was given', async () => {
    await openApp();
    await createGame({ label: 'Tuesday scrimmage' });

    expect(await screen.findByText(/Tuesday scrimmage/)).toBeInTheDocument();
  });
});

describe('a manual game is an ordinary game', () => {
  test('a reload offers it, and Resume comes back at the same score', async () => {
    await openApp();
    await createGame();
    await score('Sarah', 'C');
    await bonus('20');

    await reload();

    expect(await screen.findByText('Unfinished game')).toBeInTheDocument();
    expect(screen.getByText('Ninety Six vs Greenwood')).toBeInTheDocument();
    expect(screen.getByText('Q1')).toBeInTheDocument();

    await press('Resume');
    await waitFor(() => expect(screen.getByLabelText('Ninety Six score')).toHaveTextContent('30'));
  });

  test('a second practice between the same two teams is a second game, not the first one again', async () => {
    await openApp();
    await createGame();
    await score('Sarah', 'C');
    await bonus('20');
    await finishGame();
    await press('Done');

    await screen.findByText('Start scoring');
    await createGame();

    // Not the resume notice, and not the already-completed dialog: a new game, at zero.
    expect(
      screen.queryByText('This game is already saved on this device. Resume it rather than starting again.'),
    ).toBeNull();
    expect(screen.queryByText('This game has already been completed on this device.')).toBeNull();
    await waitFor(() => expect(screen.getByLabelText('Ninety Six score')).toHaveTextContent('0'));
  });

  test('it lands in Recent Games when it is finished', async () => {
    await openApp();
    await createGame({ label: 'Tuesday scrimmage' });
    await score('Sarah', 'C');
    await bonus('20');
    await finishGame();
    await press('Done');

    expect(await screen.findByText('Recent')).toBeInTheDocument();
    expect(screen.getByText(/Tuesday scrimmage/)).toBeInTheDocument();
  });
});

describe('finishing a practice', () => {
  test('the completion screen asks for a copy rather than a handoff', async () => {
    await openApp();
    await createGame();
    await score('Sarah', 'C');
    await bonus('20');
    await finishGame();

    expect(screen.getByText('Download or export a copy')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This result is saved on this device. Download a QBJ if you want to keep or share a portable copy.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download QBJ copy' })).toBeInTheDocument();
    expect(screen.queryByText('Hand this result over')).toBeNull();
  });

  test('Done is enabled without downloading anything', async () => {
    await openApp();
    await createGame();
    await score('Sarah', 'C');
    await bonus('20');
    await finishGame();

    expect(screen.getByRole('button', { name: 'Done' })).not.toBeDisabled();
    expect(screen.queryByText(/before finishing/)).toBeNull();

    await press('Done');
    expect(await screen.findByText('Start scoring')).toBeInTheDocument();
  });

  test('nobody is asked to confirm an upload that was never asked for', async () => {
    const downloads = captureDownloads();
    await openApp();
    await createGame();
    await score('Sarah', 'C');
    await bonus('20');
    await finishGame();

    await press('Download QBJ copy');

    expect(downloads.files).toHaveLength(1);
    expect(await screen.findByText(/Downloaded at/)).toBeInTheDocument();
    expect(screen.getByText('A copy of this result is in your downloads.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'I uploaded the result' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).not.toBeDisabled();
  });

  test('a file game still cannot leave until its QBJ has been written', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await score('Sarah Mitchell', '+15');
    await bonus('20');
    await finishGame();

    expect(screen.getByText('Hand this result over')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(screen.getByText(/Download the QBJ before finishing/)).toBeInTheDocument();
  });
});

describe('the QBJ a practice produces', () => {
  test('is an ordinary result document with the entered teams, players and rules in it', async () => {
    const downloads = captureDownloads();
    await openApp();
    await createGame({ label: 'Tuesday scrimmage', rules: { 'Power (blank for none)': '15' } });
    await score('Sarah', 'P');
    await bonus('20');
    await finishGame();

    await press('Download QBJ copy');

    expect(downloads.files).toHaveLength(1);
    const payload = JSON.parse(downloads.files[0].contents);

    // The ordinary portable result: a Match with the aggregates on it.
    expect(payload.match_teams[0].points).toBe(35);
    expect(payload.match_teams[1].points).toBe(0);
    expect(payload.match_teams[0].team.name).toBe('Ninety Six');
    expect(payload.match_teams[1].team.name).toBe('Greenwood');
    expect(payload.match_teams[0].match_players.map((player: { player: { name: string } }) => player.player.name)).toContain(
      'Sarah',
    );

    // The modest metadata a practice honestly has, and nothing pretending to be an assignment.
    expect(payload._qbsheet_source).toMatchObject({ producer: 'QBSheet', tournamentName: 'Practice', roundNumber: 1 });
    expect(payload._qbsheet_source.scheduledMatchId).toBeUndefined();
    expect(payload._qbsheet_source.tournamentId).toBeUndefined();
  });

  test('carries no device identity, no credentials and no internal state', async () => {
    const downloads = captureDownloads();
    await openApp();
    await createGame();
    await score('Sarah', 'C');
    await bonus('20');
    await finishGame();

    await press('Download QBJ copy');

    const contents = downloads.files[0].contents;
    expect(contents).not.toContain('manual:');
    expect(contents).not.toContain('_yf_scorekeeper_recovery');
    expect(contents).not.toContain('token');
    expect(contents).not.toContain('deviceId');
    expect(JSON.parse(contents)).not.toHaveProperty('_yf_scorekeeper_recovery');
  });

  test('the whole serialized document parses, with the entered rules in it', async () => {
    const downloads = captureDownloads();
    await openApp();
    await createGame({ rules: { 'Correct tossup': '10', 'Power (blank for none)': '15' } });
    await score('Sarah', 'C');
    await bonus('20');

    await pressControl('Download current QBJ');

    const document = JSON.parse(downloads.files[0].contents);
    expect(document.version).toBe('2.1.1');
    const objects = document.objects as { type: string; name?: string; value?: number }[];
    const tournament = objects.find((entry) => entry.type === 'Tournament');
    expect(tournament?.name).toBe('Practice');
    const rules = objects.find((entry) => entry.type === 'ScoringRules') as
      | { answer_types: { value: number }[]; maximum_players_per_team: number }
      | undefined;
    expect(rules?.answer_types.map((type) => type.value)).toEqual([15, 10, -5]);
    expect(objects.filter((entry) => entry.type === 'Team').map((entry) => entry.name)).toEqual([
      'Ninety Six',
      'Greenwood',
    ]);
    expect(JSON.stringify(document)).not.toContain('manual:');
  });
});
