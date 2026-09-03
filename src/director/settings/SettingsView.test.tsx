/**
 * That the audit table stays a page rather than the whole day.
 *
 * Every meaningful change writes an audit event, so the history only grows; Settings used to build
 * and lay out every row of it before it could paint. Nothing may be dropped — the record is the
 * point of it — so the fix is how much is drawn at once, checked here against the two things that
 * would make paging a bug instead of a fix: a missing row, or the newest one not being first.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { tournamentState } from '../../../tests/directorFixtures';
import { SettingsView, auditPageSize } from './SettingsView';

afterEach(cleanup);

const controller = { checkpoint: vi.fn(async () => undefined) } as unknown as DirectorController;

function stateWithAudit(count: number): DirectorState {
  const state = tournamentState();
  for (let index = 0; index < count; index += 1) {
    state.audit.push({
      id: `audit-${index}`,
      at: new Date(Date.UTC(2026, 8, 5, 8, 0, index)).toISOString(),
      actor: 'director',
      type: 'tournament-updated',
      summary: `Event ${index}`,
    });
  }
  return state;
}

function auditRows(): string[] {
  const panel = screen.getByText('Audit history').closest('.director-panel') as HTMLElement;
  return within(panel)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('strong')?.textContent ?? '');
}

test('a long history draws one page, newest first, and says so', () => {
  render(<SettingsView state={stateWithAudit(130)} controller={controller} onAnnounce={vi.fn()} />);

  const rows = auditRows();
  expect(rows).toHaveLength(auditPageSize);
  expect(rows[0]).toBe('Event 129');
  expect(rows.at(-1)).toBe('Event 30');
  expect(screen.getByText('100 of 130 events')).toBeTruthy();
  expect(screen.getByText('30 earlier events')).toBeTruthy();
});

test('Load more reveals the earlier events without losing the newer ones', () => {
  render(<SettingsView state={stateWithAudit(130)} controller={controller} onAnnounce={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

  const rows = auditRows();
  expect(rows).toHaveLength(130);
  expect(rows[0]).toBe('Event 129');
  expect(rows.at(-1)).toBe('Event 0');
  // Everything is on screen, so there is nothing left to offer.
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(screen.getByText('130 events')).toBeTruthy();
});

test('a short history is drawn whole with no control at all', () => {
  render(<SettingsView state={stateWithAudit(3)} controller={controller} onAnnounce={vi.fn()} />);

  expect(auditRows()).toEqual(['Event 2', 'Event 1', 'Event 0']);
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(screen.getByText('3 events')).toBeTruthy();
});
