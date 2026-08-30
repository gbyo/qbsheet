/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';
import { setupFromPackage } from '../src/app/App';
import { connectionStorageKey, readConnection, writeConnection } from '../src/app/ConnectedSession';
import {
  operatorNameAskedStorageKey,
  operatorNameStorageKey,
  readOperatorName,
  readOperatorNameAsked,
  writeOperatorName,
  writeOperatorNameAsked,
} from '../src/app/OperatorIdentity';
import SettingsDialog from '../src/app/SettingsDialog';
import { ResultDeliveryCapabilityStore } from '../src/app/ResultDeliveryCapability';
import { gameRecordVersion, GameStore, IStoredGameRecord } from '../src/game/GameStore';
import { openRecordStore } from '../src/persistence/GameDatabase';
import { buildLabel } from '../src/pwa/BuildVersion';
import {
  keyboardActionLabels,
  keyboardSeatNumbers,
  keyboardShortcutLabels,
} from '../src/scorer/KeyboardScoring';
import {
  keyboardEnabled,
  loadKeyboardEnabled,
  resetKeyboardPreference,
  setKeyboardEnabled,
} from '../src/scorer/keyboardPreference';
import useKeyboardEnabled from '../src/scorer/useKeyboardEnabled';
import { openApp, openGameFile, startLineups } from './appHarness';
import { validPackage } from './packages';

const connection: {
  baseUrl: string;
  roomId: string;
  roomName: string;
  roomToken: string;
  deviceId: string;
  sessionId: string;
  sessionToken: string;
  tournamentKey: string;
  gameRecordId?: string;
} = {
  baseUrl: 'http://192.168.1.20:8787',
  roomId: 'room-204-internal',
  roomName: 'Room 204',
  roomToken: 'room-token-secret',
  deviceId: 'device-secret',
  sessionId: 'session-1',
  sessionToken: 'session-token-secret',
  tournamentKey: 'spring-2026',
};

function rememberConnection(overrides: Partial<typeof connection> = {}): void {
  writeConnection({ ...connection, ...overrides });
}

/**
 * When the seeded game finished, relative to whenever this suite runs.
 *
 * These were fixed dates in August 2026, and both of the things that age a completed game are
 * measured against the real clock: `GameStore.prune` drops a record past
 * `completedGameRetentionMs`, and a delivery capability expires on the same seven-day window. So the
 * suite passed for a week and then failed everywhere, asserting that a game it had just seeded was
 * still there while the application correctly pruned it as a fortnight old.
 *
 * Nothing here asserts the literal timestamps -- they are only written -- so the fix is to seed a
 * game that finished a minute ago instead of one that finished last week.
 */
const completedAt = new Date(Date.now() - 60_000).toISOString();
const qbjDownloadedAt = new Date(Date.now() - 50_000).toISOString();
const handoffAcknowledgedAt = new Date(Date.now() - 40_000).toISOString();

async function seedGame(
  options: { connected?: boolean; completed?: boolean } = {},
): Promise<IStoredGameRecord> {
  const packageValue = validPackage();
  const store = new GameStore(await openRecordStore<IStoredGameRecord>());
  const record = await store.create({
    package: packageValue,
    setup: setupFromPackage(packageValue),
    connected: options.connected === true,
    ...(options.connected ? { gameKey: connection.sessionId } : {}),
  });
  if (!options.completed) return record;
  return (await store.update(record.id, {
    completedAt,
    finalQbj: { type: 'Match' },
    finalScore: { left: 10, right: 0 },
    serverDelivery: options.connected ? 'pending' : 'none',
  })) as IStoredGameRecord;
}

function defaultSettingsProps(overrides: Partial<React.ComponentProps<typeof SettingsDialog>> = {}) {
  return {
    operatorName: '',
    onOperatorNameChange: () => undefined,
    connection: null,
    onForgetPairing: () => undefined,
    onResetDevicePreferences: () => undefined,
    practiceInProgress: false,
    onPractice: () => undefined,
    onReadiness: () => undefined,
    onClose: () => undefined,
    ...overrides,
  };
}

function KeyboardSubscriber() {
  const enabled = useKeyboardEnabled();
  return <output aria-label="Keyboard subscriber">{enabled ? 'on' : 'off'}</output>;
}

async function openSettings(): Promise<HTMLElement> {
  // Paired idle devices now land in their room. Back remains the deliberate path to file/manual
  // workflows and device settings, so connection-setting tests exercise that path first.
  const back = screen.queryByRole('button', { name: 'Back' });
  if (back) fireEvent.click(back);
  const cog = await screen.findByRole('button', { name: 'Settings' });
  fireEvent.click(cog);
  return screen.getByRole('dialog', { name: 'Settings' });
}

