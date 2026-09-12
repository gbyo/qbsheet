/**
 * Scoring a tournament game on a device that is talking to nothing.
 *
 * The situation this defends is a real one: the tournament's software is down, or a room has no
 * network, and the game has to be scored anyway on whatever is in front of the scorekeeper. Nothing
 * here is a new mode — it is the ordinary Create-a-game path — so the tests drive the real screens
 * from the front door and check the three things that decide whether a room can actually use it:
 * the setup can be stated in a few presses, the result is a readable stat sheet without submitting
 * anywhere, and the numbers on it are the derived game's own.
 *
 * Nothing in this file starts a server, opens a connection, pairs with a room, or reads an
 * assignment. That is the point of it.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { bonus, openApp, press, score } from './appHarness';
import { claimResponseTimeoutMs } from '../src/persistence/TabClaim';

afterEach(cleanup);

/** Capture what a download would have written, instead of writing it. As in `ManualGameWorkflow`. */
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

/** What the browser put on the clipboard, for the copy actions. */
function captureClipboard(): { texts: string[] } {
  const texts: string[] = [];
  const writeText = vi.fn((value: string) => {
    texts.push(value);
    return Promise.resolve();
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });
  return { texts };
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Fill the setup form by hand: two teams, two rosters, a label. */
async function fillSetup(options: { label?: string } = {}): Promise<void> {
  await press('Create game');
  await screen.findByRole('heading', { name: 'Create a game' });
  await act(async () => {
    if (options.label !== undefined) type('Game label', options.label);
    type('Left team name', 'Dorman');
    type('Right team name', 'Wren A');
  });
  await act(async () => {
    type('Dorman players', 'Alice\nBob');
    type('Wren A players', 'Cleo\nDev');
  });
}

/** Choose one of the built-in rule presets by its visible label. */
async function loadRulePreset(label: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Start from a preset'), {
      target: {
        value:
          within(screen.getByLabelText('Start from a preset')).getByText(label).getAttribute('value') ?? '',
      },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Load rules and round options' }));
  });
}

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

/** Stop the game where it is, so the review screen is reached from a real terminal event. */
async function endGame(): Promise<void> {
  const menu = screen.queryByRole('button', { name: 'End game early…' });
  if (menu) {
    await act(async () => {
      fireEvent.click(menu);
    });
  } else {
    await act(async () => {
      fireEvent.click(screen.getByText('Game'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'End game early…' }));
    });
  }
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Why is the game ending early?'), {
      target: { value: 'Tournament software is down' },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByText('End the game now'));
  });
}

/** Four cycles of the 15/10 game, giving each side a power and a correct. */
async function scoreFourCycles(): Promise<void> {
  await score('Alice', 'P');
  await bonus('20');
  await score('Cleo', 'C');
  await bonus('10');
  await score('Bob', 'C');
  await bonus('30');
  await score('Dev', 'P');
  await bonus('0');
}

