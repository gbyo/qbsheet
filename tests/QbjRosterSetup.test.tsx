/**
 * Typing in rosters a document did not carry.
 *
 * The behaviour worth protecting is the narrow one: ask for exactly the teams that are missing, and
 * for nothing else. A form that reappeared for a roster already in the file would have a scorekeeper
 * retyping correct names under time pressure, and every retyped name is a chance to spell it
 * differently from the one tournament control is holding.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { openApp, score, startLineups } from './appHarness';
import { claimResponseTimeoutMs } from '../src/persistence/TabClaim';
import { defineGame, readQbjSource } from '../src/qbj/ParseQbjAssignment';
import { playerIdentityKey } from '../src/game/GameDefinition';
import { assignmentDocument, greenwood, ninetySix, withoutRoster } from './qbjDocuments';

afterEach(cleanup);

/** jsdom implements no `File.text()`, so this carries the three members the source uses. */
function fileOf(contents: object, name: string): File {
  const text = JSON.stringify(contents);
  return { name, size: text.length, text: () => Promise.resolve(text) } as unknown as File;
}

async function choose(file: File): Promise<void> {
  const input = document.querySelector('.file-open-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input);
  });
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, claimResponseTimeoutMs + 50);
    });
  });
}

const bothMissing = () => assignmentDocument({ teams: [withoutRoster(ninetySix), withoutRoster(greenwood)] });
const onlyRightMissing = () => assignmentDocument({ teams: [ninetySix, withoutRoster(greenwood)] });

async function typeRoster(team: string, names: string[]): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(team), { target: { value: names.join('\n') } });
  });
}

async function pressUsePlayers(settle = true): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Use these players' }));
  });
  if (!settle) return;
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, claimResponseTimeoutMs + 50);
    });
  });
}

describe('a QBJ that names teams but lists no players', () => {
  test('asks for players, then scores the game', async () => {
    await openApp();
    await choose(fileOf(bothMissing(), 'no-rosters.qbj'));
    await waitFor(() => expect(screen.getByText('Rosters needed')).toBeInTheDocument());

    await typeRoster('Ninety Six', ['Sarah', 'James', 'Alex']);
    await typeRoster('Greenwood', ['Emma', 'Jordan']);
    await pressUsePlayers();

    await waitFor(() => expect(screen.queryByText('Rosters needed')).not.toBeInTheDocument());
    await startLineups();
    await score('Sarah', 'P');

    await waitFor(() => {
      expect(screen.getByLabelText('Ninety Six score')).toHaveTextContent('15');
    });
  });

  test('the two rosters may be different sizes', async () => {
    await openApp();
    await choose(fileOf(bothMissing(), 'no-rosters.qbj'));
    await waitFor(() => expect(screen.getByText('Rosters needed')).toBeInTheDocument());

    // Four against one. Rosters larger than the active limit are a lineup question, not a roster
    // one, and belong to the starting-lineup prompt rather than to this form.
    await typeRoster('Ninety Six', ['Sarah', 'James', 'Alex', 'Taylor']);
    await typeRoster('Greenwood', ['Emma']);
    await pressUsePlayers();

    await waitFor(() => expect(screen.queryByText('Rosters needed')).not.toBeInTheDocument());
    await startLineups();
    expect(screen.getByLabelText('Ninety Six score')).toBeInTheDocument();
    expect(screen.getByLabelText('Greenwood score')).toBeInTheDocument();
  });

  test('blank lines and stray whitespace are dropped', async () => {
    await openApp();
    await choose(fileOf(bothMissing(), 'no-rosters.qbj'));
    await waitFor(() => expect(screen.getByText('Rosters needed')).toBeInTheDocument());

    await typeRoster('Ninety Six', ['Sarah', '', '  James  ', '']);
    await typeRoster('Greenwood', ['Emma']);

    expect(screen.getByLabelText('Ninety Six').closest('label')?.textContent).toContain('2 players');
    await pressUsePlayers();
    await waitFor(() => expect(screen.queryByText('Rosters needed')).not.toBeInTheDocument());
  });

  test('a player listed twice is refused rather than merged', async () => {
    await openApp();
    await choose(fileOf(bothMissing(), 'no-rosters.qbj'));
    await waitFor(() => expect(screen.getByText('Rosters needed')).toBeInTheDocument());

    await typeRoster('Ninety Six', ['Sarah', '  Sarah  ', 'James']);
    await typeRoster('Greenwood', ['Emma']);
    await pressUsePlayers(false);

    expect(screen.getByText(/listed more than once/)).toBeInTheDocument();
    // Nothing started: two players sharing a name would silently merge their statistics.
    expect(screen.getByText('Rosters needed')).toBeInTheDocument();
  });

  test('a team with nobody typed in is refused', async () => {
    await openApp();
    await choose(fileOf(bothMissing(), 'no-rosters.qbj'));
    await waitFor(() => expect(screen.getByText('Rosters needed')).toBeInTheDocument());

    await typeRoster('Ninety Six', ['Sarah']);
    await pressUsePlayers(false);

    expect(screen.getByText(/Greenwood needs at least one player/)).toBeInTheDocument();
  });
});

