import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { playedTournament } from '../../../tests/directorFixtures';
import { reportPreferenceKey } from '../reports/reportPreferences';
import { PublishView } from './PublishView';

beforeEach(() => {
  window.localStorage.clear();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

test('Report options saves page and metric preferences locally without changing tournament state', () => {
  const state = playedTournament();
  const before = structuredClone(state);
  const announce = vi.fn();
  render(<PublishView state={state} onAnnounce={announce} />);

  const row = screen.getByText('Printable stat report').closest('[role="listitem"]') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Report options' }));
  const dialog = screen.getByRole('dialog', { name: 'Printable report options' });

  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Individuals' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Points per regulation set' }));
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Packet when known' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save report options' }));

  const stored = JSON.parse(window.localStorage.getItem(reportPreferenceKey(state.tournament!.id))!);
  expect(stored.pages).not.toContain('individuals');
  expect(stored.pointsMetric).toBe('pointsPerX');
  expect(stored.showPacket).toBe(false);
  expect(state).toEqual(before);
  expect(announce).toHaveBeenCalledWith({
    message: 'Printable report options saved on this Director.',
    tone: 'info',
  });
});
