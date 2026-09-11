/**
 * The application's state, as one hook.
 *
 * Small on purpose: a `useReducer`-shaped store with a schedule, a lifecycle and a projection
 * layer is the architecture this application is supposed not to have. What is here is the loaded
 * file, the persisted state, one poll timer, and the handful of actions the three views call.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chooseResultFolder, isNativeHost, openYellowFruitFile, writeResultFile } from './native';
import { generatePairingCode } from './pairing';
import { planRoomSetup, planRound, publishRound, type PublishOutcome, type PublishPlan } from './publish';
import {
  relayAcknowledgeResults,
  relayClaim,
  relayFetchResults,
  relayUnackedWindow,
  RelayError,
  type RelayConnection,
} from './relay';
import { resultFileContents, resultFileName, resultFilePath, resultSummary } from './results';
import { nextRoomId } from './identity';
import { newRoom, pairingWarnings, roomTombstone, type Room, type RoomStatus } from './rooms';
import { loadState, saveState, type BridgeState, type StoredResult } from './persistence';
import { loadYellowFruitTournament, type BridgeTournament } from './tournament';

/** How often the results poll runs while the window is open. */
export const resultPollIntervalMs = 5000;

/** Routine confirmations are useful briefly, while problems need to remain available. */
export const noticeAutoDismissMs = 4000;

/**
 * How many unsaved results may pile up before the operator is told.
 *
 * The relay serves the oldest `relayUnackedWindow` unacknowledged results and nothing behind
 * them, and a result leaves that window when it is saved. So the window can only fill if results
 * stop being saved, and this is the point at which that stops being a matter of taste.
 */
export const unsavedResultWarningThreshold = relayUnackedWindow - 28;

export interface BridgeNotice {
  kind: 'good' | 'warn' | 'bad';
  message: string;
}

export interface BridgeApi {
  state: BridgeState;
  tournament: BridgeTournament | null;
  /** What the last `.yft` read reported that QBSheet could not carry over. */
  loadWarnings: string[];
  notice: BridgeNotice | null;
  dismissNotice(): void;
  relayReachable: boolean | null;
  busy: boolean;
  native: boolean;

  loadFile(): Promise<void>;
  loadFileContents(path: string | null, contents: string): void;
  connectRelay(input: { baseUrl: string; tournamentId: string; setupToken: string }): Promise<boolean>;
  /** Show the relay setup form without touching the stored relay. */
  beginRelayChange(): void;
  /** Close the setup form and keep whatever relay was already stored. */
  cancelRelayChange(): void;
  changingRelay: boolean;
  /** Delete the stored management credential. Deliberate, confirmed, and not undoable. */
  forgetRelayCredential(): void;

  addRoom(): void;
  renameRoom(roomId: string, name: string): void;
  removeRoom(roomId: string): void;
  setRoomTeams(roomId: string, side: 'left' | 'right', teamId: string | null): void;
  regeneratePairingCode(roomId: string): void;
  selectRound(roundId: string): void;
  /** True when changing rounds would discard team selections the operator has entered. */
  roundChangeDiscardsSelections: boolean;
  publish(): Promise<void>;
  /** Publish room identities and pairing hashes without sending any match assignments. */
  publishRoomSetup(): Promise<void>;
  roomStatus(room: Room): RoomStatus;
  warnings: ReturnType<typeof pairingWarnings>;

  chooseFolder(): Promise<void>;
  saveNewResults(): Promise<void>;
  saveResult(resultId: string): Promise<void>;
  /** True when this row cannot start a save because a save or another bridge action is active. */
  resultBusy(resultId: string): boolean;
  /** True while an individual or batch result save is in progress. */
  savingResults: boolean;
  pollResults(): Promise<void>;
  /** Set when unsaved results are approaching the relay's unacknowledged window. */
  unsavedResultWarning: string | null;
}

function connectionOf(state: BridgeState): RelayConnection | null {
  if (!state.relay) return null;
  return {
    baseUrl: state.relay.baseUrl,
    tournamentId: state.relay.tournamentId,
    managementToken: state.relay.managementToken,
  };
}

