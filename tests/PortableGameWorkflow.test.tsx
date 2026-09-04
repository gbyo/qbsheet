import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { openApp, press, chooseScoringLayout } from './appHarness';
import { IStoredGameRecord } from '../src/game/GameStore';
import { openRecordStore } from '../src/persistence/GameDatabase';
import { encodePortableGameSetup } from '../src/game/PortableGameSetup';
import { defineManualGame } from '../src/game/ManualGame';
import { manualDraftStorageKey } from '../src/app/ManualGameDraft';
import ConnectedSetup from '../src/app/ConnectedSetup';
import PortableGameReview from '../src/app/PortableGameReview';
import FruityServerClient from '../src/integrations/fruity/FruityServerClient';
import { portableInput } from './portableSetupFixtures';

const scanner = vi.hoisted(() => ({ decoded: undefined as undefined | ((text: string) => string | null) }));
vi.mock('../src/app/QrScannerDialog', () => ({
  default: (props: { onDecoded: (text: string) => string | null }) => {
    scanner.decoded = props.onDecoded;
    return <div role="dialog" aria-label="Test scanner" />;
  },
}));
afterEach(cleanup);
async function scan() {
  await press('Scan QR');
  const encoded = encodePortableGameSetup(portableInput(true));
  if (!encoded.ok) throw new Error(encoded.message);
  await act(async () => {
    expect(scanner.decoded?.(encoded.text)).toBeNull();
  });
  return screen.getByRole('dialog', { name: 'Review game package' });
}
async function records() {
  return (await openRecordStore<IStoredGameRecord>()).list();
}

test('Home scan reviews complete rosters and rules; Cancel and reload create nothing and do not save the scan', async () => {
  localStorage.setItem(manualDraftStorageKey, 'existing scorer draft');
  await openApp();
  const review = await scan();
  expect(review).toHaveTextContent('Nothing has been created yet');
  for (const name of ['Zoë', 'Smith, John', 'Bench player', 'Renée', 'O’Connor', 'علي'])
    expect(review).toHaveTextContent(name);
  for (const option of [
    'Superpower',
    '40-point bonuses',
    'Halftime',
    '45-second timeouts',
    '9-minute halves',
    'phase checkpoints',
    'timed',
  ])
    expect(review).toHaveTextContent(option);
  expect(await records()).toHaveLength(0);
  expect(localStorage.getItem(manualDraftStorageKey)).toBe('existing scorer draft');
  await press('Cancel');
  expect(await records()).toHaveLength(0);
  await scan(); // Reload with an unconfirmed review still open.
  cleanup();
  await openApp();
  expect(screen.queryByRole('dialog', { name: 'Review game package' })).toBeNull();
  expect(await records()).toHaveLength(0);
  expect(localStorage.getItem(manualDraftStorageKey)).toBe('existing scorer draft');
});

test('Start creates exactly one manual game after review, with ordinary identity and starting lineups', async () => {
  await openApp();
  await scan();
  expect(await records()).toHaveLength(0);
  await press('Start game');
  await waitFor(async () => expect(await records()).toHaveLength(1));
  const record = (await records())[0];
  expect(record.package).toMatchObject({ origin: 'manual' });
  expect(record.connected).toBe(false);
  const defined = defineManualGame(portableInput(true));
  expect(defined.ok).toBe(true);
  if (defined.ok) expect(record.package).toMatchObject(defined.definition);
  await chooseScoringLayout();
  await waitFor(() => expect(screen.getByLabelText('Starting lineups')).toBeInTheDocument());
});

test('Edit opens the existing editor populated with the scan and only then saves a draft', async () => {
  await openApp();
  await scan();
  expect(localStorage.getItem(manualDraftStorageKey)).toBeNull();
  await press('Edit setup');
  expect(screen.getByRole('heading', { name: 'Create a game' })).toBeInTheDocument();
  expect(screen.getByLabelText('Left team name')).toHaveValue(portableInput().left.name);
  expect(screen.getByLabelText(`${portableInput().left.name} players`)).toHaveValue(
    portableInput().left.players.replace(/\r\n/g, '\n'),
  );
  expect(await records()).toHaveLength(0);
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem(manualDraftStorageKey)!)).toEqual(portableInput(true)),
  );
});

test('ConnectedSetup preserves address, selected room, pairing code, stage and error after canceling a package review', async () => {
  const onPaired = vi.fn(),
    onPairingLaunch = vi.fn();
  const client = new FruityServerClient('http://control.example');
  const join = vi.spyOn(client, 'join').mockRejectedValue(new Error('offline'));
  render(
    <ConnectedSetup
      initialBaseUrl="http://control.example"
      initialConnection={{
        client,
        tournamentName: 'Saved tournament',
        rooms: [{ id: '204', name: 'Room 204' }],
        roomsError: 'Saved room-list warning',
      }}
      onPaired={onPaired}
      onPairingLaunch={onPairingLaunch}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('Room'), { target: { value: '204' } });
  fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: '12345678' } });
  await press('Pair this room');
  expect(screen.getByRole('alert')).toHaveTextContent('This room could not be paired');
  expect(screen.getAllByRole('button', { name: 'Scan QR' })).toHaveLength(1);
  await scan();
  await press('Cancel');
  expect(screen.getByLabelText('Room')).toHaveValue('204');
  expect(screen.getByLabelText('Pairing code')).toHaveValue('12345678');
  expect(screen.getByText('Saved tournament')).toBeInTheDocument();
  expect(screen.getByText('Saved room-list warning')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('This room could not be paired');
  expect(join).toHaveBeenCalledOnce();
  expect(onPaired).not.toHaveBeenCalled();
  expect(onPairingLaunch).not.toHaveBeenCalled();
  cleanup();
  render(
    <ConnectedSetup
      initialBaseUrl="http://typed-address.example"
      onPaired={onPaired}
      onPairingLaunch={onPairingLaunch}
      onCancel={vi.fn()}
    />,
  );
  await scan();
  await press('Cancel');
  expect(screen.getByLabelText('Tournament control address')).toHaveValue('http://typed-address.example');
});

test('review validates again before starting and blocks duplicate clicks while saving', async () => {
  const input = portableInput();
  let resolve!: () => void;
  const start = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  render(<PortableGameReview input={input} onStartManualGame={start} onCancel={vi.fn()} />);
  input.left.name = '';
  await press('Start game');
  expect(start).not.toHaveBeenCalled();
  expect(screen.getByText('This setup is invalid. Edit it before starting.')).toBeInTheDocument();
  input.left.name = 'Restored';
  const button = within(screen.getByRole('dialog')).getByRole('button', { name: 'Start game' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(start).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await act(async () => resolve());
});
