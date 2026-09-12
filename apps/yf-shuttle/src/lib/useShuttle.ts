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
import {
  MANIFEST_FILE_NAME,
  createManifest,
  manifestFileContents,
  resolveManifestOnLoad,
  type ShuttleManifest,
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
  uniqueFileName,
  IMPORT_ROOT_NAME,
  IN_DIR_NAME,
  OUT_DIR_NAME,
} from './project';
import { reconcileScan, type ScanReport, type ScannedInputFile } from './scan';
import {
  assignSlotLabels,
  countDecidedPrelimGames,
  orderPrelimPool,
  verifyPlayoffPools,
  type PoolOrder,
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
  writeTextFile,
} from './native';
import {
  loadShuttleTournament,
  tournamentIdentityFingerprint,
  type ShuttleTournament,
} from './tournament';

export interface Notice {
  kind: 'good' | 'warn' | 'bad';
  message: string;
}

export interface PlayoffState {
  orders: { A: PoolOrder; B: PoolOrder };
  decidedGames: number;
  goldPoolName?: string;
  maroonPoolName?: string;
  verificationError?: string;
  /** Operator's explicit order inside each tied group, by pool letter. */
  manual: { A: string[]; B: string[] };
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

export function useShuttle() {
  const [session, setSession] = useState<PersistedSession>(() => readSession());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [lastFiles, setLastFiles] = useState<ScannedInputFile[]>([]);
  const [playoffs, setPlayoffs] = useState<PlayoffState | null>(null);
  const [expandedRound, setExpandedRound] = useState<number | null>(1);

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

  /** Open a `.yft`, adopting the existing project only when it names the same tournament. */
  const openYellowFruit = useCallback(async () => {
    await guard(async () => {
      const opened = await openYellowFruitFile();
      if (!opened) return;
      const loaded = loadShuttleTournament(opened.contents);
      if (!loaded.ok) {
        setNotice({ kind: 'bad', message: loaded.errors.join(' ') });
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
  }, [guard]);

  /** Forget the loaded file and start over. The project folder on disk is left untouched. */
  const changeYellowFruitFile = useCallback(() => {
    setSession({});
    setReport(null);
    setPlayoffs(null);
    setNotice(null);
  }, []);

  function buildGames(
    games: PlannedGame[],
    rooms: { slotId: string; displayName: string }[],
    source: ShuttleTournament,
  ): { fileName: string; bytes: string; matchId: string; game: PlannedGame }[] {
    const names = new Map(rooms.map((room) => [room.slotId, room.displayName]));
    const teams = new Map(source.teams.map((team) => [team.id, team]));
    const rounds = new Map(source.rounds.map((round) => [round.id, round]));
    const built: { fileName: string; bytes: string; matchId: string; game: PlannedGame }[] = [];
    for (const game of games) {
      const round = rounds.get(game.roundId);
      const left = teams.get(game.leftTeamId);
      const right = teams.get(game.rightTeamId);
      if (!round || !left || !right) {
        throw new Error(
          `Round ${game.roundNumber} can no longer be built: the file changed under it.`,
        );
      }
      const result = buildAssignment({
        tournament: source,
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

  /**
   * Create the project: folders, the 30 prelim assignments, and the manifest.
   *
   * Assignment writes are exclusive. An IN file that already exists with identical bytes is
   * left alone; one with different bytes is reported and kept — never overwritten blindly.
   */
  const createProject = useCallback(
    async (roomNames: Record<string, string>, folderName: string) => {
      if (!tournament || !compat) return;
      await guard(async () => {
        const parent = await chooseProjectParent();
        if (!parent) return;
        const safeFolder = safeFolderName(folderName || tournament.name, 'Tournament');
        const path = joinPath(parent, safeFolder);
        const rooms = ROOM_SLOTS.map((slot) => ({
          slotId: slot.id,
          displayName: (roomNames[slot.id] ?? '').trim() || slot.defaultName,
        }));
        const roomFolders = rooms.map((room) => room.displayName);
        const rounds = [...PRELIM_ROUNDS, ...PLAYOFF_ROUNDS];
        await createDirectories(parent, [safeFolder, ...projectDirectories(roomFolders, rounds).map((dir) => joinPath(safeFolder, dir))]);

        const games = planPrelims(compat);
        const built = buildGames(games, rooms, tournament);
        const skipped: string[] = [];
        const changed: string[] = [];
        for (const entry of built) {
          const room = rooms.find((candidate) => candidate.slotId === entry.game.slotId)!;
          const target = joinPath(path, room.displayName, IN_DIR_NAME, entry.fileName);
          try {
            await writeTextFile(target, entry.bytes);
          } catch (error) {
            if (!String(messageOf(error)).includes('already exists')) throw error;
            const existing = await readTextFile(target);
            if (existing === entry.bytes) {
              skipped.push(entry.fileName);
            } else {
              changed.push(`Round ${entry.game.roundNumber} / ${room.displayName}`);
            }
          }
        }

        const next = createManifest({
          tournamentId: tournament.id,
          tournamentName: tournament.name,
          tournamentFingerprint: tournamentIdentityFingerprint(tournament),
          rooms,
        });
        for (const entry of built) {
          if (changed.some((line) => line.includes(`Round ${entry.game.roundNumber}`))) continue;
          next.assignments.push({
            matchId: entry.matchId,
            roundNumber: entry.game.roundNumber,
            roundId: entry.game.roundId,
            slotId: entry.game.slotId,
            leftTeamId: entry.game.leftTeamId,
            rightTeamId: entry.game.rightTeamId,
            fileName: entry.fileName,
          });
        }
        setSession((previous) => ({ ...previous, projectPath: path, manifest: next }));
        await writeManifestToDisk(path, next);
        const parts = [`Created the project folder with ${next.assignments.length} prelim games.`];
        if (skipped.length > 0) parts.push(`${skipped.length} identical files were left alone.`);
        if (changed.length > 0) {
          parts.push(
            `Left untouched (already exist with different content): ${[...new Set(changed)].join('; ')}.`,
          );
        }
        setNotice({ kind: changed.length > 0 ? 'warn' : 'good', message: parts.join(' ') });
      });
    },
    [compat, guard, tournament, writeManifestToDisk],
  );

  /** Rescan every room's OUT folder and reconcile against the manifest. */
  const rescanOutFolders = useCallback(async () => {
    if (!manifest || !projectPath) return;
    await guard(async () => {
      const files: ScannedInputFile[] = [];
      for (const room of manifest.rooms) {
        const out = joinPath(projectPath, room.displayName, OUT_DIR_NAME);
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
            folderName: room.displayName,
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
      const parts = [`Scanned ${files.length} file${files.length === 1 ? '' : 's'}: ${chosen} result${chosen === 1 ? '' : 's'} returned.`];
      if (needsChoice > 0) parts.push(`${needsChoice} game${needsChoice === 1 ? ' needs' : 's need'} you to choose between duplicate results.`);
      if (problems > 0) parts.push(`${problems} file${problems === 1 ? ' needs' : 's need'} attention.`);
      setNotice({ kind: problems > 0 || needsChoice > 0 ? 'warn' : 'good', message: parts.join(' ') });
    });
  }, [guard, manifest, projectPath]);

  /** Remember the operator's choice between duplicate results for one game. */
  const chooseResult = useCallback(
    async (matchId: string, fileName: string) => {
      if (!manifest) return;
      const next: ShuttleManifest = {
        ...manifest,
        selectedResults: { ...manifest.selectedResults, [matchId]: fileName },
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
   * The bytes are never parsed or reserialized for output — only copied. Destination names
   * are descriptive; identity stays inside the files.
   */
  const prepareRound = useCallback(
    async (roundNumber: number) => {
      if (!manifest || !projectPath || !report || !tournament) return;
      await guard(async () => {
        const names = new Map(tournament.teams.map((team) => [team.id, team.name]));
        const scans = report.scans.filter(
          (scan) => scan.assignment.roundNumber === roundNumber && scan.chosen,
        );
        if (scans.length === 0) throw new Error(`Round ${roundNumber} has no returned results to prepare.`);
        const pending = report.scans.filter(
          (scan) => scan.assignment.roundNumber === roundNumber && !scan.chosen,
        );
        const folder = joinPath(projectPath, IMPORT_ROOT_NAME, importFolderName(roundNumber));
        const existing = await listDirectory(folder).catch(() => []);
        const taken = new Set(existing.map((entry) => entry.name.toLowerCase()));
        let copied = 0;
        for (const scan of scans) {
          const chosen = scan.chosen!;
          const room =
            manifest.rooms.find((entry) => entry.slotId === scan.assignment.slotId)?.displayName ??
            scan.assignment.slotId;
          const candidate = assignmentFileName({
            roundNumber,
            roomName: room,
            leftTeamName: names.get(scan.assignment.leftTeamId) ?? 'Team',
            rightTeamName: names.get(scan.assignment.rightTeamId) ?? 'Team',
          });
          const destName = uniqueFileName(candidate, taken);
          taken.add(destName.toLowerCase());
          await copyFile(
            joinPath(projectPath, chosen.folderName, OUT_DIR_NAME, chosen.fileName),
            joinPath(folder, destName),
            true,
          );
          copied += 1;
        }
        const next: ShuttleManifest = {
          ...manifest,
          preparedRounds: [...new Set([...manifest.preparedRounds, roundNumber])].sort((a, b) => a - b),
        };
        await setManifest(next);
        const parts = [
          `Round ${roundNumber} is ready for YellowFruit: ${copied} file${copied === 1 ? '' : 's'} in “YellowFruit Import / Round ${roundNumber}”. In YellowFruit, open Games → Import and select ${copied === 1 ? 'it' : 'them'}.`,
        ];
        if (pending.length > 0) {
          parts.push(`${pending.length} game${pending.length === 1 ? ' is' : 's are'} still waiting — the batch can be prepared again later.`);
        }
        setNotice({ kind: pending.length > 0 ? 'warn' : 'good', message: parts.join(' ') });
      });
    },
    [guard, manifest, projectPath, report, tournament, setManifest],
  );

  /**
   * Load the rebracketed `.yft`: same tournament, prelim order, and pool verification.
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
      const decided = countDecidedPrelimGames({
        tournament: updated,
        prelimPhaseId: compatCheck.compat.prelimPhaseId,
      });
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
      // Adopt the reloaded file as the working tournament (rosters may have been corrected),
      // keeping the project: same event, same rooms, same prelim assignments.
      setSession((previous) => ({ ...previous, yftPath: opened.path, yftText: opened.contents }));
      setPlayoffs((previous) => ({
        orders: { A: orderA, B: orderB },
        decidedGames: decided,
        manual: previous?.manual ?? { A: [], B: [] },
      }));
      const lines = [
        `Reloaded the updated file: ${decided} of 30 prelim games decided. Confirm the F/B slots below.`,
      ];
      if (decided < 30) {
        lines.push(
          `Only ${decided} of 30 prelim games are decided in this file — import every prelim result into YellowFruit and save it before trusting these slots.`,
        );
      }
      setNotice({ kind: decided < 30 ? 'warn' : 'good', message: lines.join(' ') });
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

  /** Confirm F1–F6 / B1–B6 against YellowFruit's own playoff pools. */
  const confirmPlayoffSlots = useCallback(async () => {
    if (!manifest || !tournament || !compat || !playoffs) return;
    await guard(async () => {
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
        setPlayoffs((previous) =>
          previous ? { ...previous, verificationError: verified.error } : previous,
        );
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

  /** Write the 18 playoff assignments into the same room IN folders. */
  const generatePlayoffs = useCallback(async () => {
    if (!manifest || !tournament || !compat) return;
    if (!manifest.playoffSlots) {
      setNotice({ kind: 'bad', message: 'Confirm the F/B slots first.' });
      return;
    }
    await guard(async () => {
      if (!projectPath) throw new Error('The project folder is gone. Create the project again.');
      const games = planPlayoffs(compat, manifest.playoffSlots as PlayoffSlots);
      const built = buildGames(games, manifest.rooms, tournament);
      let written = 0;
      const kept: string[] = [];
      for (const entry of built) {
        const room = manifest.rooms.find((candidate) => candidate.slotId === entry.game.slotId)!;
        const target = joinPath(projectPath, room.displayName, IN_DIR_NAME, entry.fileName);
        try {
          await writeTextFile(target, entry.bytes);
          written += 1;
        } catch (error) {
          if (!String(messageOf(error)).includes('already exists')) throw error;
          const existing = await readTextFile(target);
          if (existing !== entry.bytes) kept.push(`Round ${entry.game.roundNumber} / ${room.displayName}`);
        }
      }
      const known = new Set(manifest.assignments.map((entry) => entry.matchId));
      const next: ShuttleManifest = {
        ...manifest,
        assignments: [
          ...manifest.assignments,
          ...built
            .filter((entry) => !known.has(entry.matchId))
            .map((entry) => ({
              matchId: entry.matchId,
              roundNumber: entry.game.roundNumber,
              roundId: entry.game.roundId,
              slotId: entry.game.slotId,
              leftTeamId: entry.game.leftTeamId,
              rightTeamId: entry.game.rightTeamId,
              fileName: entry.fileName,
            })),
        ],
      };
      await setManifest(next);
      setExpandedRound(6);
      const parts = [`Wrote ${written} playoff games into the room IN folders.`];
      if (kept.length > 0) {
        parts.push(`Left untouched (already exist with different content): ${[...new Set(kept)].join('; ')}.`);
      }
      setNotice({ kind: kept.length > 0 ? 'warn' : 'good', message: parts.join(' ') });
    });
  }, [compat, guard, manifest, projectPath, tournament, setManifest]);

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
    const map = new Map<string, (typeof report extends null ? never : NonNullable<typeof report>)['scans'][number]>();
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
    manifest,
    projectPath,
    report,
    scanByMatchId,
    playoffs,
    expandedRound,
    setExpandedRound,
    openYellowFruit,
    changeYellowFruitFile,
    createProject,
    rescanOutFolders,
    chooseResult,
    prepareRound,
    loadUpdatedYellowFruit,
    reorderTiedGroup,
    confirmPlayoffSlots,
    generatePlayoffs,
    openPath,
  };
}

export type Shuttle = ReturnType<typeof useShuttle>;
export type { PlayoffLabel };