/** Compare the relay identity a request was made against with the relay currently in state. */
function sameRelayConnection(left: RelayConnection | null, right: RelayConnection | null): boolean {
  return (
    left?.baseUrl === right?.baseUrl &&
    left?.tournamentId === right?.tournamentId &&
    left?.managementToken === right?.managementToken
  );
}

export function useBridge(): BridgeApi {
  const [state, setState] = useState<BridgeState>(() => loadState());
  const [tournament, setTournament] = useState<BridgeTournament | null>(null);
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState<BridgeNotice | null>(null);
  const [relayReachable, setRelayReachable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [changingRelay, setChangingRelay] = useState(false);
  const stateRef = useRef(state);
  const pollGenerationRef = useRef(0);
  const savingResultIdsRef = useRef(new Set<string>());
  const [savingResultIds, setSavingResultIds] = useState<Set<string>>(() => new Set());
  const savingBatchRef = useRef(false);
  const [savingBatch, setSavingBatch] = useState(false);

  const dismissNotice = useCallback(() => setNotice(null), []);

  useEffect(() => {
    if (notice?.kind !== 'good') return;
    const timer = setTimeout(() => setNotice(null), noticeAutoDismissMs);
    return () => clearTimeout(timer);
  }, [notice]);

  const commit = useCallback((next: BridgeState | ((current: BridgeState) => BridgeState)) => {
    setState((current) => {
      const resolved = typeof next === 'function' ? next(current) : next;
      stateRef.current = resolved;
      saveState(resolved);
      return resolved;
    });
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const setResultSaving = useCallback((resultId: string, saving: boolean) => {
    const next = new Set(savingResultIdsRef.current);
    if (saving) next.add(resultId);
    else next.delete(resultId);
    savingResultIdsRef.current = next;
    setSavingResultIds(next);
  }, []);

  const loadFileContents = useCallback(
    (path: string | null, contents: string) => {
      const report = loadYellowFruitTournament(contents);
      if (!report.ok) {
        setTournament(null);
        setNotice({ kind: 'bad', message: report.errors.join(' ') });
        return;
      }
      setTournament(report.tournament);
      setLoadWarnings(report.warnings);
      setNotice({
        kind: 'good',
        message: `Loaded ${report.tournament.name}: ${report.tournament.teams.length} teams, ${report.tournament.playerCount} players.`,
      });
      commit((current) => {
        const roundIds = new Set(report.tournament.rounds.map((round) => round.id));
        return {
          ...current,
          yftPath: path,
          tournamentName: report.tournament.name,
          selectedRoundId:
            current.selectedRoundId && roundIds.has(current.selectedRoundId)
              ? current.selectedRoundId
              : (report.tournament.rounds[0]?.id ?? null),
        };
      });
    },
    [commit],
  );

  const loadFile = useCallback(async () => {
    setBusy(true);
    try {
      const opened = await openYellowFruitFile();
      if (!opened) return;
      loadFileContents(opened.path, opened.contents);
    } catch (error) {
      setNotice({ kind: 'bad', message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [loadFileContents]);

  /**
   * Claim a relay and store the credential it returns.
   *
   * The stored relay is replaced **only after a successful claim**. A failed attempt leaves the
   * existing one exactly as it was, which matters because a relay's setup token is consumed by
   * its first claim: a credential deleted before a replacement exists cannot be recovered, and
   * the relay it authorized cannot be claimed again.
   */
  const connectRelay = useCallback(
    async (input: { baseUrl: string; tournamentId: string; setupToken: string }): Promise<boolean> => {
      setBusy(true);
      try {
        const claimed = await relayClaim(input);
        // Invalidate an in-flight poll before publishing the replacement into state. This also
        // fences a reconnect that happens to reuse the same URL, tournament id, and credential.
        pollGenerationRef.current += 1;
        commit((current) => ({
          ...current,
          relay: {
            baseUrl: input.baseUrl.replace(/\/+$/, ''),
            tournamentId: claimed.tournamentId,
            managementToken: claimed.managementToken,
            // A different relay is a different tournament object with its own revision counter.
            epoch: 1,
            revision: 0,
          },
        }));
        setChangingRelay(false);
        setRelayReachable(true);
        setNotice({ kind: 'good', message: 'Relay connected.' });
        return true;
      } catch (error) {
        setRelayReachable(false);
        setNotice({
          kind: 'bad',
          message: `${(error as Error).message} The relay already set up here is unchanged.`,
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [commit],
  );

  const beginRelayChange = useCallback(() => setChangingRelay(true), []);
  const cancelRelayChange = useCallback(() => setChangingRelay(false), []);

  /**
   * Delete the stored management credential.
   *
   * Separate from changing relays, named for what it does, and confirmed by the caller. There is
   * no way back: the relay's setup token was consumed by the claim that produced this
   * credential, so the same relay cannot be claimed again.
   */
  const forgetRelayCredential = useCallback(() => {
    pollGenerationRef.current += 1;
    commit((current) => ({ ...current, relay: null }));
    setChangingRelay(true);
    setRelayReachable(null);
    setNotice({
      kind: 'warn',
      message: 'The relay credential was deleted from this machine. Set up a relay to publish again.',
    });
  }, [commit]);

  const addRoom = useCallback(() => {
    commit((current) => {
      const id = nextRoomId([
        ...current.rooms,
        ...current.pendingRoomRemovals,
        ...current.retiredRoomIds.map((roomId) => ({ id: roomId })),
      ]);
      const name = `Room ${current.rooms.length + 1}`;
      return { ...current, rooms: [...current.rooms, newRoom(id, name, generatePairingCode())] };
    });
  }, [commit]);

  const updateRoom = useCallback(
    (roomId: string, change: (room: Room) => Room) => {
      commit((current) => ({
        ...current,
        rooms: current.rooms.map((room) => (room.id === roomId ? change(room) : room)),
      }));
    },
    [commit],
  );

  const renameRoom = useCallback(
    (roomId: string, name: string) => updateRoom(roomId, (room) => ({ ...room, name })),
    [updateRoom],
  );

  const removeRoom = useCallback(
    (roomId: string) => {
      const room = stateRef.current.rooms.find((entry) => entry.id === roomId);
      if (!room) return;
      const tombstone = room.relayPublished ? roomTombstone(room) : null;
      commit((current) => ({
        ...current,
        rooms: current.rooms.filter((entry) => entry.id !== roomId),
        pendingRoomRemovals:
          tombstone && !current.pendingRoomRemovals.some((entry) => entry.id === roomId)
            ? [...current.pendingRoomRemovals, tombstone]
            : current.pendingRoomRemovals,
        retiredRoomIds:
          tombstone && !current.retiredRoomIds.includes(roomId)
            ? [...current.retiredRoomIds, roomId]
            : current.retiredRoomIds,
      }));
      setNotice(
        tombstone
          ? {
              kind: 'warn',
              message: `${room.name} was removed locally and will be cleared from the relay on the next successful publish.`,
            }
          : { kind: 'good', message: `${room.name} was removed.` },
      );
    },
    [commit],
  );

  const setRoomTeams = useCallback(
    (roomId: string, side: 'left' | 'right', teamId: string | null) =>
      updateRoom(roomId, (room) => ({
        ...room,
        [side === 'left' ? 'leftTeamId' : 'rightTeamId']: teamId,
      })),
    [updateRoom],
  );

  const regeneratePairingCode = useCallback(
    (roomId: string) =>
      updateRoom(roomId, (room) => ({ ...room, pendingPairingCode: generatePairingCode() })),
    [updateRoom],
  );

  /**
   * Choose the round the pairing table is for.
   *
   * Selecting a different round clears every room's team selection. The alternative — leaving
   * last round's pairings in the dropdowns under a new round's heading — makes the single most
   * damaging operator mistake available in one click: publishing round 4's matchups as real,
   * correctly formatted round 5 assignments, which the rooms would score and YellowFruit would
   * import without complaint.
   *
   * Rooms, their ids, their names, their pairing codes and their publication history all
   * survive. Only the entry state for the current round is cleared.
   */
  const selectRound = useCallback(
    (roundId: string) =>
      commit((current) =>
        current.selectedRoundId === roundId
          ? current
          : {
              ...current,
              selectedRoundId: roundId,
              rooms: current.rooms.map((room) => ({
                ...room,
                leftTeamId: null,
                rightTeamId: null,
              })),
            },
      ),
    [commit],
  );

  /** Apply a successful mirror without activating a code changed while the request was in flight. */
  const applyPublication = useCallback(
    (
      outcome: PublishOutcome,
      pendingCodes: ReadonlyMap<string, string | null>,
      tombstoneIds: ReadonlySet<string>,
    ) => {
      const byRoom = new Map(outcome.assignments.map((entry) => [entry.roomId, entry]));
      const cleared = new Set(outcome.clearedRoomIds);
      commit((current) => ({
        ...current,
        relay: current.relay ? { ...current.relay, revision: outcome.revision } : null,
        rooms: current.rooms.map((room) => {
          const wasMirrored = pendingCodes.has(room.id);
          if (!wasMirrored) return room;
          const sentPendingCode = pendingCodes.get(room.id) ?? null;
          const pendingStillCurrent = room.pendingPairingCode === sentPendingCode;
          const published = {
            ...room,
            pairingCode: pendingStillCurrent && sentPendingCode !== null ? sentPendingCode : room.pairingCode,
            pendingPairingCode: pendingStillCurrent ? null : room.pendingPairingCode,
            relayPublished: true,
          };
          const assignment = byRoom.get(room.id);
          if (assignment) {
            return {
              ...published,
              publishedMatchId: assignment.matchId,
              publishedRoundId: assignment.roundId,
              assignmentRevision: assignment.assignmentRevision,
            };
          }
          if (!cleared.has(room.id)) return published;
          // The relay just cleared this room. Local state says so too, or the room table would
          // keep reporting a game that is no longer on the relay.
          return {
            ...published,
            publishedMatchId: null,
            publishedRoundId: null,
            assignmentRevision: room.assignmentRevision + 1,
          };
        }),
        pendingRoomRemovals: current.pendingRoomRemovals.filter((room) => !tombstoneIds.has(room.id)),
        retiredRoomIds: [...new Set([...current.retiredRoomIds, ...tombstoneIds])],
      }));
    },
    [commit],
  );

  const publishPlan = useCallback(
    async (input: {
      plan: PublishPlan;
      tournamentName: string;
      successKind: 'good' | 'warn';
      successMessage: (outcome: PublishOutcome) => string;
      failureMessage: string;
      missingRelayMessage: string;
    }): Promise<PublishOutcome | null> => {
      const current = stateRef.current;
      const connection = connectionOf(current);
      if (!connection) {
        setNotice({ kind: 'bad', message: input.missingRelayMessage });
        return null;
      }
      if (input.plan.publications.length === 0) {
        setNotice({ kind: 'bad', message: 'There are no rooms to publish. Add a room first.' });
        return null;
      }
      setBusy(true);
      const pendingCodes = new Map(current.rooms.map((room) => [room.id, room.pendingPairingCode]));
      const tombstoneIds = new Set(current.pendingRoomRemovals.map((room) => room.id));
      try {
        const outcome = await publishRound(connection, {
          epoch: current.relay?.epoch ?? 1,
          lastRevision: current.relay?.revision ?? 0,
          tournamentName: input.tournamentName,
          plan: input.plan,
          rooms: current.rooms,
          tombstones: current.pendingRoomRemovals,
        });
        applyPublication(outcome, pendingCodes, tombstoneIds);
        setRelayReachable(true);
        setNotice({ kind: input.successKind, message: input.successMessage(outcome) });
        return outcome;
      } catch (error) {
        if (error instanceof RelayError) setRelayReachable(false);
        setNotice({ kind: 'bad', message: `${input.failureMessage} ${(error as Error).message}` });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [applyPublication],
  );

  const publish = useCallback(async () => {
    const current = stateRef.current;
    const round = tournament?.rounds.find((entry) => entry.id === current.selectedRoundId);
    if (!tournament || !round) {
      setNotice({ kind: 'bad', message: 'Load a YellowFruit file and choose a round first.' });
      return;
    }
    const plan = planRound(tournament, round, current.rooms, current.pendingRoomRemovals);
    if (plan.assignments.length === 0) {
      setNotice({
        kind: 'bad',
        message:
          'No room in this round has two teams chosen. Use “Publish Room Setup” to publish room codes or clear assignments.',
      });
      return;
    }
    await publishPlan({
      plan,
      tournamentName: tournament.name,
      successKind: plan.cleared.length > 0 ? 'warn' : 'good',
      successMessage: (outcome) => {
        const clearedNote =
          plan.cleared.length > 0
            ? ` ${plan.cleared.length} room(s) were cleared and can no longer open a game.`
            : '';
        return `Published round ${round.qbjName} to ${outcome.assignments.length} room(s).${clearedNote}`;
      },
      failureMessage: 'Round not published — the rooms still have whatever they had before.',
      missingRelayMessage: 'Connect the relay before publishing a round.',
    });
  }, [publishPlan, tournament]);

  const publishRoomSetup = useCallback(async () => {
    const current = stateRef.current;
    if (!current.tournamentName) {
      setNotice({ kind: 'bad', message: 'Load a YellowFruit file before publishing room setup.' });
      return;
    }
    const plan = planRoomSetup(current.rooms, current.pendingRoomRemovals);
    await publishPlan({
      plan,
      tournamentName: current.tournamentName,
      successKind: 'good',
      successMessage: () => {
        const removed = plan.publications.length - current.rooms.length;
        const removedNote = removed > 0 ? ` Cleared ${removed} removed room(s) from the relay.` : '';
        return `Published room setup for ${current.rooms.length} room(s). Pairing codes are now active and room tokens remain valid.${removedNote}`;
      },
      failureMessage: 'Room setup not published — the relay and local active codes are unchanged.',
      missingRelayMessage: 'Connect the relay before publishing room setup.',
    });
  }, [publishPlan]);

  const pollResults = useCallback(async () => {
    const current = stateRef.current;
    const connection = connectionOf(current);
    if (!connection || !isNativeHost()) return;

    // Each request supersedes an older overlapping request. The connection check handles relay
    // replacement, while the generation check also handles a slow earlier poll from the same
    // relay returning after a newer poll has already completed.
    const generation = pollGenerationRef.current + 1;
    pollGenerationRef.current = generation;
    const isCurrentPoll = () =>
      generation === pollGenerationRef.current &&
      sameRelayConnection(connection, connectionOf(stateRef.current));

    try {
      const fetched = await relayFetchResults(connection);
      if (!isCurrentPoll()) return;

      const currentAtSuccess = stateRef.current;
      const pendingAckIds = [
        ...new Set(
          fetched
            .filter((entry) => {
              const local = currentAtSuccess.results.find((row) => row.resultId === entry.resultId);
              return local?.savedPath !== undefined && local.ackPending !== false;
            })
            .map((entry) => entry.resultId),
        ),
      ];
      setRelayReachable(true);
      commit((current) => {
        if (!sameRelayConnection(connection, connectionOf(current))) return current;
        const fresh: StoredResult[] = fetched
          .filter((entry) => !current.results.some((row) => row.resultId === entry.resultId))
          .map((entry) => ({ resultId: entry.resultId, qbj: entry.qbj, receivedAt: entry.receivedAt }));
        if (fresh.length === 0) return current;
        return { ...current, results: [...current.results, ...fresh] };
      });

      if (pendingAckIds.length === 0 || !isCurrentPoll()) return;
      try {
        // The connection is captured from the poll, never reread from state after the await. A
        // relay replacement can therefore not accidentally receive an ACK for the old relay.
        await relayAcknowledgeResults(connection, pendingAckIds);
      } catch {
        // The file is already safe locally. Leave ackPending set so this result is retried on a
        // later poll, including after a restart.
        return;
      }
      if (!isCurrentPoll()) return;
      const acknowledged = new Set(pendingAckIds);
      commit((current) => {
        if (!sameRelayConnection(connection, connectionOf(current))) return current;
        return {
          ...current,
          results: current.results.map((entry) =>
            acknowledged.has(entry.resultId) ? { ...entry, ackPending: false } : entry,
          ),
        };
      });
    } catch {
      if (isCurrentPoll()) setRelayReachable(false);
    }
  }, [commit]);

  useEffect(() => {
    // Changing the active relay invalidates every in-flight request, even if a replacement happens
    // to reuse the same visible URL. The identity check above is the second, explicit fence.
    pollGenerationRef.current += 1;
    if (!state.relay) return;
    // The first poll is scheduled rather than run inline: polling ends in a `setState`, and a
    // `setState` in an effect body is a cascading render. A tick's delay costs nothing here.
    const first = setTimeout(() => void pollResults(), 0);
    const timer = setInterval(() => void pollResults(), resultPollIntervalMs);
    return () => {
      pollGenerationRef.current += 1;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [pollResults, state.relay]);

  const chooseFolder = useCallback(async () => {
    try {
      const folder = await chooseResultFolder();
      if (folder) commit((current) => ({ ...current, resultFolder: folder }));
    } catch (error) {
      setNotice({ kind: 'bad', message: (error as Error).message });
    }
  }, [commit]);

  /**
   * Write one result and record where it went.
   *
   * The native writer refuses an existing file unless the target is exactly the result's previous
   * savedPath. That keeps a folder change exclusive while still allowing an intentional Save again
   * to rewrite this result's own file.
   */
  const writeOne = useCallback(
    async (entry: StoredResult, folder: string): Promise<void> => {
      const summary = resultSummary(entry.qbj);
      const fileName = resultFileName(summary, entry.resultId);
      const targetPath = resultFilePath(folder, fileName);
      const path = await writeResultFile(
        folder,
        fileName,
        // The bytes are the relay's document, serialized. Nothing is recalculated on the way out.
        resultFileContents(entry.qbj),
        entry.savedPath === targetPath,
      );
      commit((current) => ({
        ...current,
        results: current.results.map((row) =>
          row.resultId === entry.resultId ? { ...row, savedPath: path, ackPending: true } : row,
        ),
      }));
    },
    [commit],
  );

  /**
   * Tell the relay these results are on disk.
   *
   * The only place an acknowledgment is sent, and it runs after the write rather than alongside
   * it. A failure is swallowed on purpose: the file exists, the local record says so, and an
   * unacknowledged result costs nothing beyond being offered again on the next poll.
   */
  const acknowledgeSaved = useCallback(
    async (connection: RelayConnection | null, resultIds: readonly string[]): Promise<void> => {
      if (
        !connection ||
        resultIds.length === 0 ||
        !sameRelayConnection(connection, connectionOf(stateRef.current))
      )
        return;
      try {
        await relayAcknowledgeResults(connection, resultIds);
      } catch {
        // Deliberately quiet. See above; ackPending remains true for a later poll retry.
        return;
      }
      if (!sameRelayConnection(connection, connectionOf(stateRef.current))) return;
      const acknowledged = new Set(resultIds);
      commit((current) => {
        if (!sameRelayConnection(connection, connectionOf(current))) return current;
        return {
          ...current,
          results: current.results.map((entry) =>
            acknowledged.has(entry.resultId) ? { ...entry, ackPending: false } : entry,
          ),
        };
      });
    },
    [commit],
  );

  const saveResult = useCallback(
    async (resultId: string) => {
      if (savingBatchRef.current || savingResultIdsRef.current.has(resultId)) return;
      const current = stateRef.current;
      const folder = current.resultFolder;
      const entry = current.results.find((row) => row.resultId === resultId);
      if (!folder) {
        setNotice({ kind: 'bad', message: 'Choose a results folder first.' });
        return;
      }
      if (!entry) return;
      const connection = connectionOf(current);
      setResultSaving(resultId, true);
      try {
        await writeOne(entry, folder);
        await acknowledgeSaved(connection, [entry.resultId]);
        setNotice({ kind: 'good', message: 'Result saved.' });
      } catch (error) {
        setNotice({ kind: 'bad', message: `That result was not saved. ${(error as Error).message}` });
      } finally {
        setResultSaving(resultId, false);
      }
    },
    [acknowledgeSaved, setResultSaving, writeOne],
  );

  const saveNewResults = useCallback(async () => {
    if (savingBatchRef.current || savingResultIdsRef.current.size > 0) return;
    const current = stateRef.current;
    const folder = current.resultFolder;
    if (!folder) {
      setNotice({ kind: 'bad', message: 'Choose a results folder first.' });
      return;
    }
    const unsaved = current.results.filter((entry) => !entry.savedPath);
    if (unsaved.length === 0) {
      setNotice({ kind: 'good', message: 'Every result is already saved.' });
      return;
    }
    savingBatchRef.current = true;
    setSavingBatch(true);
    setBusy(true);
    const failures: string[] = [];
    const written: string[] = [];
    const connection = connectionOf(current);
    try {
      for (const entry of unsaved) {
        try {
          await writeOne(entry, folder);
          written.push(entry.resultId);
        } catch (error) {
          // One bad filename or one full disk must not stop the other eleven, and the one that
          // failed stays unsaved rather than being marked done.
          failures.push((error as Error).message);
        }
      }
      await acknowledgeSaved(connection, written);
      setNotice(
        failures.length === 0
          ? { kind: 'good', message: `Saved ${written.length} result file(s) to ${folder}.` }
          : {
              kind: 'bad',
              message: `Saved ${written.length} of ${unsaved.length}. ${failures[0]}`,
            },
      );
    } finally {
      savingBatchRef.current = false;
      setSavingBatch(false);
      setBusy(false);
    }
  }, [acknowledgeSaved, writeOne]);

  const resultMatchIds = useMemo(
    () => new Set(state.results.map((entry) => matchIdOf(entry.qbj)).filter(Boolean)),
    [state.results],
  );

  const roomStatus = useCallback(
    (room: Room): RoomStatus => {
      if (!room.publishedMatchId) return 'ready';
      if (resultMatchIds.has(room.publishedMatchId)) return 'result-received';
      return 'waiting';
    },
    [resultMatchIds],
  );

  const teamName = useCallback(
    (id: string) => tournament?.teams.find((team) => team.id === id)?.name ?? id,
    [tournament],
  );

  const warnings = useMemo(() => pairingWarnings(state.rooms, teamName), [state.rooms, teamName]);

  const roundChangeDiscardsSelections = state.rooms.some(
    (room) => room.leftTeamId !== null || room.rightTeamId !== null,
  );

  /**
   * The one place the relay's unacknowledged window is surfaced.
   *
   * Saved results leave that window, so it can only fill with results nobody has written to
   * disk. Past the threshold the operator is told plainly, because the failure beyond it is
   * silent: the relay would keep accepting finals and stop showing them.
   */
  const unsavedCount = state.results.filter((entry) => !entry.savedPath || entry.ackPending).length;
  const unsavedResultWarning =
    unsavedCount >= unsavedResultWarningThreshold
      ? `${unsavedCount} results are still unsaved or awaiting relay acknowledgment. The relay shows the oldest ${relayUnackedWindow} unconfirmed results at a time — save these before more games finish.`
      : null;

  const resultBusy = useCallback(
    (resultId: string) => busy || savingBatch || savingResultIds.has(resultId),
    [busy, savingBatch, savingResultIds],
  );

  return {
    state,
    tournament,
    loadWarnings,
    notice,
    dismissNotice,
    relayReachable,
    busy,
    native: isNativeHost(),
    loadFile,
    loadFileContents,
    connectRelay,
    beginRelayChange,
    cancelRelayChange,
    changingRelay,
    forgetRelayCredential,
    addRoom,
    renameRoom,
    removeRoom,
    setRoomTeams,
    regeneratePairingCode,
    selectRound,
    roundChangeDiscardsSelections,
    publish,
    publishRoomSetup,
    roomStatus,
    warnings,
    chooseFolder,
    saveNewResults,
    saveResult,
    resultBusy,
    savingResults: savingBatch || savingResultIds.size > 0,
    pollResults,
    unsavedResultWarning,
  };
}

/** The `Match.id` inside a result document, for matching a result back to the room that played it. */
function matchIdOf(qbj: unknown): string {
  if (!qbj || typeof qbj !== 'object' || Array.isArray(qbj)) return '';
  const record = qbj as Record<string, unknown>;
  if (record.type === 'Match' && typeof record.id === 'string') return record.id;
  const objects = Array.isArray(record.objects) ? record.objects : [];
  for (const entry of objects) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const object = entry as Record<string, unknown>;
      if (object.type === 'Match' && typeof object.id === 'string') return object.id;
    }
  }
  return '';
}