describe('the emergency setup', () => {
  test('the front door says the created game needs nothing else', async () => {
    await openApp();

    expect(screen.getByText('Create a game')).toBeInTheDocument();
    expect(screen.getByText(/No tournament control, no pairing, no network/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create game' })).toBeInTheDocument();
  });

  test('15/10 with bonuses, no negs and 20 tossups is one preset away', async () => {
    await openApp();
    await fillSetup();

    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');

    expect(screen.getByLabelText('Correct tossup')).toHaveValue(10);
    expect(screen.getByLabelText('Power (blank for none)')).toHaveValue(15);
    expect(screen.getByLabelText('Neg (blank for none)')).toHaveValue(null);
    expect(screen.getByLabelText('Tossups in regulation')).toHaveValue(20);
  });

  test('the preset changes no default: a fresh form still opens on the QBSheet rules', async () => {
    await openApp();
    await fillSetup();

    // The neg the defaults carry is still there, unasked for, until a preset replaces it.
    expect(screen.getByLabelText('Neg (blank for none)')).toHaveValue(-5);
    expect(screen.getByLabelText('Start from a preset')).toHaveValue('defaults');
  });

  test('the advanced rules editor is still there', async () => {
    await openApp();
    await fillSetup();

    expect(screen.getByRole('heading', { name: /Scoring rules/ })).toBeInTheDocument();
    expect(screen.getByText('Advanced round setup')).toBeInTheDocument();
  });

  test('a game starts and is scored under the preset rules', async () => {
    await openApp();
    await fillSetup({ label: 'R1 · 315' });
    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');
    await startGame();

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    await score('Alice', 'P');
    await bonus('20');

    await waitFor(() => expect(screen.getByLabelText('Dorman score')).toHaveTextContent('35'));
  });
});

describe('the review screen is the stat sheet', () => {
  test('player stats are on screen without opening anything', async () => {
    await openApp();
    await fillSetup({ label: 'R1 · 315' });
    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');
    await startGame();
    await scoreFourCycles();
    await endGame();

    const stats = screen.getByText('Player stats').closest('details');
    expect(stats).toHaveAttribute('open');

    const dorman = screen.getByLabelText('Dorman players');
    expect(within(dorman).getByRole('columnheader', { name: '+15' })).toBeInTheDocument();
    expect(within(dorman).getByRole('columnheader', { name: '+10' })).toBeInTheDocument();
    expect(within(dorman).queryByRole('columnheader', { name: '-5' })).toBeNull();

    const alice = within(dorman).getByRole('row', { name: /Alice/ });
    // TUH, one column per answer type, then the player's own points.
    expect(
      within(alice)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['4', '1', '0', '15']);

    expect(within(dorman).getByText(/Tossups 25 · Bonuses 50/)).toBeInTheDocument();
  });

  test('the score and the tossups heard are stated at the top', async () => {
    await openApp();
    await fillSetup({ label: 'R1 · 315' });
    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');
    await startGame();
    await scoreFourCycles();
    await endGame();

    const score = screen.getByLabelText('Final score');
    expect(within(score).getByText('Dorman')).toBeInTheDocument();
    expect(within(score).getByText('75')).toBeInTheDocument();
    expect(within(score).getByText('Wren A')).toBeInTheDocument();
    expect(within(score).getByText('35')).toBeInTheDocument();
    expect(screen.getByText(/4 tossups heard/)).toBeInTheDocument();
  });

  test('a format with negs shows the neg column instead', async () => {
    await openApp();
    await fillSetup();
    await loadRulePreset('10 with negs, bonuses, 20 tossups');
    await startGame();
    await score('Alice', 'C');
    await bonus('20');
    await score('Cleo', 'N');
    // The negged tossup is still live when the game is stopped, so it is not a tossup Cleo heard.
    await endGame();

    const dorman = screen.getByLabelText('Dorman players');
    expect(within(dorman).getByRole('columnheader', { name: '-5' })).toBeInTheDocument();
    const wren = screen.getByLabelText('Wren A players');
    const cleo = within(wren).getByRole('row', { name: /Cleo/ });
    expect(
      within(cleo)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['1', '0', '1', '-5']);
  });

  test('Edit game is beside the result, and nothing demands a submission', async () => {
    await openApp();
    await fillSetup();
    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');
    await startGame();
    await scoreFourCycles();
    await endGame();

    expect(screen.getAllByRole('button', { name: 'Edit game' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Download QBJ backup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit result' })).toBeDisabled();
  });

  test('Copy stats puts the derived game on the clipboard', async () => {
    const clipboard = captureClipboard();
    await openApp();
    await fillSetup({ label: 'R1 · 315' });
    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');
    await startGame();
    await scoreFourCycles();
    await endGame();

    await press('Copy stats');

    await waitFor(() => expect(clipboard.texts).toHaveLength(1));
    const rows = clipboard.texts[0].split('\n');
    expect(rows[0]).toMatch(/^Game\tR1 · 315/);
    expect(rows).toContain('Result\tDorman\t75\tWren A\t35');
    expect(rows).toContain('Tossups heard\t4');
    expect(rows).toContain('Team\tPoints\tTossups\tBonuses');
    expect(rows).toContain('Dorman\t75\t25\t50');
    expect(rows).toContain('Team\tPlayer\tTUH\t+15\t+10\tPts');
    expect(rows).toContain('Dorman\tAlice\t4\t1\t0\t15');
    expect(rows).toContain('Wren A\tDev\t4\t1\t0\t15');
    // No neg column anywhere in a format that has no neg.
    expect(clipboard.texts[0]).not.toContain('-5');
  });

  test('the canonical spreadsheet copy is still offered', async () => {
    await openApp();
    await fillSetup();
    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');
    await startGame();
    await scoreFourCycles();
    await endGame();

    expect(screen.getByRole('button', { name: 'Copy game for tournament spreadsheet' })).toBeInTheDocument();
  });
});

describe('finishing without anywhere to send it', () => {
  /** Submit the result, which for a local game is just filing it on this device. */
  async function submit(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Final score confirmed with both teams'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Submit result'));
    });
    await screen.findByText('Final');
  }

  test('the completion screen shows the full stat sheet and the next actions', async () => {
    await openApp();
    await fillSetup({ label: 'R1 · 315' });
    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');
    await startGame();
    await scoreFourCycles();
    await endGame();
    await submit();

    const stats = screen.getByLabelText('Final statistics');
    expect(within(stats).getByText(/4 tossups heard/)).toBeInTheDocument();
    const dorman = within(stats).getByLabelText('Dorman players');
    const alice = within(dorman).getByRole('row', { name: /Alice/ });
    expect(
      within(alice)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['4', '1', '0', '15']);

    expect(within(stats).getByRole('button', { name: 'Copy stats' })).toBeInTheDocument();
    expect(within(stats).getByRole('button', { name: 'Download QBJ backup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review score' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rematch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  test('Copy stats on the completion screen matches the finished game', async () => {
    const clipboard = captureClipboard();
    await openApp();
    await fillSetup({ label: 'R1 · 315' });
    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');
    await startGame();
    await scoreFourCycles();
    await endGame();
    await submit();

    await press('Copy stats');

    await waitFor(() => expect(clipboard.texts).toHaveLength(1));
    const rows = clipboard.texts[0].split('\n');
    expect(rows).toContain('Result\tDorman\t75\tWren A\t35');
    expect(rows).toContain('Team\tPlayer\tTUH\t+15\t+10\tPts');
    expect(rows).toContain('Wren A\tCleo\t4\t0\t1\t10');
  });

  test('the QBJ backup still writes the ordinary result document', async () => {
    const downloads = captureDownloads();
    await openApp();
    await fillSetup({ label: 'R1 · 315' });
    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');
    await startGame();
    await scoreFourCycles();
    await endGame();
    await submit();

    await press('Download QBJ backup');

    expect(downloads.files).toHaveLength(1);
    const document_ = JSON.parse(downloads.files[0].contents) as {
      match_teams: { team: { name: string } }[];
    };
    expect(document_.match_teams.map((matchTeam) => matchTeam.team.name)).toEqual(['Dorman', 'Wren A']);
    // The ordinary exports are untouched: the same disclosure, the same recorded download.
    expect(await screen.findByText(/QBJ downloaded/)).toBeInTheDocument();
    expect(screen.getByText('Files & exports')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Excel scoresheet' })).toBeInTheDocument();
  });

  test('a refresh mid-game still comes back to the same score', async () => {
    await openApp();
    await fillSetup({ label: 'R1 · 315' });
    await loadRulePreset('15/10, bonuses, no negs, 20 tossups');
    await startGame();
    await score('Alice', 'P');
    await bonus('20');

    cleanup();
    await openApp();

    expect(await screen.findByText('Unfinished game')).toBeInTheDocument();
    expect(screen.getByText('Dorman vs Wren A')).toBeInTheDocument();
    await press('Resume');
    await waitFor(() => expect(screen.getByLabelText('Dorman score')).toHaveTextContent('35'));
  });
});
