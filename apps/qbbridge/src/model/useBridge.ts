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
import { planRound, publishRound } from './publish';
import { relayClaim, relayFetchResults, RelayError, type RelayConnection } from './relay';
import { resultFileContents, resultFileName, resultSummary } from './results';
import { nextRoomId } from './identity';
import { newRoom, pairingWarnings, type Room, type RoomStatus } from './rooms';
import { loadState, saveState, type BridgeState, type StoredResult } from './persistence';
import { loadYellowFruitTournament, type BridgeTournament } from './tournament';

/** How often the results poll runs while the window is open. */
export const resultPollIntervalMs = 5000;

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
  relayReachable: boolean | null;
  busy: boolean;
  native: boolean;

  loadFile(): Promise<void>;
  loadFileContents(path: string | null, contents: string): void;
  connectRelay(input: { baseUrl: string; tournamentId: string; setupToken: string }): Promise<void>;
  forgetRelay(): void;

  addRoom(): void;
  renameRoom(roomId: string, name: string): void;
  removeRoom(roomId: string): void;
  setRoomTeams(roomId: string, side: 'left' | 'right', teamId: string | null): void;
  regeneratePairingCode(roomId: string): void;
  selectRound(roundId: string): void;
  publish(): Promise<void>;
  roomStatus(room: Room): RoomStatus;
  warnings: ReturnType<typeof pairingWarnings>;

  chooseFolder(): Promise<void>;
  saveNewResults(): Promise<void>;
  saveResult(resultId: string): Promise<void>;
  pollResults(): Promise<void>;
}

function connectionOf(state: BridgeState): RelayConnection | null {
  if (!state.relay) return null;
  return {
    baseUrl: state.relay.baseUrl,
    tournamentId: state.relay.tournamentId,
    managementToken: state.relay.managementToken,
  };
}

