import { useLayoutEffect } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  importDropOperation,
  importFilesOperation,
  prepareOperation,
  scanOperation,
  useActiveOperations,
} from '../src/director/transfers/useTransfers';
import RecentGames from '../src/app/RecentGames';
import ConnectedSetup from '../src/app/ConnectedSetup';
import { ScheduleView } from '../src/director/schedule/ScheduleView';
import { RoomsView } from '../src/director/rooms/RoomsView';
import { ResultsView } from '../src/director/results/ResultsView';
import { defaultRules, emptyDirectorState } from '../src/director/domain';
import type { DirectorController } from '../src/director/state/useDirectorController';
import { IStoredGameRecord } from '../src/game/GameStore';
import { validPackage } from './packages';
import { exchangePairingCode, openControl } from '../src/app/ControlPairing';

vi.mock('../src/app/ControlPairing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/ControlPairing')>();
  return { ...actual, openControl: vi.fn(), exchangePairingCode: vi.fn() };
});

const mockedOpenControl = vi.mocked(openControl);
const mockedExchangePairingCode = vi.mocked(exchangePairingCode);

function gameRecord(overrides: Partial<IStoredGameRecord> = {}): IStoredGameRecord {
  return {
    version: 1,
    id: 'match:sm-4471',
    identity: 'match:sm-4471',
    attempt: 1,
    gameKey: 'sess-1',
    package: validPackage(),
    setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
    events: [],
    connected: true,
    createdAt: '2026-08-11T14:00:00.000Z',
    updatedAt: '2026-08-11T15:00:00.000Z',
    completedAt: '2026-08-11T14:00:00.000Z',
    finalQbj: { tossups_read: 20 },
    finalScore: { left: 100, right: 90 },
    serverDelivery: 'pending',
    serverDeliveryLedger: {
      attemptCount: 1,
      lastAttemptedAt: '2026-08-11T14:42:00.000Z',
      retryable: true,
      outcome: 'pending',
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function scheduleState() {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-1',
    name: 'State Correctness Invitational',
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
  state.timeline = [
    {
      id: 'event-a',
      type: 'custom',
      title: 'Alpha briefing',
      scheduledStart: null,
      scheduledEnd: null,
      visibility: 'public',
      roomId: null,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
    {
      id: 'event-b',
      type: 'custom',
      title: 'Bravo briefing',
      scheduledStart: null,
      scheduledEnd: null,
      visibility: 'public',
      roomId: null,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
  ];
  return state;
}

const scheduleController = {
  removeTimelineEvent: vi.fn(() => true),
  updateTimelineEvent: vi.fn(() => true),
  addTimelineEvent: vi.fn(() => true),
  setRoundScheduledStart: vi.fn(() => true),
} as unknown as DirectorController;

function editButtons() {
  return screen.getAllByRole('button', { name: 'Edit' });
}

describe('schedule event editor entity identity', () => {
  test('switching from Event A to Event B shows B, not A\u2019s draft', () => {
    render(<ScheduleView state={scheduleState()} controller={scheduleController} onAnnounce={vi.fn()} />);
    fireEvent.click(editButtons()[0]);
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    expect(title.value).toBe('Alpha briefing');
    fireEvent.change(title, { target: { value: 'Alpha draft' } });

    fireEvent.click(editButtons()[1]);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Bravo briefing');
  });

  test('switching from edit to Add event shows a blank form', () => {
    render(<ScheduleView state={scheduleState()} controller={scheduleController} onAnnounce={vi.fn()} />);
    fireEvent.click(editButtons()[0]);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Alpha draft' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other event…' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
  });

  test('closing and reopening discards the draft and shows canonical values', () => {
    render(<ScheduleView state={scheduleState()} controller={scheduleController} onAnnounce={vi.fn()} />);
    fireEvent.click(editButtons()[0]);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Alpha draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(editButtons()[0]);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Alpha briefing');
  });

  test('a canonical change to the same event does not wipe an in-progress draft', () => {
    const state = scheduleState();
    const { rerender } = render(
      <ScheduleView state={state} controller={scheduleController} onAnnounce={vi.fn()} />,
    );
    fireEvent.click(editButtons()[0]);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Alpha draft' } });

    const updated = scheduleState();
    updated.timeline = updated.timeline.map((event) =>
      event.id === 'event-a' ? { ...event, title: 'Alpha briefing (moved)' } : event,
    );
    rerender(<ScheduleView state={updated} controller={scheduleController} onAnnounce={vi.fn()} />);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Alpha draft');
  });
});

describe('recent games retry concurrency', () => {
  test('overlapping retries resolve out of order without cross-clearing busy state', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const onRetry = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(
      <RecentGames
        records={[gameRecord(), gameRecord({ id: 'match:other' })]}
        onRetry={onRetry}
        canRetry={() => true}
      />,
    );
    const retries = screen.getAllByRole('button', { name: 'Retry sending result' });
    expect(retries).toHaveLength(2);

    await act(async () => {
      fireEvent.click(retries[0]);
      fireEvent.click(retries[1]);
    });
    expect(screen.getAllByRole('button', { name: 'Trying…' })).toHaveLength(2);

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    // The first completion must not re-enable the still-running second retry.
    expect(screen.getAllByRole('button', { name: 'Trying…' })).toHaveLength(1);

    await act(async () => {
      second.resolve();
      await second.promise;
    });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Retry sending result' })).toHaveLength(2),
    );
  });

  test('a failed QBJ download shows inline feedback and recovers quietly on success', () => {
    const onDownload = vi.fn(() => false);
    render(<RecentGames records={[gameRecord()]} onDownload={onDownload} canRetry={() => false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download QBJ' }));
    expect(screen.getByRole('alert')).toHaveTextContent('That QBJ file could not be produced.');

    onDownload.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Download QBJ' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('connected setup stale state', () => {
  test('editing the address clears the previous address error and unreachable UI', async () => {
    mockedOpenControl.mockReset();
    mockedOpenControl.mockResolvedValue({
      ok: false,
      unreachable: true,
      error: 'Tournament control could not be reached.',
    } as never);
    render(
      <ConnectedSetup
        initialBaseUrl=""
        onPaired={vi.fn()}
        onPairingLaunch={vi.fn()}
        onOtherScoring={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Tournament control address'), {
      target: { value: '192.168.1.50:8080' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Other scoring options' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Tournament control address'), {
      target: { value: '192.168.1.51:8080' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Other scoring options' })).toBeNull();
  });

  test('a stale connect response for an older address never advances the UI', async () => {
    mockedOpenControl.mockReset();
    const pending = deferred<never>();
    mockedOpenControl.mockReturnValue(pending.promise as never);
    const onPaired = vi.fn();
    render(
      <ConnectedSetup
        initialBaseUrl=""
        onPaired={onPaired}
        onPairingLaunch={vi.fn()}
        onOtherScoring={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const address = screen.getByLabelText('Tournament control address');
    fireEvent.change(address, { target: { value: 'http://address-a:8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    // While the request for A is in flight, the field becomes B.
    fireEvent.change(address, { target: { value: 'http://address-b:8080' } });

    await act(async () => {
      pending.resolve({
        ok: true,
        value: { client: {}, tournamentName: 'A tournament', rooms: [] },
      } as never);
      await pending.promise;
    });
    expect(onPaired).not.toHaveBeenCalled();
    // The UI still shows B's address form rather than A's pairing screen.
    expect(screen.getByLabelText('Tournament control address')).toHaveValue('http://address-b:8080');
    expect(screen.queryByLabelText('Pairing code')).toBeNull();
  });

  test('a launch link that falls back to the manual form still pairs the suggested room', async () => {
    mockedOpenControl.mockReset();
    mockedExchangePairingCode.mockReset();
    mockedOpenControl.mockResolvedValue({
      ok: true,
      value: {
        client: {},
        tournamentName: 'Fallback Invitational',
        rooms: [
          { id: 'room-3', name: 'Room 3' },
          { id: 'room-7', name: 'Room 7' },
        ],
      },
    } as never);
    // The launch link's own code is rejected, so the flow falls back to the manual form with the
    // link's room preselected. The second exchange, with a hand-typed code, succeeds.
    mockedExchangePairingCode
      .mockResolvedValueOnce({ ok: false, error: 'That pairing code has expired.' } as never)
      .mockResolvedValueOnce({
        ok: true,
        value: {
          baseUrl: 'http://control:8080',
          roomId: 'room-7',
          roomName: 'Room 7',
          roomToken: 'token-7',
          deviceId: 'device-1',
        },
      } as never);
    const onPaired = vi.fn();
    render(
      <ConnectedSetup
        initialBaseUrl=""
        launch={{ version: 1, server: 'http://control:8080', code: '999999', roomId: 'room-7' }}
        onPaired={onPaired}
        onPairingLaunch={vi.fn()}
        onOtherScoring={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect and pair' }));
    });
    await waitFor(() => expect(screen.getByLabelText('Pairing code')).toBeInTheDocument());
    // The fallback form shows the room the link asked for, without the user touching the select.
    expect(screen.getByLabelText('Room')).toHaveValue('room-7');
    expect(onPaired).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pair this room' }));
    });

    // The suggested room id was mirrored into the guard, so the successful response is adopted
    // rather than mistaken for a response to a room the user has since moved away from.
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(onPaired.mock.calls[0][0]).toMatchObject({ roomId: 'room-7', roomName: 'Room 7' });
    expect(mockedExchangePairingCode).toHaveBeenLastCalledWith({}, '123456', 'room-7', undefined);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('transfers operation-aware busy state', () => {
  test('overlapping scan and prepare complete in reverse order without cross-clearing', () => {
    const { result } = renderHook(() => useActiveOperations());
    const scanA = scanOperation('drive-a');
    const prepareB = prepareOperation('drive-b');

    act(() => {
      result.current.begin(scanA);
    });
    act(() => {
      result.current.begin(prepareB);
    });
    act(() => {
      result.current.begin(importFilesOperation);
    });
    expect(result.current.isActive(scanA)).toBe(true);
    expect(result.current.isActive(prepareB)).toBe(true);
    expect(result.current.busy).toBe(true);

    // The prepare finishes first: only its own key clears.
    act(() => {
      result.current.end(prepareB);
    });
    expect(result.current.isActive(prepareB)).toBe(false);
    expect(result.current.isActive(scanA)).toBe(true);
    expect(result.current.isActive(importFilesOperation)).toBe(true);
    expect(result.current.busy).toBe(true);

    act(() => {
      result.current.end(scanA);
    });
    expect(result.current.isActive(scanA)).toBe(false);
    expect(result.current.busy).toBe(true);

    act(() => {
      result.current.end(importDropOperation);
    });
    // Ending an operation that was never started changes nothing.
    expect(result.current.busy).toBe(true);
    act(() => {
      result.current.end(importFilesOperation);
    });
    expect(result.current.busy).toBe(false);
  });
});

describe('shared native QBTCP server status', () => {
  test('Stop stops the server it says it will, pressed in the commit that relabelled it', async () => {
    // The one mirror in this file that a stale read turns into the wrong action rather than a
    // dropped one.
    //
    // `toggle` is the Start/Stop button's own click handler, and `statusRef` is the only thing
    // telling it which of the two it is. Written by a passive effect, that ref lags the commit that
    // painted the new label by a scheduler task — React yields between the two whenever the commit
    // overruns its frame budget. So a poll landing `{ running: true }` repaints the button as "Stop
    // server" while the ref still reads `false`, and a director pressing it there starts the server
    // they just asked to stop. `commitStatus` then applies that start, the label flips back, and
    // the whole thing looks like a click that missed.
    //
    // `onCommit` is a layout effect declared after the hook's own, so it runs inside each commit —
    // earlier than any click on the DOM that commit produced. Toggling from there states the
    // requirement without depending on how loaded the machine is.
    const native = await import('../src/director/platform/native');
    const read = vi.spyOn(native, 'readNativeServerStatus').mockResolvedValue({ running: true });
    const start = vi.spyOn(native, 'startNativeServer').mockResolvedValue({ running: true });
    const stop = vi.spyOn(native, 'stopNativeServer').mockResolvedValue({ running: false });
    try {
      const { useNativeServerStatus } = await import('../src/director/server/useNativeServerStatus');
      let pressed = false;
      const { result, unmount } = renderHook(() => {
        const server = useNativeServerStatus({ active: true });
        useLayoutEffect(() => {
          // The press that follows the poll saying the server came up, and nothing before it.
          if (pressed || !server.status.running) return;
          pressed = true;
          void server.toggle();
        });
        return server;
      });

      await waitFor(() => expect(pressed).toBe(true));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(stop).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
      expect(result.current.status.running).toBe(false);
      unmount();
    } finally {
      read.mockRestore();
      start.mockRestore();
      stop.mockRestore();
    }
  });

  test('toggle and invitations write through to the one shared snapshot', async () => {
    const native = await import('../src/director/platform/native');
    const read = vi.spyOn(native, 'readNativeServerStatus').mockResolvedValue({ running: true });
    const start = vi.spyOn(native, 'startNativeServer').mockResolvedValue({ running: true });
    const stop = vi.spyOn(native, 'stopNativeServer').mockResolvedValue({ running: false });
    try {
      const { useNativeServerStatus } = await import('../src/director/server/useNativeServerStatus');
      const { result, unmount } = renderHook(() => useNativeServerStatus({ active: true }));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.status.running).toBe(true);
      expect(read).toHaveBeenCalled();

      await act(async () => {
        await result.current.toggle();
      });
      expect(stop).toHaveBeenCalled();
      expect(result.current.status.running).toBe(false);

      await act(async () => {
        await result.current.toggle();
      });
      expect(start).toHaveBeenCalled();
      expect(result.current.status.running).toBe(true);

      act(() => {
        result.current.addInvitation({
          roomId: 'room-1',
          roomName: 'Room 1',
          pairingCode: '111111',
          expiresInSeconds: 300,
        });
      });
      expect(result.current.status.pairingInvitations).toHaveLength(1);
      act(() => {
        result.current.addInvitation({
          roomId: 'room-1',
          roomName: 'Room 1',
          pairingCode: '222222',
          expiresInSeconds: 300,
        });
      });
      // Re-issuing for the same room replaces, never duplicates.
      expect(result.current.status.pairingInvitations).toHaveLength(1);
      expect(result.current.status.pairingInvitations?.[0].pairingCode).toBe('222222');
      unmount();
    } finally {
      read.mockRestore();
      start.mockRestore();
      stop.mockRestore();
    }
  });

  test('overlapping poll ticks never put a second native read in flight', async () => {
    vi.useFakeTimers();
    const native = await import('../src/director/platform/native');
    const pending = deferred<{ running: boolean }>();
    const read = vi.spyOn(native, 'readNativeServerStatus').mockReturnValue(pending.promise as never);
    try {
      const { useNativeServerStatus } = await import('../src/director/server/useNativeServerStatus');
      const { result, unmount } = renderHook(() => useNativeServerStatus({ active: true }));
      // The mount tick starts the first read and it never settles.
      expect(read).toHaveBeenCalledTimes(1);

      // Two further ticks fire while that read is still pending: both are skipped.
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(read).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve({ running: true });
        await pending.promise;
      });
      expect(result.current.status.running).toBe(true);
      // Once the read has settled the next tick is free to start another one.
      const second = deferred<{ running: boolean }>();
      read.mockReturnValue(second.promise as never);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => {
        second.resolve({ running: true });
        await second.promise;
      });
      unmount();
    } finally {
      read.mockRestore();
      vi.useRealTimers();
    }
  });

  test('a read started before a toggle cannot overwrite the toggle result', async () => {
    const native = await import('../src/director/platform/native');
    const pendingRead = deferred<{ running: boolean }>();
    const read = vi.spyOn(native, 'readNativeServerStatus').mockReturnValue(pendingRead.promise as never);
    const start = vi
      .spyOn(native, 'startNativeServer')
      .mockResolvedValue({ running: true, port: 8080 } as never);
    try {
      const { useNativeServerStatus } = await import('../src/director/server/useNativeServerStatus');
      const { result, unmount } = renderHook(() => useNativeServerStatus({ active: true }));
      expect(read).toHaveBeenCalledTimes(1);

      // Start succeeds while the older read is still outstanding.
      await act(async () => {
        await result.current.toggle();
      });
      expect(start).toHaveBeenCalled();
      expect(result.current.status).toMatchObject({ running: true, port: 8080 });

      // The stale read now resolves with the pre-start snapshot; it must be discarded.
      await act(async () => {
        pendingRead.resolve({ running: false });
        await pendingRead.promise;
      });
      expect(result.current.status).toMatchObject({ running: true, port: 8080 });
      expect(result.current.loading).toBe(false);
      unmount();
    } finally {
      read.mockRestore();
      start.mockRestore();
    }
  });

  test('a slow background refresh never reopens the never-loaded state', async () => {
    vi.useFakeTimers();
    const native = await import('../src/director/platform/native');
    const first = deferred<{ running: boolean }>();
    const slow = deferred<{ running: boolean }>();
    const read = vi
      .spyOn(native, 'readNativeServerStatus')
      .mockReturnValueOnce(first.promise as never)
      .mockReturnValue(slow.promise as never);
    try {
      const { useNativeServerStatus } = await import('../src/director/server/useNativeServerStatus');
      const { result, unmount } = renderHook(() => useNativeServerStatus({ active: true }));
      expect(result.current.loading).toBe(true);

      await act(async () => {
        first.resolve({ running: true });
        await first.promise;
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.status.running).toBe(true);

      // A background read that outlasts several poll intervals keeps the last known snapshot
      // rather than sending the UI back to "Checking server".
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.status.running).toBe(true);
      expect(read).toHaveBeenCalledTimes(2);

      await act(async () => {
        slow.resolve({ running: false });
        await slow.promise;
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.status.running).toBe(false);
      unmount();
    } finally {
      read.mockRestore();
      vi.useRealTimers();
    }
  });

  test('an inactive shell performs no native reads', async () => {
    const native = await import('../src/director/platform/native');
    const read = vi.spyOn(native, 'readNativeServerStatus').mockResolvedValue({ running: true });
    try {
      const { useNativeServerStatus } = await import('../src/director/server/useNativeServerStatus');
      const { result, unmount } = renderHook(() => useNativeServerStatus({ active: false }));
      expect(result.current.loading).toBe(false);
      expect(result.current.status).toEqual({ running: false });
      expect(read).not.toHaveBeenCalled();
      unmount();
    } finally {
      read.mockRestore();
    }
  });
});

describe('manual result validation', () => {
  function resultsState() {
    const state = scheduleState();
    state.teams = [
      { id: 'team-a', displayName: 'Alpha', organizationId: null } as never,
      { id: 'team-b', displayName: 'Bravo', organizationId: null } as never,
    ];
    state.scheduledGames = [
      {
        id: 'game-1',
        roundId: 'round-1',
        roomId: null,
        packetId: null,
        leftTeamId: 'team-a',
        rightTeamId: 'team-b',
        bye: false,
        status: 'scheduled',
      } as never,
    ];
    return state;
  }

  test('editing either score clears the validation error and aria-invalid', () => {
    render(
      <ResultsView
        state={resultsState()}
        controller={{ addManualResult: vi.fn(() => true) } as unknown as DirectorController}
        onAnnounce={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enter result' }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept manual result' }));

    expect(screen.getByText('Enter both final team scores.')).toBeInTheDocument();
    const left = screen.getByLabelText('Alpha') as HTMLInputElement;
    const right = screen.getByLabelText('Bravo') as HTMLInputElement;
    expect(left).toHaveAttribute('aria-invalid', 'true');
    expect(right).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(left, { target: { value: '250' } });
    expect(screen.queryByText('Enter both final team scores.')).toBeNull();
    expect(left).not.toHaveAttribute('aria-invalid');
    expect(right).not.toHaveAttribute('aria-invalid');
  });

  test('switching the selected game resets the draft', () => {
    const state = resultsState();
    state.scheduledGames = [
      ...state.scheduledGames,
      {
        id: 'game-2',
        roundId: 'round-1',
        roomId: null,
        packetId: null,
        leftTeamId: 'team-b',
        rightTeamId: 'team-a',
        bye: false,
        status: 'scheduled',
      } as never,
    ];
    render(
      <ResultsView
        state={state}
        controller={{ addManualResult: vi.fn(() => true) } as unknown as DirectorController}
        onAnnounce={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enter result' }));
    fireEvent.change(screen.getByLabelText('Alpha'), { target: { value: '250' } });
    expect((screen.getByLabelText('Alpha') as HTMLInputElement).value).toBe('250');

    fireEvent.change(screen.getByLabelText('Scheduled game'), { target: { value: 'game-2' } });
    expect((screen.getByLabelText('Alpha') as HTMLInputElement).value).toBe('');
  });
});

describe('director filter semantics', () => {
  test('room filters are toggle buttons, not tabs', () => {
    const state = emptyDirectorState();
    state.rooms = [
      {
        id: 'room-1',
        name: 'Room 101',
        status: 'live',
        moderatorId: null,
        scorekeeperId: null,
        equipmentId: null,
        available: true,
      },
    ];
    render(<RoomsView state={state} controller={{} as DirectorController} onAnnounce={vi.fn()} />);
    expect(screen.queryByRole('tab')).toBeNull();
    const all = screen.getByRole('button', { name: /All/ });
    expect(all.getAttribute('aria-pressed')).toBe('true');
  });
});
