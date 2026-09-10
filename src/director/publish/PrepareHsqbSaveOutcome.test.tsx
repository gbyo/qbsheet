/**
 * Saving a Resource Center package is a factual state, not an inference from
 * an async function returning. Native cancellation/unavailability/failure must
 * never render the same confirmation as a completed write (#829).
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { playedTournament } from '../../../tests/directorFixtures';
import type { AnnounceInput } from '../notices';
import { isNativeDirector, saveNativeFile } from '../platform/native';
import { PrepareHsqbDialog } from './PrepareHsqbDialog';

vi.mock('../platform/native', () => ({
  isNativeDirector: vi.fn(() => true),
  saveNativeFile: vi.fn(),
}));

const mockedIsNativeDirector = vi.mocked(isNativeDirector);
const mockedSaveNativeFile = vi.mocked(saveNativeFile);

function renderDialog(
  onAnnounce: (announcement: AnnounceInput) => void = vi.fn(),
): void {
  render(
    <PrepareHsqbDialog
      state={playedTournament()}
      onAnnounce={onAnnounce}
      onClose={vi.fn()}
      onNavigate={vi.fn()}
    />,
  );
}

function clickSave(): void {
  fireEvent.click(
    screen.getByRole('button', {
      name: /Save Ninety-Six-Invitational-resource-center\.zip/,
    }),
  );
}

async function expectSaveEnabled(): Promise<void> {
  await waitFor(() => {
    expect(
      screen
        .getByRole('button', { name: /Save .*\.zip/ })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
}

beforeEach(() => {
  mockedIsNativeDirector.mockReturnValue(true);
  mockedSaveNativeFile.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('successful native write shows the saved confirmation', async () => {
  mockedSaveNativeFile.mockResolvedValue({
    status: 'saved',
    path: '/tmp/Ninety-Six-Invitational-resource-center.zip',
  });
  renderDialog();

  clickSave();

  expect(await screen.findByText('Saved — not yet published')).toBeTruthy();
  expect(mockedSaveNativeFile).toHaveBeenCalledTimes(1);
});

test('cancelled native save leaves the package unsaved', async () => {
  const onAnnounce: (announcement: AnnounceInput) => void = vi.fn();
  mockedSaveNativeFile.mockResolvedValue({ status: 'cancelled' });
  renderDialog(onAnnounce);

  clickSave();

  await waitFor(() => expect(mockedSaveNativeFile).toHaveBeenCalledTimes(1));
  await expectSaveEnabled();
  expect(screen.queryByText('Saved — not yet published')).toBeNull();
  expect(onAnnounce).toHaveBeenCalled();
});

test('unavailable native save leaves the package unsaved', async () => {
  mockedSaveNativeFile.mockResolvedValue({ status: 'unavailable' });
  renderDialog();

  clickSave();

  await waitFor(() => expect(mockedSaveNativeFile).toHaveBeenCalledTimes(1));
  await expectSaveEnabled();
  expect(screen.queryByText('Saved — not yet published')).toBeNull();
});

test('native write failure does not create a saved state', async () => {
  const onAnnounce: (announcement: AnnounceInput) => void = vi.fn();
  mockedSaveNativeFile.mockRejectedValue(new Error('disk full'));
  renderDialog(onAnnounce);

  clickSave();

  await waitFor(() => expect(mockedSaveNativeFile).toHaveBeenCalledTimes(1));
  await expectSaveEnabled();
  expect(screen.queryByText('Saved — not yet published')).toBeNull();
  expect(onAnnounce).toHaveBeenCalled();
});