describe('a QBJ that lists one roster and not the other', () => {
  test('only the missing team is asked for', async () => {
    await openApp();

    await choose(fileOf(onlyRightMissing(), 'one-roster.qbj'));

    await waitFor(() => expect(screen.getByText('Players needed')).toBeInTheDocument());
    expect(screen.getByLabelText('Greenwood')).toBeInTheDocument();
    // Ninety Six's roster is in the file. Asking for it again is how correct names get retyped.
    expect(screen.queryByLabelText('Ninety Six')).not.toBeInTheDocument();
  });

  test('the roster already in the file reaches the scoresheet untouched', async () => {
    await openApp();
    await choose(fileOf(onlyRightMissing(), 'one-roster.qbj'));
    await waitFor(() => expect(screen.getByText('Players needed')).toBeInTheDocument());

    await typeRoster('Greenwood', ['Emma', 'Jordan']);
    await pressUsePlayers();

    await waitFor(() => expect(screen.queryByText('Players needed')).not.toBeInTheDocument());
    await startLineups();
    await score('Taylor', 'C');

    await waitFor(() => {
      expect(screen.getByLabelText('Ninety Six score')).toHaveTextContent('10');
    });
  });
});

describe('a QBJ that lists both rosters', () => {
  test('never shows the form', async () => {
    await openApp();

    await choose(fileOf(assignmentDocument(), 'R04.assignment.qbj'));

    await waitFor(() => expect(screen.getByText(/Ninety Six/)).toBeInTheDocument());
    expect(screen.queryByText('Rosters needed')).not.toBeInTheDocument();
    expect(screen.queryByText('Players needed')).not.toBeInTheDocument();
  });
});

describe('the override path the form uses', () => {
  test('is the one the parser already checks, and it names the missing teams', () => {
    const source = readQbjSource(bothMissing());
    if (!source.ok) throw new Error('Expected a readable document');
    const index = source.value.candidates[0].index;

    const asked = defineGame(source.value, index);
    expect(asked.ok).toBe(false);
    if (asked.ok) return;
    expect(asked.needsRoster).toBe(true);
    expect(asked.missingRosters).toEqual(['Ninety Six', 'Greenwood']);

    const defined = defineGame(source.value, index, {
      rosters: { 'Ninety Six': [{ name: 'Sarah' }], Greenwood: [{ name: 'Emma' }] },
    });
    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    expect(defined.definition.left.players).toEqual([{ name: 'Sarah' }]);
    expect(defined.definition.right.players).toEqual([{ name: 'Emma' }]);
  });

  test('normalizes supplied names the same way a file is normalized', () => {
    const source = readQbjSource(bothMissing());
    if (!source.ok) throw new Error('Expected a readable document');
    const index = source.value.candidates[0].index;

    const duplicated = defineGame(source.value, index, {
      rosters: { 'Ninety Six': [{ name: 'Sarah' }, { name: ' Sarah ' }], Greenwood: [{ name: 'Emma' }] },
    });

    // Trimmed to the same name, and then refused as the duplicate it is.
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) return;
    expect(duplicated.errors.join(' ')).toContain('more than once');
  });

  test('only one team missing means only one team asked for', () => {
    const source = readQbjSource(onlyRightMissing());
    if (!source.ok) throw new Error('Expected a readable document');

    const asked = defineGame(source.value, source.value.candidates[0].index);

    expect(asked.ok).toBe(false);
    if (asked.ok) return;
    expect(asked.missingRosters).toEqual(['Greenwood']);
  });

  test('a player the document already knew keeps their id when the other side is typed in', () => {
    const source = readQbjSource(onlyRightMissing());
    if (!source.ok) throw new Error('Expected a readable document');

    const defined = defineGame(source.value, source.value.candidates[0].index, {
      rosters: { Greenwood: [{ name: 'Emma' }] },
    });

    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    // Identity is the document's to give; the form supplied names only.
    expect(defined.definition.qbjIdentity?.playerIds?.[playerIdentityKey('Ninety Six', 'Sarah')]).toBe('Player_Sarah');
    expect(defined.definition.qbjIdentity?.teamIds).toEqual({ left: ninetySix.id, right: greenwood.id });
  });
});
