import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import GamePackageCreator, {
  gamePackageCreatorDraftKey,
} from '../src/game-package-creator/GamePackageCreator';
import ManualGameSetup from '../src/app/ManualGameSetup';
import { manualDraftStorageKey } from '../src/app/ManualGameDraft';
import { portableInput } from './portableSetupFixtures';

afterEach(cleanup);

test('the creator and Create Game share validation, and invalid input cannot generate a QR', async () => {
  const creator = render(<GamePackageCreator />);
  fireEvent.click(screen.getByRole('button', { name: 'Generate package' }));
  expect(await screen.findByText('Enter a name for the left team.')).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'Game setup QR code' })).toBeNull();
  creator.unmount();
  render(
    <ManualGameSetup
      onStart={() => {
        throw new Error('Must not start');
      }}
      onCancel={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
  expect(await screen.findByText('Enter a name for the left team.')).toBeInTheDocument();
});

test('creator persists and restores its own draft without touching the scorer draft; SVG is downloadable and can regenerate', async () => {
  const scorer = JSON.stringify({ ...portableInput(), gameLabel: 'Scorer draft' });
  localStorage.setItem(manualDraftStorageKey, scorer);
  localStorage.setItem(gamePackageCreatorDraftKey, JSON.stringify(portableInput(true)));
  let creator = render(<GamePackageCreator />);
  expect(screen.getByLabelText('Left team name')).toHaveValue(portableInput().left.name);
  fireEvent.change(screen.getByLabelText('Left team name'), { target: { value: 'Creator team' } });
  await waitFor(() => expect(localStorage.getItem(gamePackageCreatorDraftKey)).toContain('Creator team'));
  expect(localStorage.getItem(manualDraftStorageKey)).toBe(scorer);
  creator.unmount();
  creator = render(<GamePackageCreator />);
  expect(screen.getByLabelText('Left team name')).toHaveValue('Creator team');
  fireEvent.click(screen.getByRole('button', { name: 'Generate package' }));
  const download = await screen.findByRole('link', { name: 'Download SVG' });
  expect(download).toHaveAttribute('download', 'qbsheet-game-setup.svg');
  const href = download.getAttribute('href')!;
  const svg = decodeURIComponent(href.slice(href.indexOf(',') + 1));
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect(doc.documentElement.localName).toBe('svg');
  expect(doc.querySelectorAll('path')).toHaveLength(1);
  expect(screen.getByRole('img', { name: 'Game setup QR code' })).toHaveAttribute('src', href);
  const first = href;
  fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }));
  fireEvent.change(screen.getByLabelText('Left team name'), { target: { value: 'Another team' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate package' }));
  await waitFor(() =>
    expect(screen.getByRole('link', { name: 'Download SVG' }).getAttribute('href')).not.toBe(first),
  );
  expect(localStorage.getItem(manualDraftStorageKey)).toBe(scorer);
  creator.unmount();
});