export function useBridge(): BridgeApi {
  const [state, setState] = useState<BridgeState>(() => loadState());
  const [tournament, setTournament] = useState<BridgeTournament | null>(null);
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState<BridgeNotice | null>(null);
  const [relayReachable, setRelayReachable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const stateRef = useRef(state);

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

  const connectRelay = useCallback(
    async (input: { baseUrl: string; tournamentId: string; setupToken: string }) => {
      setBusy(true);
      try {
        const claimed = await relayClaim(input);
        commit((current) => ({
          ...current,
          relay: {
            baseUrl: input.baseUrl.replace(/\/+$/, ''),
            tournamentId: claimed.tournamentId,
            managementToken: claimed.managementToken,
            epoch: current.relay?.epoch ?? 1,
            revision: 0,
          },
        }));
        setRelayReachable(true);
        setNotice({ kind: 'good', message: 'Relay connected.' });
      } catch (error) {
        setRelayReachable(false);
        setNotice({ kind: 'bad', message: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [commit],
  );

  const forgetRelay = useCallback(() => {
    commit((current) => ({ ...current, relay: null }));
    setRelayReachable(null);
  }, [commit]);

  const addRoom = useCallback(() => {
    commit((current) => {
      const id = nextRoomId(current.rooms);
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
      commit((current) => ({ ...current, rooms: current.rooms.filter((room) => room.id !== roomId) }));
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
    (roomId: string) => updateRoom(roomId, (room) => ({ ...room, pairingCode: generatePairingCode() })),
    [updateRoom],
  );

  const selectRound = useCallback(
    (roundId: string) => commit((current) => ({ ...current, selectedRoundId: roundId })),
    [commit],
  );

  const publish = useCallback(async () => {
    const current = stateRef.current;
    const connection = connectionOf(current);
    const round = tournament?.rounds.find((entry) => entry.id === current.selectedRoundId);
    if (!tournament || !round) {
      setNotice({ kind: 'bad', message: 'Load a YellowFruit file and choose a round first.' });
      return;
    }
    if (!connection) {
      setNotice({ kind: 'bad', message: 'Connect the relay before publishing a round.' });
      return;
    }
    setBusy(true);
    try {
      const plan = planRound(tournament, round, current.rooms);
      const outcome = await publishRound(connection, {
        epoch: current.relay?.epoch ?? 1,
        lastRevision: current.relay?.revision ?? 0,
        tournamentName: tournament.name,
        plan,
        rooms: current.rooms,
      });
      const byRoom = new Map(outcome.assignments.map((entry) => [entry.roomId, entry]));
      commit((current) => ({
        ...current,
        relay: current.relay ? { ...current.relay, revision: outcome.revision } : null,
        rooms: current.rooms.map((room) => {
          const assignment = byRoom.get(room.id);
          if (!assignment) return room;
          return {
            ...room,
            publishedMatchId: assignment.matchId,
            publishedRoundId: assignment.roundId,
            assignmentRevision: assignment.assignmentRevision,
          };
        }),
      }));
      setRelayReachable(true);
      const skipped = plan.skipped.length > 0 ? ` ${plan.skipped.length} room(s) were skipped.` : '';
      setNotice({
        kind: plan.skipped.length > 0 ? 'warn' : 'good',
        message: `Published round ${round.qbjName} to ${outcome.assignments.length} room(s).${skipped}`,
      });
    } catch (error) {
      if (error instanceof RelayError) setRelayReachable(false);
      setNotice({
        kind: 'bad',
        message: `Round not published — the rooms still have whatever they had before. ${(error as Error).message}`,
      });
    } finally {
      setBusy(false);
    }
  }, [commit, tournament]);

  const pollResults = useCallback(async () => {
    const current = stateRef.current;
    const connection = connectionOf(current);
    if (!connection || !isNativeHost()) return;
    try {
      const fetched = await relayFetchResults(connection);
      setRelayReachable(true);
      commit((current) => {
        const known = new Set(current.results.map((entry) => entry.resultId));
        const fresh: StoredResult[] = fetched
          .filter((entry) => !known.has(entry.resultId))
          .map((entry) => ({ resultId: entry.resultId, qbj: entry.qbj, receivedAt: entry.receivedAt }));
        if (fresh.length === 0) return current;
        return { ...current, results: [...current.results, ...fresh] };
      });
    } catch {
      setRelayReachable(false);
    }
  }, [commit]);

  useEffect(() => {
    if (!state.relay) return;
    // The first poll is scheduled rather than run inline: polling ends in a `setState`, and a
    // `setState` in an effect body is a cascading render. A tick's delay costs nothing here.
    const first = setTimeout(() => void pollResults(), 0);
    const timer = setInterval(() => void pollResults(), resultPollIntervalMs);
    return () => {
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

  const writeOne = useCallback(
    async (entry: StoredResult, folder: string): Promise<void> => {
      const summary = resultSummary(entry.qbj);
      const path = await writeResultFile(
        folder,
        resultFileName(summary, entry.resultId),
        // The bytes are the relay's document, serialized. Nothing is recalculated on the way out.
        resultFileContents(entry.qbj),
      );
      commit((current) => ({
        ...current,
        results: current.results.map((row) =>
          row.resultId === entry.resultId ? { ...row, savedPath: path } : row,
        ),
      }));
    },
    [commit],
  );

  const saveResult = useCallback(
    async (resultId: string) => {
      const current = stateRef.current;
      const folder = current.resultFolder;
      const entry = current.results.find((row) => row.resultId === resultId);
      if (!folder) {
        setNotice({ kind: 'bad', message: 'Choose a results folder first.' });
        return;
      }
      if (!entry) return;
      try {
        await writeOne(entry, folder);
        setNotice({ kind: 'good', message: 'Result saved.' });
      } catch (error) {
        setNotice({ kind: 'bad', message: `That result was not saved. ${(error as Error).message}` });
      }
    },
    [writeOne],
  );

  const saveNewResults = useCallback(async () => {
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
    setBusy(true);
    const failures: string[] = [];
    for (const entry of unsaved) {
      try {
        await writeOne(entry, folder);
      } catch (error) {
        // One bad filename or one full disk must not stop the other eleven, and the one that
        // failed stays unsaved rather than being marked done.
        failures.push((error as Error).message);
      }
    }
    setBusy(false);
    setNotice(
      failures.length === 0
        ? { kind: 'good', message: `Saved ${unsaved.length} result file(s) to ${folder}.` }
        : {
            kind: 'bad',
            message: `Saved ${unsaved.length - failures.length} of ${unsaved.length}. ${failures[0]}`,
          },
    );
  }, [writeOne]);

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

  return {
    state,
    tournament,
    loadWarnings,
    notice,
    relayReachable,
    busy,
    native: isNativeHost(),
    loadFile,
    loadFileContents,
    connectRelay,
    forgetRelay,
    addRoom,
    renameRoom,
    removeRoom,
    setRoomTeams,
    regeneratePairingCode,
    selectRound,
    publish,
    roomStatus,
    warnings,
    chooseFolder,
    saveNewResults,
    saveResult,
    pollResults,
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
