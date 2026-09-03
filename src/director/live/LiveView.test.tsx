import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { defaultRules, emptyDirectorState } from '../domain';
import { LiveView, type LiveViewActions } from './LiveView';

afterEach(() => {
  vi.useRealTimers();
});

function stateWithTournament() {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-1',
    name: 'Held Claim Invitational',
    date: '2026-09-05',
    venue: '',
    organizer: '',
    status: 'draft',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  };
  return state;
}

test('Connect stays tied to the unresolved claim beyond 1.5 seconds and cannot submit twice', async () => {
  vi.useFakeTimers();
  let rejectClaim!: (reason: Error) => void;
  const enable = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectClaim = reject;
      }),
  );
  const actions: LiveViewActions = {
    enable,
    disable: vi.fn(),
    updateSettings: vi.fn(),
    publishAnnouncement: vi.fn(),
    withdrawAnnouncement: vi.fn(),
    finalize: vi.fn(),
    unpublish: vi.fn(),
    destroy: vi.fn(),
  };
  render(<LiveView state={stateWithTournament()} actions={actions} onAnnounce={vi.fn()} />);

  fireEvent.change(screen.getByPlaceholderText('https://…'), {
    target: { value: 'https://backend.example' },
  });
  const token = document.querySelector('input[type="password"]');
  expect(token).not.toBeNull();
  fireEvent.change(token!, {
    target: { value: 'one-time-token' },
  });
  const connect = screen.getByRole('button', { name: 'Connect and test' });
  fireEvent.click(connect);
  expect(enable).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();

  await vi.advanceTimersByTimeAsync(2_000);
  fireEvent.click(screen.getByRole('button', { name: 'Connecting…' }));
  expect(enable).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();

  await act(async () => {
    rejectClaim(new Error('The held claim failed.'));
    await Promise.resolve();
  });
  expect(screen.getByRole('alert')).toHaveTextContent('The held claim failed.');
  expect(screen.getByRole('button', { name: 'Connect and test' })).toBeEnabled();
});

test('backend choices are native radios in one group with keyboard support', () => {
  const actions: LiveViewActions = {
    enable: vi.fn(),
    disable: vi.fn(),
    updateSettings: vi.fn(),
    publishAnnouncement: vi.fn(),
    withdrawAnnouncement: vi.fn(),
    finalize: vi.fn(),
    unpublish: vi.fn(),
    destroy: vi.fn(),
  };
  render(<LiveView state={stateWithTournament()} actions={actions} onAnnounce={vi.fn()} />);

  const radios = screen.getAllByRole('radio');
  expect(radios).toHaveLength(3);
  const names = radios.map((radio) => (radio as HTMLInputElement).name);
  expect(new Set(names).size).toBe(1);
  // The default backend is checked and announced.
  expect(screen.getByRole('radio', { name: /Set up with Cloudflare/ })).toBeChecked();

  // Native inputs: focusing and activating a radio selects it with no custom key handling.
  (screen.getByRole('radio', { name: /Connect a custom server/ }) as HTMLElement).focus();
  fireEvent.click(screen.getByRole('radio', { name: /Connect a custom server/ }));
  expect(screen.getByRole('radio', { name: /Connect a custom server/ })).toBeChecked();
  expect(screen.getByRole('radio', { name: /Set up with Cloudflare/ })).not.toBeChecked();
});

test('backend radios disable while the connection submits', () => {
  const actions: LiveViewActions = {
    enable: vi.fn(() => new Promise<void>(() => {})),
    disable: vi.fn(),
    updateSettings: vi.fn(),
    publishAnnouncement: vi.fn(),
    withdrawAnnouncement: vi.fn(),
    finalize: vi.fn(),
    unpublish: vi.fn(),
    destroy: vi.fn(),
  };
  render(<LiveView state={stateWithTournament()} actions={actions} onAnnounce={vi.fn()} />);
  fireEvent.change(screen.getByPlaceholderText('https://…'), {
    target: { value: 'https://backend.example' },
  });
  const token = document.querySelector('input[type="password"]');
  fireEvent.change(token!, { target: { value: 'one-time-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect and test' }));
  for (const radio of screen.getAllByRole('radio')) {
    expect(radio).toBeDisabled();
  }
});
