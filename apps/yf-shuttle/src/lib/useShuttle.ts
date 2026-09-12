/**
 * YF Shuttle state: one hook, one persisted session, no server.
 *
 * What lives where:
 * - the `.yft` text: memory (and `localStorage` when small, so a restart keeps working);
 * - the project manifest: memory, `localStorage`, and `.yf-shuttle.json` on disk (the file
 *   is the durable copy; `localStorage` is the convenient one);
 * - scan results: memory only — OUT folders are rescanned on demand, never cached as truth.
 *
 * The source `.yft` is only ever read. Assignments are written exclusively (an existing IN
 * file is compared, never blindly replaced). Only the manifest and the derived YellowFruit
 * import batches are overwritten, and only on explicit operator action.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { assignmentFileContents, buildAssignment } from './assignment';
import { nextDerivedOwnership, planBatchUpdate } from './batch';
import {
  MANIFEST_FILE_NAME,
  createManifest,
  manifestFileContents,
  openProjectFromManifest,
  partitionWrittenGames,
  resolveManifestOnLoad,
  type ShuttleManifest,
  type WriteOutcome,
} from './manifest';
import {
  PLAYOFF_ROUNDS,
  PRELIM_ROUNDS,
  ROOM_SLOTS,
  planPlayoffs,
  planPrelims,
  validateWildcatCompatibility,
  type PlannedGame,
  type PlayoffLabel,
  type PlayoffSlots,
  type WildcatCompatibility,
} from './schedule';
import {
  assignmentFileName,
  importFolderName,
  joinPath,
  projectDirectories,
  safeFolderName,
  validateRoomNames,
  IMPORT_ROOT_NAME,
  IN_DIR_NAME,
  OUT_DIR_NAME,
} from './project';
import { reconcileScan, type ScanReport, type ScannedInputFile } from './scan';
import {
  assignSlotLabels,
  orderPrelimPool,
  verifyExpectedPrelimGames,
  verifyPlayoffPools,
  type ExpectedPrelimGame,
  type PoolOrder,
  type PrelimCompleteness,
} from './playoffs';
import {
  NativeUnavailableError,
  chooseProjectParent,
  copyFile,
  createDirectories,
  isNativeHost,
  listDirectory,
  openYellowFruitFile,
  readTextFile,
  removeImportFile,
  writeTextFile,
} from './native';
import {
  resolveScheduleSource,
  roomsForScheduledGames,
  type ScheduleSource,
  type YftScheduledGame,
} from './scheduleSource';
import { completedMatchOf, fillScheduledMatches } from './yftFill';
import { loadShuttleTournament, tournamentIdentityFingerprint, type ShuttleTournament } from './tournament';

export interface Notice {
  kind: 'good' | 'warn' | 'bad';
  message: string;
}

export interface PlayoffState {
  orders: { A: PoolOrder; B: PoolOrder };
  decidedGames: number;
  /** The hard 30-game gate: every expected prelim matchup present exactly once. */
  gate: PrelimCompleteness;
  /** True once every expected prelim result is present exactly once. */
  gateReady: boolean;
  /** Where the R6–R8 games come from: the file verbatim, or the printed preset. */
  playoffSource: ScheduleSource;
  /** The file's actual R6–R8 games, when the playoff source is the file. */
  verbatimGames: YftScheduledGame[];
  goldPoolName?: string;
  maroonPoolName?: string;
  verificationError?: string;
  /** Operator's explicit order inside each tied group, by pool letter. */
  manual: { A: string[]; B: string[] };
}

/** A project reopened from disk while its `.yft` is not loaded yet. */
export interface PendingRecovery {
  path: string;
  manifest: ShuttleManifest;
}

/**
 * The gate in operator words: exactly which round and room is missing, or which matchup
 * is doubled or unexpected. Team and room names are display only; the check itself ran on
 * team ids plus round identity.
 */
export function describePrelimGate(
  gate: PrelimCompleteness,
  teamName: (id: string) => string,
  roomName: (slotId: string) => string,
): string {
  const parts = [`${gate.present} of ${gate.expected} expected prelim games are present.`];
  for (const missing of gate.missing) {
    parts.push(`Round ${missing.roundNumber} / Room ${roomName(missing.slotId)} is missing.`);
  }
  for (const duplicated of gate.duplicated) {
    parts.push(
      `Round ${duplicated.roundNumber} contains two results for the same expected matchup (${teamName(duplicated.leftTeamId)} vs ${teamName(duplicated.rightTeamId)}).`,
    );
  }
  for (const unexpected of gate.unexpected) {
    parts.push(
      `Round ${unexpected.roundNumber} holds a decided game the schedule never planned (${teamName(unexpected.leftTeamId)} vs ${teamName(unexpected.rightTeamId)}).`,
    );
  }
  return parts.join(' ');
}

interface PersistedSession {
  yftPath?: string;
  yftText?: string;
  projectPath?: string;
  manifest?: ShuttleManifest;
}

const SESSION_KEY = 'yfshuttle.session.v1';
const MAX_PERSISTED_YFT_BYTES = 2 * 1024 * 1024;

