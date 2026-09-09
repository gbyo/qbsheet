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
import { DirtyFormProvider } from '../components/Fields';

afterEach(cleanup);

const controller = { checkpoint: vi.fn(async () => undefined) } as unknown as DirectorController;

function settingsController(updateTournament: (draft: unknown) => boolean = vi.fn(() => true)) {
  return { checkpoint: vi.fn(async () => undefined), updateTournament } as unknown as DirectorController;
}

function renderGeneral(options?: {
  updateTournament?: (draft: unknown) => boolean;
  onSaveOperator?: (profile: { displayName: string; role?: string }) => boolean;
}) {
  const state = tournamentState();
  render(
    <DirtyFormProvider>
      <SettingsView
        state={state}
        controller={settingsController(options?.updateTournament)}
        onAnnounce={vi.fn()}
        operatorProfile={{ displayName: 'Director', role: 'Local operator' }}
        onSaveOperator={options?.onSaveOperator ?? vi.fn(() => true)}
      />
    </DirtyFormProvider>,
  );
}

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

/**
 * Audit is one of Settings' four sections now — ordinary configuration,
 * recovery, audit, and system diagnostics are separated rather than stacked —
 * so the history is reached by selecting it. The paging behaviour it protects
 * is unchanged: a full day's history is thousands of rows, and drawing them all
 * before the page can paint is what the paging exists to prevent.
 */
function showAudit(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Audit/ }));
}

function auditRows(): string[] {
  return within(screen.getByRole('list', { name: 'Audit history' }))
    .getAllByRole('listitem')
    .map((row) => row.querySelector('strong')?.textContent ?? '');
}

test('a long history draws one page, newest first, and says so', () => {
  render(<SettingsView state={stateWithAudit(130)} controller={controller} onAnnounce={vi.fn()} />);
  showAudit();

  const rows = auditRows();
  expect(rows).toHaveLength(auditPageSize);
  expect(rows[0]).toBe('Event 129');
  expect(rows.at(-1)).toBe('Event 30');
  expect(screen.getByText(/100 of 130 meaningful changes/)).toBeTruthy();
  expect(screen.getByText('30 earlier events')).toBeTruthy();
});

test('Load more reveals the earlier events without losing the newer ones', () => {
  render(<SettingsView state={stateWithAudit(130)} controller={controller} onAnnounce={vi.fn()} />);
  showAudit();

  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

  const rows = auditRows();
  expect(rows).toHaveLength(130);
  expect(rows[0]).toBe('Event 129');
  expect(rows.at(-1)).toBe('Event 0');
  // Everything is on screen, so there is nothing left to offer.
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(screen.getByText(/^130 meaningful changes/)).toBeTruthy();
});

test('a short history is drawn whole with no control at all', () => {
  render(<SettingsView state={stateWithAudit(3)} controller={controller} onAnnounce={vi.fn()} />);
  showAudit();

  expect(auditRows()).toEqual(['Event 2', 'Event 1', 'Event 0']);
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(screen.getByText(/^3 meaningful changes/)).toBeTruthy();
});

test('General forms visibly mark dirty drafts and keep them across Settings section switches', () => {
  renderGeneral();
  const name = screen.getByLabelText('Name');
  fireEvent.change(name, { target: { value: 'Draft tournament name' } });

  expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
  expect(screen.getByRole('button', { name: 'Save tournament details' })).toBeEnabled();

  fireEvent.click(screen.getByRole('button', { name: /^Recovery/ }));
  fireEvent.click(screen.getByRole('button', { name: /^General/ }));

  expect(screen.getByLabelText('Name')).toHaveValue('Draft tournament name');
  expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
});

test('successful General save reports Saved and clears the dirty state', () => {
  const updateTournament = vi.fn(() => true);
  renderGeneral({ updateTournament });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Committed name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save tournament details' }));

  expect(updateTournament).toHaveBeenCalledWith(expect.objectContaining({ name: 'Committed name' }));
  expect(screen.getByRole('status')).toHaveTextContent('Saved');
  expect(screen.getByRole('button', { name: 'Save tournament details' })).toBeDisabled();
});

test('rejected General save keeps the draft dirty and Discard changes restores the baseline', () => {
  const updateTournament = vi.fn(() => false);
  renderGeneral({ updateTournament });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rejected draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save tournament details' }));

  expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
  fireEvent.click(screen.getAllByRole('button', { name: 'Discard changes' })[0]!);

  expect(screen.getByLabelText('Name')).toHaveValue(tournamentState().tournament?.name);
  expect(screen.queryByText('Unsaved changes')).toBeNull();
});

test('dirty General forms install the native browser reload warning', () => {
  renderGeneral();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reload draft' } });

  const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});