beforeEach(() => {
  setKeyboardEnabled(false);
  resetKeyboardPreference();
});

describe('homepage Settings entry and scorekeeper identity', () => {
  test('the cog opens Settings instead of the old single-purpose editor', async () => {
    writeOperatorNameAsked();
    await openApp();

    const dialog = await openSettings();
    expect(within(dialog).getByText('Scoring')).toBeInTheDocument();
    expect(within(dialog).getByText('Device')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Scorekeeper' })).toBeNull();
  });

  test('practice stays on the homepage and is not hidden in Settings', async () => {
    writeOperatorNameAsked();
    await openApp();

    expect(screen.getByRole('button', { name: 'Practice scoring' })).toBeInTheDocument();
    let dialog = await openSettings();
    expect(within(dialog).queryByRole('button', { name: 'Practice scoring' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    cleanup();
    await seedGame({ completed: true });
    await openApp();

    expect(screen.getByRole('button', { name: 'Practice scoring' })).toBeInTheDocument();
    dialog = await openSettings();
    expect(within(dialog).queryByRole('button', { name: 'Practice scoring' })).toBeNull();
  });

  test('a never-asked device still asks once, while an unfinished game keeps Resume in front', async () => {
    await openApp();
    expect(await screen.findByRole('dialog', { name: 'Who is scoring?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(readOperatorNameAsked()).toBe(true);

    cleanup();
    await openApp();
    expect(screen.queryByRole('dialog', { name: 'Who is scoring?' })).toBeNull();

    cleanup();
    window.localStorage.removeItem(operatorNameAskedStorageKey);
    await seedGame();
    await openApp();
    expect(await screen.findByText('Unfinished game')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Who is scoring?' })).toBeNull();
  });

  test('Not you opens the scorekeeper editor directly; Cancel does not mutate and Save updates the greeting', async () => {
    writeOperatorName('Gibson Bell');
    writeOperatorNameAsked();
    await openApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Not you?' }));
    let dialog = screen.getByRole('dialog', { name: 'Scorekeeper' });
    const input = within(dialog).getByRole('textbox', { name: 'Name (optional)' });
    fireEvent.change(input, { target: { value: 'Half typed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(readOperatorName()).toBe('Gibson Bell');
    expect(screen.getByText('Hello, Gibson.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Not you?' }));
    dialog = screen.getByRole('dialog', { name: 'Scorekeeper' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name (optional)' }), {
      target: { value: 'Jamie Rivera' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(readOperatorName()).toBe('Jamie Rivera');
    expect(screen.getByText('Hello, Jamie.')).toBeInTheDocument();
  });
});

describe('shared keyboard preference and generic reference', () => {
  test('Settings and every existing subscriber update immediately in both directions and persist', () => {
    render(
      <>
        <SettingsDialog {...defaultSettingsProps()} />
        <KeyboardSubscriber />
      </>,
    );
    const toggle = screen.getByRole('switch', { name: 'Keyboard scoring' });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(keyboardEnabled()).toBe(true);
    expect(loadKeyboardEnabled()).toBe(true);
    expect(screen.getByLabelText('Keyboard subscriber')).toHaveTextContent('on');

    act(() => setKeyboardEnabled(false));
    expect(toggle).not.toBeChecked();
    expect(screen.getByLabelText('Keyboard subscriber')).toHaveTextContent('off');

    act(() => setKeyboardEnabled(true));
    act(() => resetKeyboardPreference());
    expect(keyboardEnabled()).toBe(true);
  });

  test('the reference uses canonical keys and seats without claiming fixed point values', () => {
    render(<SettingsDialog {...defaultSettingsProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });

    expect(dialog).toHaveTextContent(keyboardSeatNumbers.left.join(', '));
    expect(dialog).toHaveTextContent(keyboardSeatNumbers.right.join(', '));
    expect(dialog).toHaveTextContent(`Seat then ${keyboardActionLabels.correct}`);
    expect(dialog).toHaveTextContent(`Seat then ${keyboardActionLabels.wrong}`);
    expect(dialog).toHaveTextContent(keyboardShortcutLabels.noBuzz);
    expect(dialog).toHaveTextContent(keyboardShortcutLabels.undo);
    expect(dialog).toHaveTextContent(keyboardShortcutLabels.redo);
    expect(dialog).toHaveTextContent(/point values depend on the tournament format/i);
    expect(dialog.textContent).not.toMatch(/[+-]\d+\s*(?:points?)?/i);
  });

  test('the existing in-game Game menu reads and changes the same Settings preference', async () => {
    writeOperatorNameAsked();
    await openApp();
    const dialog = await openSettings();
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Keyboard scoring' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    await openGameFile();
    await startLineups();
    fireEvent.click(screen.getByText('Game'));
    const menuToggle = screen.getByRole('menuitem', { name: 'Keyboard scoring: on' });
    fireEvent.click(menuToggle);
    expect(keyboardEnabled()).toBe(false);
    expect(loadKeyboardEnabled()).toBe(false);
  });
});

describe('tournament connection safety', () => {
  test('the section appears only when paired and App exposes only a sanitized address', async () => {
    writeOperatorNameAsked();
    await openApp();
    let dialog = await openSettings();
    expect(within(dialog).queryByText('Tournament connection')).toBeNull();

    cleanup();
    rememberConnection({
      baseUrl:
        'http://url-user:url-password@192.168.1.20:8787/control?room_token=query-secret#fragment-secret',
    });
    await openApp();
    dialog = await openSettings();
    expect(within(dialog).getByText('Tournament connection')).toBeInTheDocument();
    expect(within(dialog).getByText('Room 204')).toBeInTheDocument();
    expect(within(dialog).getByText('http://192.168.1.20:8787/control')).toBeInTheDocument();
    for (const secret of [
      'url-user',
      'url-password',
      'query-secret',
      'fragment-secret',
      connection.roomToken,
      connection.sessionToken,
      connection.roomId,
      connection.deviceId,
      connection.sessionId,
    ]) {
      expect(document.body.textContent).not.toContain(secret);
    }
  });

  test('forget requires confirmation, clears pairing immediately, and leaves all games intact', async () => {
    writeOperatorNameAsked();
    const saved = await seedGame({ completed: true });
    rememberConnection({ sessionId: undefined, sessionToken: undefined });
    await openApp();
    const dialog = await openSettings();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Forget pairing…' }));
    expect(readConnection()).not.toBeNull();
    const confirmation = screen.getByRole('dialog', { name: 'Forget tournament pairing?' });
    expect(confirmation).toHaveTextContent('Saved games are not deleted');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Forget Room 204' }));

    expect(readConnection()).toBeNull();
    expect(screen.queryByText('Room 204 · Paired')).toBeNull();
    expect(screen.queryByText('Tournament connection')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Tournament pairing forgotten.');
    expect((await new GameStore(await openRecordStore<IStoredGameRecord>()).get(saved.id))?.id).toBe(
      saved.id,
    );
  });

  test('forget is blocked while an unfinished connected game still depends on this pairing', async () => {
    writeOperatorNameAsked();
    const unfinished = await seedGame({ connected: true });
    rememberConnection({ gameRecordId: unfinished.id });
    await openApp();
    const dialog = await openSettings();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forget pairing…' }));

    const confirmation = screen.getByRole('dialog', { name: 'Forget tournament pairing?' });
    expect(within(confirmation).getByRole('alert')).toHaveTextContent(
      /resume and finish the game, or ask tournament control/i,
    );
    expect(within(confirmation).getByRole('button', { name: 'Forget Room 204' })).toBeDisabled();
    expect(readConnection()).not.toBeNull();
    expect((await new GameStore(await openRecordStore<IStoredGameRecord>()).get(unfinished.id))?.id).toBe(
      unfinished.id,
    );
  });

  test('an unreadable game named by the connection still protects the pairing', async () => {
    writeOperatorNameAsked();
    const saved = await seedGame({ connected: true });
    const records = await openRecordStore<IStoredGameRecord>();
    await records.put({ ...saved, version: gameRecordVersion + 99 });
    rememberConnection({ gameRecordId: saved.id });

    await openApp();

    expect(screen.getByRole('alert')).toHaveTextContent(/newer version|cannot be opened/i);
    const dialog = await openSettings();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forget pairing…' }));

    const confirmation = screen.getByRole('dialog', { name: 'Forget tournament pairing?' });
    expect(within(confirmation).getByRole('alert')).toHaveTextContent(/cannot change Room 204/i);
    expect(within(confirmation).getByRole('button', { name: 'Forget Room 204' })).toBeDisabled();
    expect(readConnection()).not.toBeNull();
  });
});

describe('device navigation, reset, build identity, and dialog behavior', () => {
  test('device readiness is only available from Settings', async () => {
    writeOperatorNameAsked();
    await openApp();
    expect(screen.queryByRole('button', { name: 'Check this device' })).toBeNull();

    const dialog = await openSettings();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check this device' }));
    expect(await screen.findByText('Device readiness')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /QBSheet/ }));
    expect(screen.queryByRole('button', { name: 'Check this device' })).toBeNull();
  });

  test('reset is confirmed, clears only device preferences live, preserves games and retry capability, and restores first-run on reload', async () => {
    writeOperatorName('Gibson Bell');
    writeOperatorNameAsked();
    setKeyboardEnabled(true);
    const saved = await seedGame({ connected: true, completed: true });
    const store = new GameStore(await openRecordStore<IStoredGameRecord>());
    await store.update(saved.id, {
      qbjDownloadedAt,
      handoffAcknowledgedAt,
    });
    rememberConnection({ gameRecordId: saved.id });
    const capabilities = new ResultDeliveryCapabilityStore();
    capabilities.remember(
      saved.id,
      { baseUrl: connection.baseUrl, sessionId: connection.sessionId, sessionToken: connection.sessionToken },
      saved.completedAt as string,
    );
    window.localStorage.setItem('qbsheet.unrelated-sentinel', 'keep');

    await openApp();
    let dialog = await openSettings();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset device preferences…' }));
    let confirmation = screen.getByRole('dialog', { name: 'Reset device preferences?' });
    expect(confirmation).toHaveTextContent('Saved games are not deleted');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(readOperatorName()).toBe('Gibson Bell');
    expect(readConnection()).not.toBeNull();

    dialog = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset device preferences…' }));
    confirmation = screen.getByRole('dialog', { name: 'Reset device preferences?' });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Reset preferences' }));

    expect(window.localStorage.getItem(operatorNameStorageKey)).toBeNull();
    expect(window.localStorage.getItem(operatorNameAskedStorageKey)).toBeNull();
    expect(window.localStorage.getItem(connectionStorageKey)).toBeNull();
    expect(readOperatorNameAsked()).toBe(false);
    expect(keyboardEnabled()).toBe(false);
    expect(screen.queryByRole('switch', { name: 'Keyboard scoring' })).toBeNull();
    expect(screen.queryByText('Hello, Gibson.')).toBeNull();
    expect(screen.queryByText('Tournament connection')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Device preferences reset.');
    expect(window.localStorage.getItem('qbsheet.unrelated-sentinel')).toBe('keep');
    expect(capabilities.has(saved.id)).toBe(true);
    expect((await new GameStore(await openRecordStore<IStoredGameRecord>()).get(saved.id))?.id).toBe(
      saved.id,
    );

    cleanup();
    await openApp();
    expect(await screen.findByRole('dialog', { name: 'Who is scoring?' })).toBeInTheDocument();
  });

  test('reset follows the same unfinished connected-game protection and changes nothing when blocked', async () => {
    writeOperatorName('Gibson Bell');
    writeOperatorNameAsked();
    setKeyboardEnabled(true);
    const unfinished = await seedGame({ connected: true });
    rememberConnection({ gameRecordId: unfinished.id });
    await openApp();
    const dialog = await openSettings();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset device preferences…' }));

    const confirmation = screen.getByRole('dialog', { name: 'Reset device preferences?' });
    expect(within(confirmation).getByRole('button', { name: 'Reset preferences' })).toBeDisabled();
    expect(within(confirmation).getByRole('alert')).toHaveTextContent(/resume and finish/i);
    expect(readOperatorName()).toBe('Gibson Bell');
    expect(readOperatorNameAsked()).toBe(true);
    expect(keyboardEnabled()).toBe(true);
    expect(readConnection()).not.toBeNull();
    expect((await new GameStore(await openRecordStore<IStoredGameRecord>()).get(unfinished.id))?.id).toBe(
      unfinished.id,
    );
  });

  test('the footer uses the canonical build label, Escape closes, and focus returns to the cog', async () => {
    writeOperatorNameAsked();
    await openApp();
    const cog = await screen.findByRole('button', { name: 'Settings' });
    cog.focus();
    fireEvent.click(cog);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveTextContent(`QBSheet ${buildLabel()}`);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(cog).toHaveFocus();
  });

  test('all Settings actions remain reachable in the narrow layout', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    render(
      <SettingsDialog
        {...defaultSettingsProps({ connection: { roomName: 'Room 204', address: connection.baseUrl } })}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('button', { name: /Set name/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('switch', { name: 'Keyboard scoring' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Practice scoring' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Forget pairing…' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Check this device' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Reset device preferences…' })).toBeInTheDocument();
  });
});
