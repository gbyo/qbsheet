/** @vitest-environment jsdom */

import { useLayoutEffect } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { connectionVersion, readConnection, writeConnection } from '../src/app/ConnectedSession';
import useConnectedRuntime, { assignmentPollIntervalMs } from '../src/app/useConnectedRuntime';
import FruityServerClient, { INormalizedAssignment } from '../src/integrations/fruity/FruityServerClient';
import { progressIntervalMs } from '../src/integrations/fruity/FruityResultDestination';
import type { IFinalDelivery } from '../src/integrations/fruity/FruityResultDestination';
import { HelpRequestCategory, IHelpRequestSummary } from '../src/app/HelpRequests';

class TestStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

/** A poll that answers, and answers with nothing to play, so it never changes what is on screen. */
const assignmentWithNothingToPlay: INormalizedAssignment = {
  state: 'none',
  roomId: 'room-1',
  roomName: 'Room 1',
  tournamentName: 'Tournament',
  definition: null,
  session: null,
};

describe('connected room durability', () => {
  test('keeps stored room and session credentials until explicitly cleared', () => {
    const storage = new TestStorage();
    const storedAt = new Date('2026-01-01T12:00:00.000Z');
    const muchLater = new Date('2036-01-01T12:00:00.000Z');

    expect(
      writeConnection(
        {
          baseUrl: 'http://192.168.1.20:8787',
          roomId: 'room-1',
          roomName: 'Room 1',
          roomToken: 'room-token',
          deviceId: 'device-1',
          sessionId: 'session-1',
          sessionToken: 'session-token',
          tournamentKey: 'tournament-1',
        },
        storedAt,
        storage,
      ),
    ).toBe(true);

    expect(readConnection(muchLater, storage)).toMatchObject({
      version: connectionVersion,
      roomId: 'room-1',
      roomToken: 'room-token',
      sessionId: 'session-1',
      sessionToken: 'session-token',
    });
  });

  test('re-offers the latest snapshot on periodic successful server polls', async () => {
    vi.useFakeTimers();
    const snapshots: object[] = [];
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async (_credentials: unknown, qbj: object) => {
        snapshots.push(qbj);
        return { ok: true as const, value: {} };
      }),
    } as unknown as FruityServerClient;

    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    const latest = { match: 'current-state' };
    act(() => hook.result.current.reportProgress(latest));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });
    expect(snapshots).toEqual([latest]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(assignmentPollIntervalMs);
    });
    expect(snapshots).toEqual([latest, latest]);

    hook.unmount();
  });

  /**
   * The sequence has to survive a reload, and it cannot lean on the clock to do it.
   *
   * QBTCP requires the number to increase within a session and has servers discard a lower one
   * *silently*, with a `200`. So a device that corrects its clock backward — an NTP sync, a manual
   * change, a machine that booted without a network — would resume numbering below where it left
   * off and spend the rest of the game filing snapshots that are accepted and thrown away. Nothing
   * in that sequence of events produces an error for anybody to notice, which is the whole reason
   * the high-water mark is stored rather than derived.
   */
  test('the progress sequence keeps rising across a reload that moved the clock backward', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T15:00:00.000Z'));

    const sequences: number[] = [];
    const persisted: number[] = [];
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async (_credentials: unknown, _qbj: object, sequence: number) => {
        sequences.push(sequence);
        return { ok: true as const, value: {} };
      }),
    } as unknown as FruityServerClient;

    const room = (progressSequence?: number) =>
      renderHook(() =>
        useConnectedRuntime({
          client,
          identity: { roomId: 'room-1', token: 'room-token' },
          credentials: { sessionId: 'session-1', token: 'session-token' },
          enabled: true,
          progressSequence,
          onProgressSequence: (sequence) => persisted.push(sequence),
        }),
      );

    const before = room();
    act(() => before.result.current.reportProgress({ tossups_read: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });
    expect(sequences).toHaveLength(1);
    before.unmount();

    // The tab reloads and the device's clock has been put back an hour in the meantime.
    vi.setSystemTime(new Date('2026-04-11T14:00:00.000Z'));
    const after = room(persisted[persisted.length - 1]);
    act(() => after.result.current.reportProgress({ tossups_read: 2 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });

    expect(sequences).toHaveLength(2);
    expect(sequences[1]).toBeGreaterThan(sequences[0]);
    // And what was stored is what was sent, so the next reload starts from the truth as well.
    expect(persisted).toEqual(sequences);
    after.unmount();
  });

  test('the sequence still rises within one session when the clock does not move at all', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T15:00:00.000Z'));
    const sequences: number[] = [];
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async (_credentials: unknown, _qbj: object, sequence: number) => {
        sequences.push(sequence);
        return { ok: true as const, value: {} };
      }),
    } as unknown as FruityServerClient;

    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    for (const tossups of [1, 2, 3]) {
      act(() => hook.result.current.reportProgress({ tossups_read: tossups }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(progressIntervalMs);
      });
    }

    expect(sequences).toHaveLength(3);
    expect(sequences).toEqual([...sequences].sort((first, second) => first - second));
    expect(new Set(sequences).size).toBe(3);
    hook.unmount();
  });

  /**
   * A refusal stops the room asking, on the write path as well as the read one.
   *
   * "Surface it. Do not retry in a loop." The poll obeying that and the trailing snapshot sender
   * not obeying it is the same defect twice: an origin outside the server's allowlist refuses
   * *everything*, so a room that stopped polling but went on offering a snapshot every few seconds
   * is still in the loop the protocol names — just a quieter one, and for the rest of the game.
   */
  test('a snapshot refused with 403 stops the room writing rather than retrying every few seconds', async () => {
    vi.useFakeTimers();
    const putSnapshot = vi.fn(async () => ({
      ok: false as const,
      status: 403,
      error: 'This browser origin is not approved.',
      detail: 'This browser origin is not approved.',
    }));
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot,
    } as unknown as FruityServerClient;

    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    act(() => hook.result.current.reportProgress({ tossups_read: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });
    expect(putSnapshot).toHaveBeenCalledTimes(1);
    expect(hook.result.current.automaticDelivery).toBe(false);

    // Scoring carries on, and every further offer is dropped rather than sent.
    for (const tossups of [2, 3, 4]) {
      act(() => hook.result.current.reportProgress({ tossups_read: tossups }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(progressIntervalMs + assignmentPollIntervalMs);
      });
    }
    expect(putSnapshot).toHaveBeenCalledTimes(1);

    // And the room is told, in the server's own words, without being asked for a pairing code.
    const refusal = hook.result.current.alerts.find((alert) => alert.id === 'forbidden');
    expect(refusal?.body).toContain('This browser origin is not approved.');
    expect(hook.result.current.alerts.some((alert) => alert.id === 'credentials')).toBe(false);

    hook.unmount();
  });

  /**
   * A blocked write is not a pending one.
   *
   * `pending` is a promise that something is still trying, and the completion screen makes it in
   * those words. A room another device took the writer lock from has nothing trying on its behalf,
   * so a scorekeeper told to wait would wait for the rest of the tournament. The distinction is
   * decided where the facts are — at the moment of the write — because a caller reading a rendered
   * copy of it is wrong in exactly the case that produces this state: a snapshot refused in the
   * instant somebody was pressing Submit.
   */
  test('a final blocked by a writer conflict is refused, not left pending', async () => {
    vi.useFakeTimers();
    const postFinal = vi.fn(async () => ({ ok: true as const, value: { accepted: true, duplicate: false } }));
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async () => ({
        ok: false as const,
        status: 409,
        error: 'Another device is scoring this game.',
        payload: { can_take_over: true },
      })),
      postFinal,
    } as unknown as FruityServerClient;

    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    act(() => hook.result.current.reportProgress({ tossups_read: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });
    expect(hook.result.current.automaticDelivery).toBe(false);

    const delivered = await hook.result.current.submitFinal({ tossups_read: 20 });

    expect(delivered.delivery).toBe('rejected');
    expect(delivered.detail).toBeTruthy();
    // And nothing was filed over the device that holds the lock.
    expect(postFinal).not.toHaveBeenCalled();

    hook.unmount();
  });

  test('a question scored in the first commit is sent on the interval, not held for the poll', async () => {
    // The same window, one severity down.
    //
    // `reportProgress` is called from scoring — an event handler — and reads `senderRef`, which the
    // sender's effect fills in. Built passively, the sender does not exist yet during the commit
    // that put the scoresheet on screen, so a tossup scored right then offers to nothing. Not lost:
    // `latestSnapshotRef` keeps it and the next successful poll re-offers it. But that is up to a
    // poll interval away, and the poll is ten times the send interval, so the room's first snapshot
    // sits on the device long after it was promised. Built during the commit, there is no gap.
    vi.useFakeTimers();
    const snapshots: object[] = [];
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      // A poll that never answers, so nothing here can be the poll's re-offer rescuing the send.
      assignment: vi.fn(() => new Promise<never>(() => {})),
      putSnapshot: vi.fn(async (_credentials: unknown, qbj: object) => {
        snapshots.push(qbj);
        return { ok: true as const, value: { accepted: true } };
      }),
    } as unknown as FruityServerClient;

    let scored = false;
    const hook = renderHook(() => {
      const runtime = useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      });
      useLayoutEffect(() => {
        if (scored) return;
        scored = true;
        runtime.reportProgress({ tossups_read: 1 });
      });
      return runtime;
    });

    expect(scored).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });
    expect(snapshots).toEqual([{ tossups_read: 1 }]);

    hook.unmount();
  });

  test('a repaired room can send its final from the commit that says it may', async () => {
    // The window a passive mirror opens, stated without depending on how loaded the machine is.
    //
    // `writesAllowedRef` is what `submitFinal` consults at the moment a scorekeeper presses Submit,
    // and the same value is rendered as `automaticDelivery` — the completion screen's promise that
    // the result will travel. A passive effect writes the ref in a scheduler task *after* the commit
    // that painted, and React yields between the two whenever the commit overruns its frame budget.
    // So a takeover that succeeds repaints "the result will be sent" a frame before the ref agrees,
    // and a Submit landing in that gap is refused with `attempted: false` — over a `forbidden` and
    // `writerConflict` pair already cleared, so `retryable` is false too and Recent Games will not
    // offer to send it again. The result stays on the device and the room is told it was saved.
    //
    // `onCommit` below is a layout effect declared after the hook's own, so it runs inside each
    // commit at the earliest instant anything can reach the DOM that commit produced — earlier than
    // any click on it. Submitting from there is the requirement; scheduler timing never enters in.
    vi.useFakeTimers();
    const postFinal = vi.fn(async () => ({ ok: true as const, value: { accepted: true, duplicate: false } }));
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async () => ({
        ok: false as const,
        status: 409,
        error: 'Another device is scoring this game.',
        payload: { can_take_over: true },
      })),
      takeWriter: vi.fn(async () => ({
        ok: true as const,
        value: { sessionId: 'session-1', token: 'session-token' },
      })),
      postFinal,
    } as unknown as FruityServerClient;

    let armed = false;
    let submitted: Promise<IFinalDelivery> | null = null;
    const hook = renderHook(() => {
      const runtime = useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      });
      useLayoutEffect(() => {
        // Armed only once the room is barred, so this stands for the press that follows the repair
        // rather than the one that could have happened before anything went wrong.
        if (!armed || submitted !== null || !runtime.automaticDelivery) return;
        submitted = runtime.submitFinal({ tossups_read: 20 });
      });
      return runtime;
    });

    // Lose the writer lock, so the room is genuinely barred before the repair.
    act(() => hook.result.current.reportProgress({ tossups_read: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });
    expect(hook.result.current.automaticDelivery).toBe(false);
    expect(submitted).toBeNull();

    // The room presses Take over, exactly as it appears on the alert.
    armed = true;
    const takeOver = hook.result.current.alerts
      .find((alert) => alert.id === 'writer-conflict')
      ?.actions?.find((action) => action.label === 'Take over scoring');
    if (!takeOver) throw new Error('the writer-conflict alert did not offer a takeover');
    await act(async () => {
      takeOver.onSelect();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hook.result.current.automaticDelivery).toBe(true);
    if (submitted === null) throw new Error('the commit that allowed writes did not submit');
    const delivered = await act(async () => submitted);
    expect(delivered).toMatchObject({ delivery: 'sent', attempted: true });
    expect(postFinal).toHaveBeenCalledTimes(1);

    hook.unmount();
  });

  test('a final nobody could deliver is pending, because retrying it is worth something', async () => {
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      postFinal: vi.fn(async () => ({ ok: false as const, error: 'Could not reach tournament control.' })),
    } as unknown as FruityServerClient;

    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    const delivered = await hook.result.current.submitFinal({ tossups_read: 20 });

    expect(delivered.delivery).toBe('pending');

    hook.unmount();
  });

  test('the help lifecycle accepts once, suppresses a second summons, and cancels once', async () => {
    let openHelp: IHelpRequestSummary | null = null;
    const requestHelp = vi.fn(async (_identity: unknown, category: HelpRequestCategory, message: string) => {
      openHelp = { id: 'help-1', category, message, createdAt: '2026-08-11T14:42:00.000Z' };
      return { kind: 'accepted' as const, request: openHelp };
    });
    const readHelp = vi.fn(async () =>
      openHelp ? { kind: 'outstanding' as const, request: openHelp } : { kind: 'idle' as const },
    );
    const cancelHelp = vi.fn(async () => {
      openHelp = null;
      return { kind: 'cleared' as const };
    });
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async () => ({ ok: true as const, value: {} })),
      requestHelp,
      readHelp,
      cancelHelp,
    } as unknown as FruityServerClient;
    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token', deviceId: 'device-1' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    let accepted: Awaited<ReturnType<typeof hook.result.current.requestControl>> | undefined;
    await act(async () => {
      accepted = await hook.result.current.requestControl('question-packet', 'The packet is wrong.');
    });
    expect(accepted?.kind).toBe('accepted');
    expect(hook.result.current.controlRequest.kind).toBe('outstanding');

    let duplicate: Awaited<ReturnType<typeof hook.result.current.requestControl>> | undefined;
    await act(async () => {
      duplicate = await hook.result.current.requestControl('protest', 'A second thing needs control.');
    });
    expect(duplicate?.kind).toBe('already-outstanding');
    expect(requestHelp).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.all([
        hook.result.current.cancelControlRequest(),
        hook.result.current.cancelControlRequest(),
      ]);
    });
    expect(cancelHelp).toHaveBeenCalledTimes(1);
    expect(hook.result.current.controlRequest.kind).toBe('idle');
    hook.unmount();
  });

  test('an unreachable help request is retryable with the original bounded message', async () => {
    const bodies: { category: HelpRequestCategory; message: string }[] = [];
    let openHelp: IHelpRequestSummary | null = null;
    const requestHelp = vi
      .fn()
      .mockImplementationOnce(async (_identity: unknown, category: HelpRequestCategory, message: string) => {
        bodies.push({ category, message });
        return { kind: 'unreachable' as const, error: 'Wi-Fi is down.' };
      })
      .mockImplementationOnce(async (_identity: unknown, category: HelpRequestCategory, message: string) => {
        bodies.push({ category, message });
        openHelp = { id: 'help-2', category, message, createdAt: '2026-08-11T14:43:00.000Z' };
        return {
          kind: 'accepted' as const,
          request: openHelp,
        };
      });
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async () => ({ ok: true as const, value: {} })),
      requestHelp,
      readHelp: vi.fn(async () =>
        openHelp ? { kind: 'outstanding' as const, request: openHelp } : { kind: 'idle' as const },
      ),
      cancelHelp: vi.fn(async () => ({ kind: 'cleared' as const })),
    } as unknown as FruityServerClient;
    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token', deviceId: 'device-1' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    let failed: Awaited<ReturnType<typeof hook.result.current.requestControl>> | undefined;
    await act(async () => {
      failed = await hook.result.current.requestControl('equipment-technical', 'The buzzer is silent.');
    });
    expect(failed?.kind).toBe('unreachable');
    expect(hook.result.current.controlRequest).toMatchObject({
      kind: 'failed',
      category: 'equipment-technical',
      message: 'The buzzer is silent.',
      retryable: true,
    });

    await act(async () => {
      await hook.result.current.retryControlRequest();
    });
    expect(requestHelp).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(hook.result.current.controlRequest.kind).toBe('outstanding');
    hook.unmount();
  });

  test('a legacy server without DELETE keeps the outstanding summons visible', async () => {
    const request = { id: 'legacy-help', category: 'question-packet' as const, message: 'Packet mismatch.' };
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async () => ({ ok: true as const, value: {} })),
      requestHelp: vi.fn(async () => ({ kind: 'accepted' as const, request })),
      readHelp: vi.fn(async () => ({ kind: 'outstanding' as const, request })),
      cancelHelp: vi.fn(async () => ({
        kind: 'unsupported' as const,
        error: 'This older server has no DELETE route.',
      })),
    } as unknown as FruityServerClient;
    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token', deviceId: 'device-1' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    await act(async () => {
      await hook.result.current.requestControl('question-packet', request.message);
    });
    await act(async () => {
      await hook.result.current.cancelControlRequest();
    });

    expect(hook.result.current.controlRequest).toMatchObject({ kind: 'outstanding', canCancel: false });
    hook.unmount();
  });

  test('an unsupported help capability is visible and never posts', async () => {
    const requestHelp = vi.fn();
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async () => ({ ok: true as const, value: {} })),
      requestHelp,
      readHelp: vi.fn(async () => ({
        kind: 'unsupported' as const,
        error: 'This tournament connection does not support remote control requests.',
      })),
      cancelHelp: vi.fn(async () => ({ kind: 'unsupported' as const, error: 'Unsupported.' })),
    } as unknown as FruityServerClient;
    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token', deviceId: 'device-1' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    await waitFor(() => expect(hook.result.current.controlRequest.kind).toBe('unsupported'));
    let result: Awaited<ReturnType<typeof hook.result.current.requestControl>> | undefined;
    await act(async () => {
      result = await hook.result.current.requestControl('protest', 'A ruling needs a person.');
    });
    if (!result) throw new Error('help request result was not returned');
    expect(result.kind).toBe('unsupported');
    expect(requestHelp).not.toHaveBeenCalled();
    expect(hook.result.current.controlRequest.kind).toBe('unsupported');
    hook.unmount();
  });

  test('a room-token 401 requests the existing room repair and does not enter a pairing loop', async () => {
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async () => ({ ok: true as const, value: {} })),
      requestHelp: vi.fn(async () => ({
        kind: 'refused' as const,
        status: 401,
        error: 'Room token expired.',
        retryable: true,
      })),
      readHelp: vi.fn(async () => ({ kind: 'idle' as const })),
      cancelHelp: vi.fn(async () => ({ kind: 'cleared' as const })),
    } as unknown as FruityServerClient;
    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token', deviceId: 'device-1' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    let result: Awaited<ReturnType<typeof hook.result.current.requestControl>> | undefined;
    await act(async () => {
      result = await hook.result.current.requestControl('protest', 'A ruling needs a person.');
    });
    if (!result) throw new Error('help request result was not returned');
    expect(result.kind).toBe('refused');
    expect(hook.result.current.alerts.some((alert) => alert.id === 'credentials')).toBe(true);
    expect(hook.result.current.alerts.some((alert) => alert.id === 'forbidden')).toBe(false);
    hook.unmount();
  });

  test('a 403 help refusal stays a refusal and does not start room repair', async () => {
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async () => ({ ok: true as const, value: {} })),
      requestHelp: vi.fn(async () => ({
        kind: 'refused' as const,
        status: 403,
        error: 'This page is not approved.',
        retryable: false,
      })),
      readHelp: vi.fn(async () => ({ kind: 'idle' as const })),
      cancelHelp: vi.fn(async () => ({ kind: 'cleared' as const })),
    } as unknown as FruityServerClient;
    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token', deviceId: 'device-1' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    let result: Awaited<ReturnType<typeof hook.result.current.requestControl>> | undefined;
    await act(async () => {
      result = await hook.result.current.requestControl('protest', 'A ruling needs a person.');
    });
    if (!result) throw new Error('help request result was not returned');
    expect(result).toMatchObject({ kind: 'refused', status: 403 });
    expect(hook.result.current.controlRequest).toMatchObject({
      kind: 'refused',
      status: 403,
      retryable: false,
    });
    expect(hook.result.current.alerts.some((alert) => alert.id === 'credentials')).toBe(false);
    hook.unmount();
  });
});
