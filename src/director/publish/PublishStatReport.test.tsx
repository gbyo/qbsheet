import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { playedTournament } from '../../../tests/directorFixtures';
import { PublishView } from './PublishView';

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

test('Exports offers the Resource Center report as a first-class download', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  const row = screen.getByText('Resource Center report').closest('[role="listitem"]') as HTMLElement;
  expect(row).toBeTruthy();
  expect(within(row).getByRole('button', { name: 'Download ZIP' })).toBeTruthy();
  expect(row.textContent).toContain('standings');
  expect(row.textContent).toContain('scoreboard');
  expect(row.textContent).toContain('stat-key');
});
