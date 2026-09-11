import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { playedTournament } from '../../../tests/directorFixtures';
import type { AnnounceInput } from '../notices';
import { SqbsTournamentDialog } from './SqbsTournamentDialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.__TAURI_INTERNALS__;
});

test('a cancelled native save does not announce SQBS compatibility warnings afterward', async () => {
  const state = playedTournament();
  // Unknown detail is intentionally exportable but produces compatibility warnings,
  // which makes this a useful regression case for the post-save announcement path.
  state.games[0]!.detailedStats = 'unknown';

  const invoke = vi.fn(async () => ({ path: null }));
  window.__TAURI_INTERNALS__ = { invoke };
  const onAnnounce = vi.fn<(announcement: AnnounceInput) => void>();

  render(<SqbsTournamentDialog state={state} onAnnounce={onAnnounce} onClose={vi.fn()} />);

  expect(screen.getAllByText('Export warning').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: /Download Ninety-Six-Invitational-tournament\.sqbs/ }));

  await waitFor(() => {
    expect(onAnnounce).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'SQBS tournament save cancelled.' }),
    );
  });

  expect(
    onAnnounce.mock.calls.some(
      ([announcement]) => typeof announcement === 'object' && announcement.tone === 'warning',
    ),
  ).toBe(false);
});