function readSession(): PersistedSession {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function isSupportedResultName(name: string): boolean {
  return /\.(qbj|json)$/i.test(name.trim());
}

/**
 * A game to print: a preset pairing, or a real scheduled game from the file (which keeps
 * its own Match id so the completed result can fill that same blank later).
 */
interface BuildableGame extends PlannedGame {
  existingMatchId?: string;
  source?: 'yft';
}

function buildGames(
  games: BuildableGame[],
  rooms: { slotId: string; displayName: string }[],
  source: ShuttleTournament,
): { fileName: string; bytes: string; matchId: string; game: BuildableGame }[] {
  const names = new Map(rooms.map((room) => [room.slotId, room.displayName]));
  const teams = new Map(source.teams.map((team) => [team.id, team]));
  const rounds = new Map(source.rounds.map((round) => [round.id, round]));
  const built: { fileName: string; bytes: string; matchId: string; game: BuildableGame }[] = [];
  for (const game of games) {
    const round = rounds.get(game.roundId);
    const left = teams.get(game.leftTeamId);
    const right = teams.get(game.rightTeamId);
    if (!round || !left || !right) {
      throw new Error(`Round ${game.roundNumber} can no longer be built: the file changed under it.`);
    }
    const result = buildAssignment({
      tournament: source,
      ...(game.existingMatchId ? { existingMatchId: game.existingMatchId } : {}),
      roundId: round.id,
      roundQbjName: round.qbjName,
      ...(round.number !== undefined ? { roundNumber: round.number } : {}),
      phaseId: round.phaseId,
      phaseName: round.phaseName,
      slotId: game.slotId,
      roomName: names.get(game.slotId) ?? game.slotId,
      left,
      right,
    });
    if (!result.ok) throw new Error(result.error);
    const fileName = assignmentFileName({
      roundNumber: game.roundNumber,
      roomName: names.get(game.slotId) ?? game.slotId,
      leftTeamName: left.name,
      rightTeamName: right.name,
    });
    built.push({
      fileName,
      bytes: assignmentFileContents(result.assignment),
      matchId: result.assignment.matchId,
      game,
    });
  }
  return built;
}

export function useShuttle() {
  const [session, setSession] = useState<PersistedSession>(() => readSession());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [lastFiles, setLastFiles] = useState<ScannedInputFile[]>([]);
  const [playoffs, setPlayoffs] = useState<PlayoffState | null>(null);
  const [expandedRound, setExpandedRound] = useState<number | null>(1);
  const [pendingRecovery, setPendingRecovery] = useState<PendingRecovery | null>(null);

  const yftText = session.yftText;
  const manifest = session.manifest ?? null;
  const projectPath = session.projectPath ?? null;

  const tournament: ShuttleTournament | null = useMemo(() => {
    if (!yftText) return null;
    const loaded = loadShuttleTournament(yftText);
    return loaded.ok ? loaded.tournament : null;
  }, [yftText]);

  const loadError: string | null = useMemo(() => {
    if (!yftText) return null;
    const loaded = loadShuttleTournament(yftText);
    return loaded.ok ? null : loaded.errors.join(' ');
  }, [yftText]);

  const compat: WildcatCompatibility | null = useMemo(() => {
    if (!tournament) return null;
    const checked = validateWildcatCompatibility(tournament);
    return checked.ok ? checked.compat : null;
  }, [tournament]);

  const compatErrors: string[] = useMemo(() => {
    if (!tournament) return [];
    const checked = validateWildcatCompatibility(tournament);
    return checked.ok ? [] : checked.errors;
  }, [tournament]);

  /**
   * Where the prelim games come from: real scheduled Matches in the file, or the printed
   * Wildcat preset when the file holds none. A half-scheduled file is neither — setup
   * stops with an explanation instead of printing half a tournament.
   */
  const scheduleSource: ScheduleSource | null = useMemo(() => {
    if (!tournament || !compat) return null;
    return resolveScheduleSource(tournament, compat.prelimPhaseId, [...PRELIM_ROUNDS], 30);
  }, [tournament, compat]);

  // Persist the session. The manifest file on disk is the durable copy; this is convenience.
  useEffect(() => {
    try {
      const slim: PersistedSession = {
        ...(session.yftPath ? { yftPath: session.yftPath } : {}),
        ...(session.yftText && session.yftText.length < MAX_PERSISTED_YFT_BYTES
          ? { yftText: session.yftText }
          : {}),
        ...(session.projectPath ? { projectPath: session.projectPath } : {}),
        ...(session.manifest ? { manifest: session.manifest } : {}),
      };
      globalThis.localStorage?.setItem(SESSION_KEY, JSON.stringify(slim));
    } catch {
      // A full or unavailable store must not break the working session.
    }
  }, [session]);

  const writeManifestToDisk = useCallback(async (path: string, next: ShuttleManifest): Promise<boolean> => {
    try {
      await writeTextFile(joinPath(path, MANIFEST_FILE_NAME), manifestFileContents(next), {
        overwrite: true,
      });
      return true;
    } catch (error) {
      setNotice({
        kind: 'warn',
        message: `The project was updated in memory, but ${MANIFEST_FILE_NAME} could not be written: ${messageOf(error)}`,
      });
      return false;
    }
  }, []);

  const setManifest = useCallback(
    async (next: ShuttleManifest | null, path?: string | null) => {
      setSession((previous) => ({ ...previous, manifest: next ?? undefined }));
      const target = path ?? session.projectPath;
      if (next && target) await writeManifestToDisk(target, next);
    },
    [session.projectPath, writeManifestToDisk],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  function messageOf(error: unknown): string {
    if (error instanceof NativeUnavailableError) return error.message;
    if (error instanceof Error) return error.message;
    return String(error);
  }

  const guard = useCallback(async <T>(work: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setNotice(null);
    try {
      return await work();
    } catch (error) {
      setNotice({ kind: 'bad', message: messageOf(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Open a `.yft`, adopting the existing project only when it names the same tournament.
   *
   * When a project was reopened from disk first (`pendingRecovery`), this is the step that
   * verifies the tournament identity before the project activates: a matching file adopts
   * the recovered rooms, assignments, duplicate choices, and playoff slots, while a
   * different tournament leaves the pending project untouched and says so.
   */
  const openYellowFruit = useCallback(async () => {
    await guard(async () => {
      const opened = await openYellowFruitFile();
      if (!opened) return;
      const loaded = loadShuttleTournament(opened.contents);
      if (!loaded.ok) {
        setNotice({ kind: 'bad', message: loaded.errors.join(' ') });
        return;
      }
      if (pendingRecovery) {
        if (pendingRecovery.manifest.tournamentId !== loaded.tournament.id) {
          setNotice({
            kind: 'bad',
            message: `“${loaded.tournament.name}” is a different tournament — the reopened project belongs to “${pendingRecovery.manifest.tournamentName || pendingRecovery.manifest.tournamentId}”. Open that event's YellowFruit file instead.`,
          });
          return;
        }
        const fingerprint = tournamentIdentityFingerprint(loaded.tournament);
        setSession({
          yftPath: opened.path,
          yftText: opened.contents,
          projectPath: pendingRecovery.path,
          manifest: pendingRecovery.manifest,
        });
        setPendingRecovery(null);
        setReport(null);
        setPlayoffs(null);
        const drifted = fingerprint !== pendingRecovery.manifest.tournamentFingerprint;
        setNotice({
          kind: drifted ? 'warn' : 'good',
          message: drifted
            ? `Reopened the project at “${pendingRecovery.path}”. The roster or seeds changed since it was created, so verify the assignments before scoring — then rescan the OUT folders.`
            : `Reopened the project at “${pendingRecovery.path}” with ${pendingRecovery.manifest.assignments.length} games. Rescan the OUT folders to pick up where the rooms left off.`,
        });
        return;
      }
      const existing = readSession().manifest;
      const adoption = resolveManifestOnLoad(existing, loaded.tournament.id);
      if (!adoption.keep) {
        setSession({ yftPath: opened.path, yftText: opened.contents });
        setReport(null);
        setPlayoffs(null);
        setNotice({
          kind: 'warn',
          message: `“${loaded.tournament.name}” is a different tournament, so the previous project was set aside. Create its folders to begin.`,
        });
        return;
      }
      setSession((previous) => ({
        ...previous,
        yftPath: opened.path,
        yftText: opened.contents,
        manifest: adoption.keep ? adoption.manifest : previous.manifest,
      }));
      setReport(null);
      setPlayoffs(null);
      const checked = validateWildcatCompatibility(loaded.tournament);
      setNotice({
        kind: checked.ok ? 'good' : 'bad',
        message: checked.ok
          ? `Loaded “${loaded.tournament.name}”: 12 teams, rounds 1–8, Wildcat format confirmed.`
          : checked.errors.join(' '),
      });
    });
  }, [guard, pendingRecovery]);

  /**
   * Reopen a project from its `.yf-shuttle.json` with no session state at all.
   *
   * Picks a project folder, reads and validates the manifest, and either activates it
   * immediately (a matching `.yft` is already loaded) or parks it as pending and asks for
   * the matching file. Nothing here depends on an absolute YFT path or on localStorage, so
   * a moved folder and a wiped webview both recover the same way.
   */
  const openExistingProject = useCallback(async () => {
    await guard(async () => {
      const folder = await chooseProjectParent();
      if (!folder) return;
      let text: string;
      try {
        text = await readTextFile(joinPath(folder, MANIFEST_FILE_NAME));
      } catch {
        throw new Error(
          `“${folder}” holds no ${MANIFEST_FILE_NAME}. Choose the tournament's project folder — the one with the room folders in it.`,
        );
      }
      const reopened = openProjectFromManifest(text, tournament?.id);
      if (!reopened.ok) {
        setPendingRecovery(null);
        throw new Error(reopened.error);
      }
      if (reopened.needsYft) {
        setPendingRecovery({ path: folder, manifest: reopened.manifest });
        setNotice({
          kind: 'warn',
          message: `Found the project for “${reopened.manifest.tournamentName || reopened.manifest.tournamentId}” with ${reopened.manifest.assignments.length} games. Now open that event's current YellowFruit file to verify it before anything activates.`,
        });
        return;
      }
      setPendingRecovery(null);
      setSession((previous) => ({ ...previous, projectPath: folder, manifest: reopened.manifest }));
      setReport(null);
      setPlayoffs(null);
      setNotice({
        kind: 'good',
        message: `Reopened the project at “${folder}” with ${reopened.manifest.assignments.length} games. Rescan the OUT folders to pick up where the rooms left off.`,
      });
    });
  }, [guard, tournament]);

  /** Forget the loaded file and start over. The project folder on disk is left untouched. */
  const changeYellowFruitFile = useCallback(() => {
    setSession({});
    setReport(null);
    setPlayoffs(null);
    setPendingRecovery(null);
    setNotice(null);
  }, []);

  /** Drop a parked project recovery without activating it. */
  const cancelRecovery = useCallback(() => {
    setPendingRecovery(null);
    setNotice(null);
  }, []);

  /**
   * Create the project: folders, the 30 prelim assignments, and the manifest.
   *
   * Room names are validated before anything exists: trimmed, non-empty, sanitized to one
   * safe folder segment each, and unique case-insensitively. The stable slot id is the only
   * thing Match identity depends on — never the typed name.
   *
   * Assignment writes are exclusive and conflicts are tracked by Match id. A differing
   * existing file is a blocking setup error: a fresh project must never silently become a
   * partially valid one that later expects results for games that never reached the room.
   */
  const createProject = useCallback(
    async (roomNames: Record<string, string>, folderName: string) => {
      if (!tournament || !compat || !scheduleSource) return;
      await guard(async () => {
        if (scheduleSource.kind === 'mixed') throw new Error(scheduleSource.detail);
        // Resolve the games first, so a half-scheduled file stops before any folder exists.
        // Preset games derive their ids; file-sourced games keep the file's Match ids.
        const fileGames = scheduleSource.kind === 'yft' ? scheduleSource.games : null;
        let rooms: { slotId: string; displayName: string; folderName: string }[];
        let games: {
          roundNumber: number;
          roundId: string;
          slotId: string;
          leftTeamId: string;
          rightTeamId: string;
          existingMatchId?: string;
          source?: 'yft';
        }[];
        if (fileGames) {
          const roomed = roomsForScheduledGames(fileGames);
          if (!roomed.ok) throw new Error(roomed.error);
          const locations = [...new Set(fileGames.map((game) => game.location!))].sort();
          const validated = validateRoomNames(
            Object.fromEntries(locations.map((location) => [location, location])),
            locations,
          );
          if (!validated.ok) throw new Error(validated.errors.join(' '));
          rooms = validated.value.rooms;
          games = fileGames.map((game) => {
            const round = tournament.rounds.find(
              (candidate) =>
                candidate.number === game.roundNumber && candidate.phaseId === compat.prelimPhaseId,
            );
            if (!round) {
              throw new Error(`Round ${game.roundNumber} from the file is not a prelim round here.`);
            }
            return {
              roundNumber: game.roundNumber,
              roundId: round.id,
              slotId: game.location!,
              leftTeamId: game.leftTeamId,
              rightTeamId: game.rightTeamId,
              existingMatchId: game.matchId,
              source: 'yft' as const,
            };
          });
        } else {
          const validated = validateRoomNames(
            roomNames,
            ROOM_SLOTS.map((slot) => slot.id),
          );
          if (!validated.ok) throw new Error(validated.errors.join(' '));
          rooms = validated.value.rooms;
          games = planPrelims(compat);
        }

        const parent = await chooseProjectParent();
        if (!parent) return;
        const safeFolder = safeFolderName(folderName || tournament.name, 'Tournament');
        const path = joinPath(parent, safeFolder);
        const roomFolders = rooms.map((room) => room.folderName);
        const rounds = [...PRELIM_ROUNDS, ...PLAYOFF_ROUNDS];
        await createDirectories(parent, [
          safeFolder,
          ...projectDirectories(roomFolders, rounds).map((dir) => joinPath(safeFolder, dir)),
        ]);

        const built = buildGames(games, rooms, tournament);
        const outcomes: Record<string, WriteOutcome> = {};
        let identical = 0;
        for (const entry of built) {
          const room = rooms.find((candidate) => candidate.slotId === entry.game.slotId)!;
          const target = joinPath(path, room.folderName, IN_DIR_NAME, entry.fileName);
          try {
            await writeTextFile(target, entry.bytes);
            outcomes[entry.matchId] = 'written';
          } catch (error) {
            if (!String(messageOf(error)).includes('already exists')) throw error;
            const existing = await readTextFile(target);
            if (existing === entry.bytes) {
              outcomes[entry.matchId] = 'identical';
              identical += 1;
            } else {
              outcomes[entry.matchId] = 'conflicted';
            }
          }
        }

        const planned = built.map((entry) => ({
          matchId: entry.matchId,
          roundNumber: entry.game.roundNumber,
          roundId: entry.game.roundId,
          slotId: entry.game.slotId,
          leftTeamId: entry.game.leftTeamId,
          rightTeamId: entry.game.rightTeamId,
          fileName: entry.fileName,
          ...(entry.game.source === 'yft' ? { source: 'yft' as const } : {}),
        }));
        const { entries, conflicts } = partitionWrittenGames(planned, outcomes);
        if (conflicts.length > 0) {
          const names = new Map(rooms.map((room) => [room.slotId, room.displayName]));
          const listed = conflicts
            .map((conflict) => `Round ${conflict.roundNumber} / Room ${names.get(conflict.slotId) ?? conflict.slotId}`)
            .join('; ');
          throw new Error(
            `Setup stopped: ${conflicts.length} assignment${conflicts.length === 1 ? '' : 's'} already exist${conflicts.length === 1 ? 's' : ''} here with different content (${listed}). Pick an empty folder so every room gets the games this file planned — nothing was recorded.`,
          );
        }

        const next = createManifest({
          tournamentId: tournament.id,
          tournamentName: tournament.name,
          tournamentFingerprint: tournamentIdentityFingerprint(tournament),
          rooms: rooms.map((room) => ({
            slotId: room.slotId,
            displayName: room.displayName,
            folderName: room.folderName,
          })),
        });
        next.assignments.push(...entries);
        setSession((previous) => ({ ...previous, projectPath: path, manifest: next }));
        await writeManifestToDisk(path, next);
        const sourceLine =
          scheduleSource.kind === 'yft'
            ? 'The file already held all 30 prelim games, so their Match ids were kept.'
            : 'The file held no scheduled games, so the printed Wildcat schedule was used.';
        const parts = [`Created the project folder with ${next.assignments.length} prelim games. ${sourceLine}`];
        if (identical > 0) parts.push(`${identical} identical files were left alone.`);
        const renamed = rooms.filter((room) => room.displayName !== room.folderName);
        if (renamed.length > 0) {
          parts.push(
            `Folders sanitized: ${renamed.map((room) => `“${room.displayName}” → “${room.folderName}”`).join('; ')}.`,
          );
        }
        setNotice({ kind: 'good', message: parts.join(' ') });
      });
    },
    [compat, guard, scheduleSource, tournament, writeManifestToDisk],
  );

  /** Rescan every room's OUT folder and reconcile against the manifest. */
  const rescanOutFolders = useCallback(async () => {
    if (!manifest || !projectPath) return;
    await guard(async () => {
      const files: ScannedInputFile[] = [];
      for (const room of manifest.rooms) {
        const out = joinPath(projectPath, room.folderName, OUT_DIR_NAME);
        let entries: { name: string; isDirectory: boolean; modifiedMs?: number }[];
        try {
          entries = await listDirectory(out);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory || !isSupportedResultName(entry.name)) continue;
          const bytes = await readTextFile(joinPath(out, entry.name));
          files.push({
            folderName: room.folderName,
            fileName: entry.name,
            bytes,
            ...(entry.modifiedMs !== undefined ? { modifiedMs: entry.modifiedMs } : {}),
          });
        }
      }
      const next = reconcileScan(manifest, files);
      setLastFiles(files);
      setReport(next);
      const chosen = next.scans.filter((scan) => scan.chosen).length;
      const problems = next.problems.length;
      const needsChoice = next.scans.filter((scan) => scan.needsChoice).length;
      const parts = [
        `Scanned ${files.length} file${files.length === 1 ? '' : 's'}: ${chosen} result${chosen === 1 ? '' : 's'} returned.`,
      ];
      if (needsChoice > 0)
        parts.push(
          `${needsChoice} game${needsChoice === 1 ? ' needs' : 's need'} you to choose between duplicate results.`,
        );
      if (problems > 0) parts.push(`${problems} file${problems === 1 ? ' needs' : 's need'} attention.`);
      setNotice({ kind: problems > 0 || needsChoice > 0 ? 'warn' : 'good', message: parts.join(' ') });
    });
  }, [guard, manifest, projectPath]);

  /**
   * Remember the operator's choice between duplicate results for one game.
   *
   * The choice points at the physical file (`folder/file#content-hash`), never a bare
   * basename: the same filename can sit in two rooms' OUT folders, and a corrected file
   * re-saved under the same name is a different candidate.
   */
  const chooseResult = useCallback(
    async (matchId: string, candidateId: string) => {
      if (!manifest) return;
      const next: ShuttleManifest = {
        ...manifest,
        selectedResults: { ...manifest.selectedResults, [matchId]: candidateId },
      };
      await setManifest(next);
      if (report) {
        const refreshed = reconcileScan(next, lastFiles);
        setReport({ ...refreshed, scannedAt: report.scannedAt });
      }
    },
    [lastFiles, manifest, report, setManifest],
  );

  /**
   * Copy the chosen results for one round byte-for-byte into `YellowFruit Import/Round N`.
   *
   * The import tree is derived output: every assignment's destination name is deterministic
   * (the assignment's own filename), so re-preparing overwrites the previous derived copy
   * instead of accumulating suffixed duplicates. Files this tool owns but no longer expects
   * are removed; files the operator placed by hand are left alone and reported. IN and OUT
   * originals are never written — only read as copy sources.
   *
   * Preset games only. A file-sourced game already sits in the `.yft` as a blank, and
   * YellowFruit appends imports instead of filling blanks — so those games take the
   * updated-copy path (`createUpdatedCopy`), never this one.
   */
  const prepareRound = useCallback(
    async (roundNumber: number) => {
      if (!manifest || !projectPath || !report) return;
      await guard(async () => {
        const roundScans = report.scans.filter((scan) => scan.assignment.roundNumber === roundNumber);
        const filed = roundScans.filter((scan) => scan.assignment.source === 'yft');
        if (filed.length > 0) {
          throw new Error(
            `Round ${roundNumber} holds ${filed.length} game${filed.length === 1 ? '' : 's'} scheduled by the YellowFruit file itself. Importing them would duplicate the games already in the file — use “Create updated YellowFruit copy” for this round instead.`,
          );
        }
        const scans = roundScans.filter((scan) => scan.chosen);
        if (scans.length === 0) throw new Error(`Round ${roundNumber} has no returned results to prepare.`);
        const pending = roundScans.filter((scan) => !scan.chosen);
        const expected = scans.map((scan) => ({
          matchId: scan.assignment.matchId,
          destName: scan.assignment.fileName,
        }));
        const roundIds = new Set(scans.map((scan) => scan.assignment.matchId));
        const owned: Record<string, string> = {};
        for (const [matchId, destName] of Object.entries(manifest.derivedFiles)) {
          if (roundIds.has(matchId)) owned[matchId] = destName;
        }
        const folder = joinPath(projectPath, IMPORT_ROOT_NAME, importFolderName(roundNumber));
        await createDirectories(projectPath, [joinPath(IMPORT_ROOT_NAME, importFolderName(roundNumber))]);
        const existing = await listDirectory(folder).catch(() => []);
        const plan = planBatchUpdate({
          expected,
          existingNames: existing.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
          ownedNames: owned,
        });
        const byMatchId = new Map(scans.map((scan) => [scan.assignment.matchId, scan.chosen!]));
        for (const write of plan.writes) {
          const chosen = byMatchId.get(write.matchId)!;
          await copyFile(
            joinPath(projectPath, chosen.folderName, OUT_DIR_NAME, chosen.fileName),
            joinPath(folder, write.destName),
            true,
          );
        }
        const importRoot = joinPath(projectPath, IMPORT_ROOT_NAME);
        for (const removal of plan.removals) {
          try {
            await removeImportFile(importRoot, `${importFolderName(roundNumber)}/${removal}`);
          } catch (error) {
            // A file removed by hand between the listing and now is already gone: the goal
            // state, not a failure.
            if (!String(messageOf(error)).includes('already gone')) throw error;
          }
        }
        const next: ShuttleManifest = {
          ...manifest,
          derivedFiles: nextDerivedOwnership(manifest.derivedFiles, roundIds, plan.writes),
          preparedRounds: [...new Set([...manifest.preparedRounds, roundNumber])].sort((a, b) => a - b),
        };
        await setManifest(next);
        const parts = [
          `Round ${roundNumber} is ready for YellowFruit: ${plan.writes.length} file${plan.writes.length === 1 ? '' : 's'} in “YellowFruit Import / Round ${roundNumber}”. In YellowFruit, open Games → Import and select ${plan.writes.length === 1 ? 'it' : 'them'}. Re-preparing overwrites these copies — it never duplicates them.`,
        ];
        if (plan.removals.length > 0) {
          parts.push(`Removed ${plan.removals.length} stale derived file${plan.removals.length === 1 ? '' : 's'}.`);
        }
        if (plan.unknownKept.length > 0) {
          parts.push(
            `Left alone (not ours): ${plan.unknownKept.join(', ')}. Import only the prepared files.`,
          );
        }
        if (pending.length > 0) {
          parts.push(
            `${pending.length} game${pending.length === 1 ? ' is' : 's are'} still waiting — prepare again when more results come back.`,
          );
        }
        setNotice({ kind: pending.length > 0 ? 'warn' : 'good', message: parts.join(' ') });
      });
    },
    [guard, manifest, projectPath, report, setManifest],
  );

  /**
   * Fill completed results into a NEW `.yft` copy for file-sourced games.
   *
   * Stock YellowFruit appends an import as a second game instead of filling the scheduled
   * blank, so these games never take the import-batch path. Each chosen result's Match
   * object replaces the exact scheduled blank by id; the source text is never modified,
   * unrelated objects pass through untouched, and the copy is validated through QBSheet's
   * own YFT importer before it is written. The operator opens the copy in YellowFruit and
   * verifies it there.
   */
  const createUpdatedCopy = useCallback(
    async (roundNumber: number) => {
      if (!manifest || !projectPath || !report || !yftText || !tournament) return;
      await guard(async () => {
        const roundScans = report.scans.filter(
          (scan) => scan.assignment.roundNumber === roundNumber && scan.assignment.source === 'yft',
        );
        if (roundScans.length === 0) {
          throw new Error(`Round ${roundNumber} has no file-scheduled games to fill.`);
        }
        const scans = roundScans.filter((scan) => scan.chosen);
        if (scans.length === 0) {
          throw new Error(`Round ${roundNumber} has no returned results to fill in yet.`);
        }
        const pending = roundScans.filter((scan) => !scan.chosen);
        const fills = [];
        for (const scan of scans) {
          const chosen = scan.chosen!;
          const bytes = lastFiles.find(
            (file) => file.folderName === chosen.folderName && file.fileName === chosen.fileName,
          )?.bytes;
          if (bytes === undefined) {
            throw new Error(`“${chosen.fileName}” is no longer on disk. Rescan the OUT folders first.`);
          }
          const completed = completedMatchOf(bytes);
          if (!completed.ok) throw new Error(`“${chosen.fileName}”: ${completed.error}`);
          fills.push({ matchId: scan.assignment.matchId, match: completed.match });
        }
        const filled = fillScheduledMatches(yftText, fills);
        if (!filled.ok) throw new Error(filled.error);
        const copyName = `${safeFolderName(tournament.name, 'Tournament')} - Round ${roundNumber} updated.yft`;
        await writeTextFile(joinPath(projectPath, copyName), filled.text, { overwrite: true });
        const parts = [
          `Wrote “${copyName}” with ${filled.filled.length} filled game${filled.filled.length === 1 ? '' : 's'}. Open the copy in YellowFruit and verify it — the original file is untouched.`,
        ];
        if (pending.length > 0) {
          parts.push(
            `${pending.length} game${pending.length === 1 ? ' is' : 's are'} still waiting; run this again when more results come back.`,
          );
        }
        setNotice({ kind: pending.length > 0 ? 'warn' : 'good', message: parts.join(' ') });
      });
    },
    [guard, lastFiles, manifest, projectPath, report, tournament, yftText],
  );

  /**
   * Load the rebracketed `.yft`: same tournament, the hard 30-game gate, and pool order.
   *
   * The gate verifies the exact expected prelim matchups — team ids plus round identity,
   * never a bare count — so a doubled game cannot stand in for a missing one. Slots stay
   * locked until all 30 expected results are present exactly once.
   *
   * The manual order from any previous look at this file is kept, so reloading after fixing
   * YellowFruit does not lose the operator's tie decisions — they are re-checked, not reset.
   */
  const loadUpdatedYellowFruit = useCallback(async () => {
    if (!manifest) return;
    await guard(async () => {
      const opened = await openYellowFruitFile();
      if (!opened) return;
      const loaded = loadShuttleTournament(opened.contents);
      if (!loaded.ok) {
        setNotice({ kind: 'bad', message: loaded.errors.join(' ') });
        return;
      }
      const updated = loaded.tournament;
      if (updated.id !== manifest.tournamentId) {
        setNotice({
          kind: 'bad',
          message: `“${updated.name}” is a different tournament. Playoff slots can only come from the same event.`,
        });
        return;
      }
      const compatCheck = validateWildcatCompatibility(updated);
      if (!compatCheck.ok) {
        setNotice({ kind: 'bad', message: compatCheck.errors.join(' ') });
        return;
      }
      const expected: ExpectedPrelimGame[] = planPrelims(compatCheck.compat).map((game) => ({
        roundNumber: game.roundNumber,
        slotId: game.slotId,
        leftTeamId: game.leftTeamId,
        rightTeamId: game.rightTeamId,
      }));
      const gate = verifyExpectedPrelimGames({
        tournament: updated,
        prelimPhaseId: compatCheck.compat.prelimPhaseId,
        expected,
      });
      const gateReady =
        gate.missing.length === 0 && gate.duplicated.length === 0 && gate.unexpected.length === 0;
      const orderA = orderPrelimPool({
        tournament: updated,
        prelimPhaseId: compatCheck.compat.prelimPhaseId,
        poolId: compatCheck.compat.poolAId,
      });
      const orderB = orderPrelimPool({
        tournament: updated,
        prelimPhaseId: compatCheck.compat.prelimPhaseId,
        poolId: compatCheck.compat.poolBId,
      });
      // Where the playoffs come from: the file's own R6–R8 games when they exist (packaged
      // verbatim, never re-ranked), else the printed preset driven by the confirmed slots.
      const playoffSource = resolveScheduleSource(
        updated,
        compatCheck.compat.playoffPhaseId,
        [...PLAYOFF_ROUNDS],
        18,
      );
      if (playoffSource.kind === 'mixed') throw new Error(playoffSource.detail);
      const verbatimGames = playoffSource.kind === 'yft' ? playoffSource.games : [];
      // Adopt the reloaded file as the working tournament (rosters may have been corrected),
      // keeping the project: same event, same rooms, same prelim assignments.
      setSession((previous) => ({ ...previous, yftPath: opened.path, yftText: opened.contents }));
      setPlayoffs((previous) => ({
        orders: { A: orderA, B: orderB },
        decidedGames: gate.present,
        gate,
        gateReady,
        playoffSource,
        verbatimGames,
        manual: previous?.manual ?? { A: [], B: [] },
      }));
      const teamName = (id: string) => updated.teams.find((team) => team.id === id)?.name ?? id;
      const roomName = (slotId: string) =>
        manifest.rooms.find((room) => room.slotId === slotId)?.displayName ?? slotId;
      if (!gateReady) {
        setNotice({
          kind: 'bad',
          message: `Reloaded the updated file, but the playoffs stay locked. ${describePrelimGate(gate, teamName, roomName)} Import every prelim result into YellowFruit, save it, and reload here.`,
        });
        return;
      }
      setNotice({
        kind: 'good',
        message:
          verbatimGames.length > 0
            ? `Reloaded the updated file: all 30 prelim games present, and all 18 playoff games found in YellowFruit. Generate them below — no slot ranking needed.`
            : `Reloaded the updated file: all 30 prelim games present. Confirm the F/B slots below.`,
      });
    });
  }, [guard, manifest]);

  /** Reorder teams inside one tied group. Only tied teams may move; the rest follow the table. */
  const reorderTiedGroup = useCallback((pool: 'A' | 'B', group: string[], order: string[]) => {
    setPlayoffs((previous) => {
      if (!previous) return previous;
      const others = previous.manual[pool].filter((id) => !group.includes(id));
      return { ...previous, manual: { ...previous.manual, [pool]: [...others, ...order] } };
    });
  }, []);

  /**
   * Confirm F1–F6 / B1–B6 against YellowFruit's own playoff pools.
   *
   * Locked until the 30-game gate passes: with a missing or doubled prelim result, any
   * ranking — human-resolved or not — would label the wrong schedule.
   */
  const confirmPlayoffSlots = useCallback(async () => {
    if (!manifest || !tournament || !compat || !playoffs) return;
    await guard(async () => {
      if (playoffs.verbatimGames.length > 0) {
        throw new Error(
          'The file already holds all 18 playoff games — there are no slots to confirm. Generate them directly.',
        );
      }
      if (!playoffs.gateReady) {
        const teamName = (id: string) => tournament.teams.find((team) => team.id === id)?.name ?? id;
        const roomName = (slotId: string) =>
          manifest.rooms.find((room) => room.slotId === slotId)?.displayName ?? slotId;
        throw new Error(
          `Slots stay locked until every prelim result is in. ${describePrelimGate(playoffs.gate, teamName, roomName)}`,
        );
      }
      const slotsA = assignSlotLabels(playoffs.orders.A, 'F', playoffs.manual.A);
      if (!slotsA.ok) throw new Error(slotsA.error);
      const slotsB = assignSlotLabels(playoffs.orders.B, 'B', playoffs.manual.B);
      if (!slotsB.ok) throw new Error(slotsB.error);
      const slots = { ...slotsA.slots, ...slotsB.slots } as PlayoffSlots;
      const verified = verifyPlayoffPools({
        tournament,
        playoffPhaseId: compat.playoffPhaseId,
        slots,
      });
      if (!verified.ok) {
        setPlayoffs((previous) => (previous ? { ...previous, verificationError: verified.error } : previous));
        setNotice({ kind: 'bad', message: verified.error });
        return;
      }
      const next: ShuttleManifest = { ...manifest, playoffSlots: slots };
      await setManifest(next);
      setPlayoffs((previous) =>
        previous
          ? {
              ...previous,
              verificationError: undefined,
              goldPoolName: verified.goldPoolName,
              maroonPoolName: verified.maroonPoolName,
            }
          : previous,
      );
      setNotice({
        kind: 'good',
        message: `Gold (${verified.goldPoolName}) and Maroon (${verified.maroonPoolName}) verified against YellowFruit. Generate the playoff games when ready.`,
      });
    });
  }, [compat, guard, manifest, playoffs, tournament, setManifest]);

  /**
   * Write the 18 playoff assignments into the room IN folders.
   *
   * Two paths, never mixed. When the reloaded file already holds the R6–R8 games, they are
   * packaged verbatim — no prelim ranking, no slot mapping, YellowFruit authoritative. Else
   * the printed preset is built from the confirmed F/B slots, which requires the 30-game
   * gate to have passed. Either way, a game enters the manifest only when its IN file was
   * written or an identical file was already there — never for a file that never reached
   * the room.
   */
  const generatePlayoffs = useCallback(async () => {
    if (!manifest || !tournament || !compat) return;
    await guard(async () => {
      if (!projectPath) throw new Error('The project folder is gone. Create the project again.');
      const verbatim = playoffs && playoffs.verbatimGames.length > 0 ? playoffs.verbatimGames : null;
      let games: {
        roundNumber: number;
        roundId: string;
        slotId: string;
        leftTeamId: string;
        rightTeamId: string;
        existingMatchId?: string;
        source?: 'yft';
      }[];
      if (verbatim) {
        if (!playoffs!.gateReady) {
          throw new Error('The playoffs stay locked until all 30 prelim results are in. Reload the file first.');
        }
        games = verbatim.map((game) => {
          const round = tournament.rounds.find(
            (candidate) =>
              candidate.number === game.roundNumber && candidate.phaseId === compat.playoffPhaseId,
          );
          if (!round) throw new Error(`Round ${game.roundNumber} from the file is not a playoff round here.`);
          const room = manifest.rooms.find(
            (candidate) =>
              candidate.displayName === game.location || candidate.folderName === game.location,
          );
          if (!room) {
            throw new Error(
              `Round ${game.roundNumber} is scheduled in “${game.location ?? 'an unnamed room'}”, which is not one of this project's rooms.`,
            );
          }
          return {
            roundNumber: game.roundNumber,
            roundId: round.id,
            slotId: room.slotId,
            leftTeamId: game.leftTeamId,
            rightTeamId: game.rightTeamId,
            existingMatchId: game.matchId,
            source: 'yft' as const,
          };
        });
      } else {
        if (!manifest.playoffSlots) {
          setNotice({ kind: 'bad', message: 'Confirm the F/B slots first.' });
          return;
        }
        if (playoffs && !playoffs.gateReady) {
          throw new Error('The playoffs stay locked until all 30 prelim results are in. Reload the file first.');
        }
        games = planPlayoffs(compat, manifest.playoffSlots as PlayoffSlots);
      }
      const rooms = manifest.rooms.map((room) => ({
        slotId: room.slotId,
        displayName: room.displayName,
      }));
      const built = buildGames(games, rooms, tournament);
      const outcomes: Record<string, WriteOutcome> = {};
      let written = 0;
      let identical = 0;
      for (const entry of built) {
        const room = manifest.rooms.find((candidate) => candidate.slotId === entry.game.slotId)!;
        const target = joinPath(projectPath, room.folderName, IN_DIR_NAME, entry.fileName);
        try {
          await writeTextFile(target, entry.bytes);
          outcomes[entry.matchId] = 'written';
          written += 1;
        } catch (error) {
          if (!String(messageOf(error)).includes('already exists')) throw error;
          const existing = await readTextFile(target);
          if (existing === entry.bytes) {
            outcomes[entry.matchId] = 'identical';
            identical += 1;
          } else {
            outcomes[entry.matchId] = 'conflicted';
          }
        }
      }
      const planned = built.map((entry) => ({
        matchId: entry.matchId,
        roundNumber: entry.game.roundNumber,
        roundId: entry.game.roundId,
        slotId: entry.game.slotId,
        leftTeamId: entry.game.leftTeamId,
        rightTeamId: entry.game.rightTeamId,
        fileName: entry.fileName,
        ...(entry.game.source === 'yft' ? { source: 'yft' as const } : {}),
      }));
      const already = new Set(manifest.assignments.map((entry) => entry.matchId));
      const fresh = planned.filter((entry) => !already.has(entry.matchId));
      const { entries, conflicts } = partitionWrittenGames(fresh, outcomes);
      const next: ShuttleManifest = {
        ...manifest,
        assignments: [...manifest.assignments, ...entries],
      };
      await setManifest(next);
      setExpandedRound(6);
      const names = new Map(manifest.rooms.map((room) => [room.slotId, room.displayName]));
      const parts = [
        verbatim
          ? `Packaged the file's ${entries.length} playoff games into the room IN folders — YellowFruit's matchups, untouched.`
          : `Wrote ${written} playoff games into the room IN folders.`,
      ];
      if (identical > 0) parts.push(`${identical} identical files were left alone.`);
      if (conflicts.length > 0) {
        parts.push(
          `Not recorded (already exist here with different content): ${conflicts.map((conflict) => `Round ${conflict.roundNumber} / Room ${names.get(conflict.slotId) ?? conflict.slotId}`).join('; ')}. Those rooms still need their games by hand.`,
        );
      }
      setNotice({ kind: conflicts.length > 0 ? 'warn' : 'good', message: parts.join(' ') });
    });
  }, [compat, guard, manifest, playoffs, projectPath, tournament, setManifest]);

  const openPath = useCallback(
    async (path: string) => {
      await guard(async () => {
        const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
        await revealItemInDir(path);
      });
    },
    [guard],
  );

  const scanByMatchId = useMemo(() => {
    const map = new Map<
      string,
      (typeof report extends null ? never : NonNullable<typeof report>)['scans'][number]
    >();
    for (const scan of report?.scans ?? []) map.set(scan.assignment.matchId, scan);
    return map;
  }, [report]);

  return {
    native: isNativeHost(),
    busy,
    notice,
    dismissNotice,
    yftPath: session.yftPath ?? null,
    tournament,
    loadError,
    compat,
    compatErrors,
    scheduleSource,
    manifest,
    projectPath,
    pendingRecovery,
    report,
    scanByMatchId,
    playoffs,
    expandedRound,
    setExpandedRound,
    openYellowFruit,
    openExistingProject,
    cancelRecovery,
    changeYellowFruitFile,
    createProject,
    rescanOutFolders,
    chooseResult,
    prepareRound,
    createUpdatedCopy,
    loadUpdatedYellowFruit,
    reorderTiedGroup,
    confirmPlayoffSlots,
    generatePlayoffs,
    openPath,
  };
}

export type Shuttle = ReturnType<typeof useShuttle>;
export type { PlayoffLabel };
