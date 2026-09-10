import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { playedTournament, tournamentState } from '../../../tests/directorFixtures';
import { toDirectorNotice, type AnnounceInput } from '../notices';
import { downloadResourceCenterReport, PublishView } from './PublishView';

afterEach(() => cleanup());

test('Exports offers the canonical printable stat report as a first-class download', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  const row = screen.getByText('Printable stat report').closest('[role="listitem"]') as HTMLElement;
  expect(row).toBeTruthy();
  expect(within(row).getByRole('button', { name: 'Download report' })).toBeTruthy();
  expect(row.textContent).toContain('standings');
  expect(row.textContent).toContain('individuals');
  expect(row.textContent).toContain('games');
});

test('the standalone standings HTML is described as a view of the canonical report', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  const row = screen.getByText('Team standings HTML').closest('[role="listitem"]') as HTMLElement;
  expect(row.textContent).toContain('same canonical snapshot and renderer');
});

test('Exports offers the Resource Center preparation as a first-class workflow', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  const row = screen.getByText('Quizbowl Resource Center').closest('[role="listitem"]') as HTMLElement;
  expect(row).toBeTruthy();
  expect(within(row).getByRole('button', { name: 'Prepare for HSQuizbowl' })).toBeTruthy();
  expect(row.textContent).toContain('hsquizbowl.org');
});

test('Exports never calls the Resource Center report upload-ready before the live smoke test', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  const row = screen.getByText('Quizbowl Resource Center').closest('[role="listitem"]') as HTMLElement;
  expect(row.textContent).not.toMatch(/upload-ready|compatible|ready for/i);
});

test('Resource Center download is refused while preflight fails', async () => {
  const announced: AnnounceInput[] = [];
  await downloadResourceCenterReport(tournamentState(), (announcement: AnnounceInput) => {
    announced.push(announcement);
  });
  const messages = announced.map((announcement) => toDirectorNotice(announcement).message);
  expect(messages.some((message) => message.includes('Resource Center preflight failed'))).toBe(true);
});
