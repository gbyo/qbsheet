/**
 * Tournament-day rehearsal, run headless against the real hook and the real filesystem.
 *
 * One temporary project walks the whole Wildcat flow the way an operator would: load the
 * `.yft`, create the project, score Round 1 through QBSheet's real result builder, prove a
 * mid-game lifeboat copy is never treated as finished, prepare and re-prepare the import
 * batch, correct a duplicate, lose localStorage, recover from `.yf-shuttle.json`, reload a
 * rebracketed file through the 30-game gate, confirm slots, generate the exact 18 playoff
 * games, and prepare those too. The native layer is a thin Node `fs` double — every line of
 * hook, scan, batch, manifest, playoff, and schedule logic under test is the shipped code.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { planPlayoffs, type PlayoffSlots } from './schedule';
import { planPrelims, validateWildcatCompatibility } from './schedule';
import { loadShuttleTournament, type ShuttleTournament } from './tournament';
import { safeFolderName } from './project';
import { readQbjSource } from '../../../../src/qbj/ParseQbjAssignment';
import { loadedSynthetic, scoreCustomGame, syntheticYftText, type SyntheticResult } from '../tests/helpers';
import { useShuttle } from './useShuttle';

const scripted = vi.hoisted(() => ({
  parents: [] as (string | null)[],
  files: [] as { path: string; contents: string }[],
  openedPaths: [] as string[],
}));

/** The native shell, backed by the real filesystem instead of Tauri dialogs and commands. */
vi.mock('./native', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const path = await vi.importActual<typeof import('node:path')>('node:path');

  const missing = (what: string): Error => new Error(`${what} does not exist`);
  const alreadyExists = (target: string): Error => new Error(`"${target}" already exists`);

  return {
    NativeUnavailableError: class NativeUnavailableError extends Error {},
    isNativeHost: () => true,
    openPath: (target: string) => {
      scripted.openedPaths.push(target);
    },
    chooseProjectParent: async () => scripted.parents.shift() ?? null,
    openYellowFruitFile: async () => scripted.files.shift() ?? null,
    createDirectories: async (base: string, dirs: string[]) => {
      for (const dir of dirs) fs.mkdirSync(path.join(base, dir), { recursive: true });
    },
    listDirectory: async (dir: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        throw missing(dir);
      }
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        modifiedMs: fs.statSync(path.join(dir, entry.name)).mtimeMs,
      }));
    },
    readTextFile: async (target: string) => {
      try {
        return fs.readFileSync(target, 'utf8');
      } catch {
        throw missing(target);
      }
    },
    writeTextFile: async (target: string, contents: string, options?: { overwrite?: boolean }) => {
      if (!options?.overwrite && fs.existsSync(target)) throw alreadyExists(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    },
    copyFile: async (src: string, dst: string, overwrite = false) => {
      if (!overwrite && fs.existsSync(dst)) throw alreadyExists(dst);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    },
    removeImportFile: async (importRoot: string, relativePath: string) => {
      const segments = relativePath.split('/');
      const [roundFolder, fileName, end] = segments;
      if (
        segments.length !== 2 ||
        !roundFolder?.startsWith('Round ') ||
        (!fileName?.endsWith('.qbj') && !fileName?.endsWith('.json')) ||
        end !== undefined
      ) {
        throw new Error('Only files directly inside a Round folder can be removed.');
      }
      const target = path.join(importRoot, roundFolder, fileName);
      if (!target.startsWith(importRoot))
        throw new Error('Only files inside the import tree can be removed.');
      try {
        fs.unlinkSync(target);
      } catch {
        throw new Error('That derived file is already gone.');
      }
    },
  };
});

const RANK_A = [1, 4, 5, 8, 9, 12];
const RANK_B = [2, 3, 6, 7, 10, 11];

function rankOf(seed: number): number {
  const rankA = RANK_A.indexOf(seed);
  if (rankA >= 0) return rankA;
  return 100 + RANK_B.indexOf(seed);
}

/**
 * A full 30-game prelim result set with a strict transitive order inside each pool, so the
 * file separates every team without a human tie-break: 1>4>5>8>9>12 and 2>3>6>7>10>11.
 */
function transitivePrelimResults(tournament: ShuttleTournament): SyntheticResult[] {
  const compat = validateWildcatCompatibility(tournament);
  if (!compat.ok) throw new Error(compat.errors.join(' '));
  const seedOf = new Map(tournament.teams.map((team) => [team.id, team.seed!]));
  return planPrelims(compat.compat).map((game) => {
    const leftSeed = seedOf.get(game.leftTeamId)!;
    const rightSeed = seedOf.get(game.rightTeamId)!;
    const leftWins = rankOf(leftSeed) < rankOf(rightSeed);
    return {
      round: game.roundNumber,
      leftSeed,
      rightSeed,
      leftPoints: leftWins ? 300 : 200,
      rightPoints: leftWins ? 200 : 300,
    };
  });
}

function teamIdOf(tournament: ShuttleTournament, seed: number): string {
  const team = tournament.teams.find((candidate) => candidate.seed === seed);
  if (!team) throw new Error(`no team with seed ${seed}`);
  return team.id;
}

/** Gold takes the top three of each prelim pool; Maroon takes the bottom three. */
function playoffPoolSpecs(
  tournament: ShuttleTournament,
): { name: string; position: number; teamIds: string[] }[] {
  return [
    {
      name: 'Gold',
      position: 1,
      teamIds: [1, 4, 5, 2, 3, 6].map((seed) => teamIdOf(tournament, seed)),
    },
    {
      name: 'Maroon',
      position: 2,
      teamIds: [8, 9, 12, 7, 10, 11].map((seed) => teamIdOf(tournament, seed)),
    },
  ];
}

/** Score one manifest assignment through QBSheet's real result builder, keeping its Match id. */
function scoreAssigned(
  tournament: ShuttleTournament,
  assignment: {
    matchId: string;
    roundNumber: number;
    roundId: string;
    slotId: string;
    leftTeamId: string;
    rightTeamId: string;
  },
  options: { partial?: boolean } = {},
): string {
  const round = tournament.rounds.find((candidate) => candidate.id === assignment.roundId);
  if (!round) throw new Error(`round ${assignment.roundId} vanished`);
  const scored = scoreCustomGame(tournament, {
    roundId: round.id,
    roundQbjName: round.qbjName,
    roundNumber: assignment.roundNumber,
    phaseId: round.phaseId,
    phaseName: round.phaseName,
    slotId: assignment.slotId,
    roomName: assignment.slotId,
    leftTeamId: assignment.leftTeamId,
    rightTeamId: assignment.rightTeamId,
    existingMatchId: assignment.matchId,
    ...(options.partial ? { partial: true as const } : {}),
  });
  expect(scored.matchId).toBe(assignment.matchId);
  return scored.resultText;
}

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

const ROOM_NAMES: Record<string, string> = {
  'slot-gold-1': '319',
  'slot-gold-2': '320',
  'slot-gold-3': '321',
  'slot-maroon-1': '322',
  'slot-maroon-2': '323',
  'slot-maroon-3': '324',
};

describe('tournament-day rehearsal', () => {
  test('load, print, score, prepare, recover, rebracket, playoffs', async () => {
    const tournament = loadedSynthetic();
    const baseText = syntheticYftText();
    const fullResults = transitivePrelimResults(tournament);
    const updatedFullText = syntheticYftText({
      prelimResults: fullResults,
      playoffPools: playoffPoolSpecs(tournament),
    });
    const updatedShortText = syntheticYftText({
      prelimResults: fullResults.filter(
        (result) => !(result.round === 4 && result.leftSeed === 5 && result.rightSeed === 12),
      ),
      playoffPools: playoffPoolSpecs(tournament),
    });

    const parent = mkdtempSync(`${tmpdir()}/yfshuttle-rehearsal-`);
    scripted.parents.push(parent);
    scripted.files.push({ path: '/wildcat.yft', contents: baseText });
    const { result } = renderHook(() => useShuttle());

    // 1. Load the YFT. The file holds no scheduled games, so the preset applies.
    await act(async () => {
      await result.current.openYellowFruit();
    });
    expect(result.current.tournament?.id).toBe('Tournament_Synthetic');
    expect(result.current.scheduleSource?.kind).toBe('preset');
    expect(result.current.notice?.kind).not.toBe('bad');

    // 2–3. Create the project: six rooms, 30 prelim assignments on disk.
    await act(async () => {
      await result.current.createProject(ROOM_NAMES, 'Wildcat');
    });
    const projectPath = result.current.projectPath;
    expect(projectPath).toContain('Wildcat');
    expect(result.current.manifest?.assignments).toHaveLength(30);
    // Six rooms, one IN file per prelim game: 30 assignment files on disk.
    let inCount = 0;
    for (const folder of Object.values(ROOM_NAMES)) {
      inCount += filesIn(`${projectPath}/${folder}/IN`).length;
    }
    expect(inCount).toBe(30);
    const round1Assignments = result.current.manifest!.assignments.filter((entry) => entry.roundNumber === 1);
    expect(round1Assignments).toHaveLength(6);
    for (const assignment of round1Assignments) {
      const room = ROOM_NAMES[assignment.slotId]!;
      const text = readFileSync(`${projectPath}/${room}/IN/${assignment.fileName}`, 'utf8');
      // 4–5. Every printed assignment opens through QBSheet's real parser.
      const parsed = readQbjSource(JSON.parse(text));
      expect(parsed.ok, `${assignment.fileName} parses`).toBe(true);
    }

    // 6–8. Score five games; the sixth room drops a mid-game lifeboat copy in OUT.
    for (const assignment of round1Assignments.slice(0, 5)) {
      writeFileSync(
        `${projectPath}/${ROOM_NAMES[assignment.slotId]}/OUT/${assignment.fileName}`,
        scoreAssigned(tournament, assignment),
      );
    }
    const sixth = round1Assignments[5];
    writeFileSync(
      `${projectPath}/${ROOM_NAMES[sixth.slotId]}/OUT/lifeboat-${sixth.fileName}`,
      scoreAssigned(tournament, sixth, { partial: true }),
    );
    await act(async () => {
      await result.current.rescanOutFolders();
    });
    const scans = result.current.report!.scans.filter((scan) => scan.assignment.roundNumber === 1);
    expect(scans.filter((scan) => scan.chosen)).toHaveLength(5);
    const sixthScan = scans.find((scan) => scan.assignment.matchId === sixth.matchId)!;
    // The partial copy is visible as not-ready — never a result candidate.
    expect(sixthScan.chosen).toBeUndefined();
    expect(sixthScan.candidates).toHaveLength(0);
    expect(sixthScan.partialCopies).toHaveLength(1);

    // 10. Prepare at 5/6: five deterministic derived copies, nothing else.
    await act(async () => {
      await result.current.prepareRound(1);
    });
    const import1 = `${projectPath}/YellowFruit Import/Round 1`;
    expect(filesIn(import1)).toHaveLength(5);
    expect(filesIn(import1).some((name) => name.includes('(2)'))).toBe(false);

    // The sixth result arrives; preparing again must total six, not eleven.
    const sixthText = scoreAssigned(tournament, sixth);
    writeFileSync(`${projectPath}/${ROOM_NAMES[sixth.slotId]}/OUT/${sixth.fileName}`, sixthText);
    const outBefore = new Map<string, string>();
    for (const assignment of round1Assignments) {
      outBefore.set(
        assignment.matchId,
        readFileSync(`${projectPath}/${ROOM_NAMES[assignment.slotId]}/OUT/${assignment.fileName}`, 'utf8'),
      );
    }
    await act(async () => {
      await result.current.rescanOutFolders();
    });
    await act(async () => {
      await result.current.prepareRound(1);
    });
    const secondBatch = filesIn(import1);
    // 11. Exactly six derived files — re-preparing overwrote, never duplicated.
    expect(secondBatch).toHaveLength(6);
    expect(secondBatch.some((name) => name.includes('(2)'))).toBe(false);
    for (const assignment of round1Assignments) {
      expect(secondBatch).toContain(assignment.fileName);
      expect(readFileSync(`${import1}/${assignment.fileName}`, 'utf8')).toBe(
        outBefore.get(assignment.matchId),
      );
    }
    // OUT originals are byte-for-byte untouched by the batch.
    for (const assignment of round1Assignments) {
      expect(
        readFileSync(`${projectPath}/${ROOM_NAMES[assignment.slotId]}/OUT/${assignment.fileName}`, 'utf8'),
      ).toBe(outBefore.get(assignment.matchId));
    }

    // A hand-placed file in the import folder survives every prepare.
    writeFileSync(`${import1}/hand-placed.qbj`, '{"hand": "placed"}\n');
    await act(async () => {
      await result.current.prepareRound(1);
    });
    expect(filesIn(import1)).toHaveLength(7);
    expect(readFileSync(`${import1}/hand-placed.qbj`, 'utf8')).toBe('{"hand": "placed"}\n');

    // 12. A duplicate result for one game (a double download of the same game): the choice
    // points at the physical file, and re-preparing replaces that game's derived copy.
    const dupTarget = round1Assignments[0];
    const correctedText = scoreAssigned(tournament, dupTarget);
    writeFileSync(
      `${projectPath}/${ROOM_NAMES[dupTarget.slotId]}/OUT/corrected-${dupTarget.fileName}`,
      correctedText,
    );
    await act(async () => {
      await result.current.rescanOutFolders();
    });
    const dupScan = result.current.report!.scans.find(
      (scan) => scan.assignment.matchId === dupTarget.matchId,
    )!;
    expect(dupScan.needsChoice).toBe(true);
    expect(dupScan.candidates).toHaveLength(2);
    const [firstCandidate, secondCandidate] = dupScan.candidates;
    expect(firstCandidate.candidateId).not.toBe(secondCandidate.candidateId);
    const corrected = dupScan.candidates.find((candidate) => candidate.fileName.startsWith('corrected-'))!;
    await act(async () => {
      await result.current.chooseResult(dupTarget.matchId, corrected.candidateId);
    });
    expect(result.current.manifest!.selectedResults[dupTarget.matchId]).toBe(corrected.candidateId);
    // Sabotage the previously derived copy: the next prepare must restore it from the
    // chosen file, proving re-prepare overwrites rather than accumulates or skips.
    writeFileSync(`${import1}/${dupTarget.fileName}`, '{"sabotaged": true}\n');
    await act(async () => {
      await result.current.prepareRound(1);
    });
    // Still one derived copy per game (plus the untouched hand-placed file).
    expect(filesIn(import1)).toHaveLength(7);
    expect(readFileSync(`${import1}/${dupTarget.fileName}`, 'utf8')).toBe(correctedText);

    // 13. Lose everything: a fresh hook with empty storage recovers from disk.
    globalThis.localStorage.clear();
    const revived = renderHook(() => useShuttle());
    scripted.parents.push(projectPath!);
    await act(async () => {
      await revived.result.current.openExistingProject();
    });
    // No YFT is loaded in the fresh session, so the project parks as pending.
    expect(revived.result.current.pendingRecovery?.path).toBe(projectPath);
    expect(revived.result.current.manifest).toBeNull();

    // A different tournament is refused; the pending project survives the attempt.
    const otherText = baseText.replace('"id":"Tournament_Synthetic"', '"id":"Tournament_Other"');
    expect(otherText).not.toBe(baseText);
    scripted.files.push({ path: '/other.yft', contents: otherText });
    await act(async () => {
      await revived.result.current.openYellowFruit();
    });
    expect(revived.result.current.notice?.kind).toBe('bad');
    expect(revived.result.current.pendingRecovery?.path).toBe(projectPath);

    // The matching file activates the full project: rooms, games, choices, prepared rounds.
    scripted.files.push({ path: '/wildcat-updated.yft', contents: updatedFullText });
    await act(async () => {
      await revived.result.current.openYellowFruit();
    });
    expect(revived.result.current.pendingRecovery).toBeNull();
    expect(revived.result.current.manifest?.assignments).toHaveLength(30);
    expect(revived.result.current.manifest?.selectedResults[dupTarget.matchId]).toBe(corrected.candidateId);
    expect(revived.result.current.manifest?.preparedRounds).toContain(1);

    // 14–15. A short file locks the playoffs with the exact missing game named.
    scripted.files.push({ path: '/wildcat-short.yft', contents: updatedShortText });
    await act(async () => {
      await revived.result.current.loadUpdatedYellowFruit();
    });
    expect(revived.result.current.playoffs?.gateReady).toBe(false);
    expect(revived.result.current.notice?.kind).toBe('bad');
    expect(revived.result.current.notice?.message).toContain('29 of 30');
    await act(async () => {
      await revived.result.current.confirmPlayoffSlots();
    });
    expect(revived.result.current.notice?.kind).toBe('bad');
    expect(revived.result.current.manifest?.playoffSlots).toBeUndefined();

    // The full file opens the gate: confirm ranks nothing by hand (no ties), verify pools.
    scripted.files.push({ path: '/wildcat-full.yft', contents: updatedFullText });
    await act(async () => {
      await revived.result.current.loadUpdatedYellowFruit();
    });
    expect(revived.result.current.playoffs?.gateReady).toBe(true);
    expect(revived.result.current.playoffs?.verbatimGames).toHaveLength(0);
    await act(async () => {
      await revived.result.current.confirmPlayoffSlots();
    });
    const slots = revived.result.current.manifest?.playoffSlots;
    expect(slots?.F1).toBe(teamIdOf(tournament, 1));
    expect(slots?.F2).toBe(teamIdOf(tournament, 4));
    expect(slots?.B1).toBe(teamIdOf(tournament, 2));

    // 16. The exact printed 18 playoff games land in the room IN folders.
    await act(async () => {
      await revived.result.current.generatePlayoffs();
    });
    const playoffAssignments = revived.result.current.manifest!.assignments.filter(
      (entry) => entry.roundNumber >= 6,
    );
    expect(playoffAssignments).toHaveLength(18);
    expect(revived.result.current.manifest!.assignments).toHaveLength(48);
    const nameOf = (seed: number): string => `Seed ${seed}`;
    const matchup = (round: number, room: string): string => {
      const game = playoffAssignments.find(
        (entry) =>
          entry.roundNumber === round &&
          revived.result.current.manifest!.rooms.find((r) => r.slotId === entry.slotId)?.displayName === room,
      )!;
      const left = tournament.teams.find((team) => team.id === game.leftTeamId)!.name;
      const right = tournament.teams.find((team) => team.id === game.rightTeamId)!.name;
      return `${left} vs ${right}`;
    };
    // Printed table, Gold R6: gold-1 F2–F3, gold-2 F1–B3, gold-3 B1–B2.
    expect(matchup(6, '319')).toBe(`${nameOf(4)} vs ${nameOf(5)}`);
    expect(matchup(6, '320')).toBe(`${nameOf(1)} vs ${nameOf(6)}`);
    expect(matchup(6, '321')).toBe(`${nameOf(2)} vs ${nameOf(3)}`);

    // 17. Score every playoff game and prepare Rounds 6–8: six files each, no more.
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const planned = planPlayoffs(compat.compat, slots as PlayoffSlots);
    expect(planned).toHaveLength(18);
    for (const game of planned) {
      const assignment = playoffAssignments.find(
        (entry) => entry.roundNumber === game.roundNumber && entry.slotId === game.slotId,
      )!;
      const room = revived.result.current.manifest!.rooms.find((r) => r.slotId === game.slotId)!;
      writeFileSync(
        `${projectPath}/${room.folderName}/OUT/${assignment.fileName}`,
        scoreAssigned(tournament, assignment),
      );
    }
    await act(async () => {
      await revived.result.current.rescanOutFolders();
    });
    for (const round of [6, 7, 8]) {
      await act(async () => {
        await revived.result.current.prepareRound(round);
      });
      const folder = `${projectPath}/YellowFruit Import/Round ${round}`;
      expect(filesIn(folder)).toHaveLength(6);
      await act(async () => {
        await revived.result.current.prepareRound(round);
      });
      expect(filesIn(folder)).toHaveLength(6);
    }
  });

  test('file-scheduled games keep their ids and fill a new copy, never a batch', async () => {
    const tournament = loadedSynthetic();
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const seedOf = new Map(tournament.teams.map((team) => [team.id, team.seed!]));
    const roomForSlot = (slotId: string): string =>
      ({ 'slot-gold-1': '319', 'slot-gold-2': '320', 'slot-gold-3': '321' })[slotId] ??
      { 'slot-maroon-1': '322', 'slot-maroon-2': '323' }[slotId] ??
      '324';

    // The file itself schedules all 30 prelim games, one room per game per round.
    const blanks = planPrelims(compat.compat).map((game, index) => ({
      round: game.roundNumber,
      leftSeed: seedOf.get(game.leftTeamId)!,
      rightSeed: seedOf.get(game.rightTeamId)!,
      location: roomForSlot(game.slotId),
      id: `Match_Blank${index}`,
    }));
    const scheduledText = syntheticYftText({ scheduledBlanks: blanks });

    const parent = mkdtempSync(`${tmpdir()}/yfshuttle-yftmode-`);
    scripted.parents.push(parent);
    scripted.files.push({ path: '/scheduled.yft', contents: scheduledText });
    const { result } = renderHook(() => useShuttle());
    await act(async () => {
      await result.current.openYellowFruit();
    });
    expect(result.current.scheduleSource?.kind).toBe('yft');

    await act(async () => {
      await result.current.createProject({}, 'WildcatYft');
    });
    const projectPath = result.current.projectPath!;
    const assignments = result.current.manifest!.assignments;
    expect(assignments).toHaveLength(30);
    // The file's Match ids survive into the manifest — nothing is re-derived.
    expect(assignments[0].matchId).toBe('Match_Blank0');
    expect(assignments[0].source).toBe('yft');
    expect(result.current.manifest!.rooms.map((room) => room.folderName).sort()).toEqual([
      '319',
      '320',
      '321',
      '322',
      '323',
      '324',
    ]);

    // A completed result for a scheduled game must NOT take the import-batch path:
    // YellowFruit would append it as a second game next to the blank. (In file mode the
    // slot id is the room location itself.)
    const first = assignments.find((entry) => entry.roundNumber === 1 && entry.slotId === '319')!;
    writeFileSync(`${projectPath}/319/OUT/${first.fileName}`, scoreAssigned(tournament, first));
    await act(async () => {
      await result.current.rescanOutFolders();
    });
    await act(async () => {
      await result.current.prepareRound(1);
    });
    expect(result.current.notice?.kind).toBe('bad');
    expect(result.current.notice?.message).toMatch(/updated YellowFruit copy/);

    // The fill-copy path writes a NEW file with exactly that blank filled.
    await act(async () => {
      await result.current.createUpdatedCopy(1);
    });
    expect(result.current.notice?.kind).toBe('good');
    const copyName = `${safeFolderName(tournament.name, 'Tournament')} - Round 1 updated.yft`;
    const copyText = readFileSync(`${projectPath}/${copyName}`, 'utf8');
    const findMatch = (text: string, id: string): { match_teams: { points?: number }[] } => {
      const doc = JSON.parse(text) as { objects: Record<string, unknown>[] };
      const yft = doc.objects.find((object) => object.type === 'Tournament') as {
        phases: { rounds: { matches: unknown[] }[] }[];
      };
      for (const phase of yft.phases) {
        for (const round of phase.rounds) {
          const found = round.matches.find(
            (match) => typeof match === 'object' && match !== null && (match as { id?: unknown }).id === id,
          ) as { match_teams: { points?: number }[] } | undefined;
          if (found) return found;
        }
      }
      throw new Error(`match ${id} not found`);
    };
    const filled = findMatch(copyText, first.matchId);
    expect(filled.match_teams.every((side) => typeof side.points === 'number')).toBe(true);
    // The source text on disk is untouched — the blank is still blank there.
    const blank = findMatch(scheduledText, first.matchId);
    expect(blank.match_teams.some((side) => typeof side.points === 'number')).toBe(false);
    // And the copy still loads as the same tournament through QBSheet's importer.
    const reloaded = loadShuttleTournament(copyText);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.tournament.id).toBe('Tournament_Synthetic');

    // Playoff blanks in the file are packaged verbatim: no ranking, no slots.
    const playoffBlanks = [6, 7, 8].flatMap((round) =>
      [1, 2, 3, 4, 5, 6].map((game, index) => ({
        round,
        leftSeed: game * 2 - 1,
        rightSeed: game * 2,
        location: ['319', '320', '321', '322', '323', '324'][index]!,
        id: `Match_PlayoffBlank${round}-${index}`,
      })),
    );
    const fullResults = transitivePrelimResults(tournament);
    const updatedText = syntheticYftText({
      prelimResults: fullResults,
      playoffPools: playoffPoolSpecs(tournament),
      scheduledBlanks: playoffBlanks,
    });
    scripted.files.push({ path: '/scheduled-updated.yft', contents: updatedText });
    await act(async () => {
      await result.current.loadUpdatedYellowFruit();
    });
    expect(result.current.playoffs?.gateReady).toBe(true);
    expect(result.current.playoffs?.verbatimGames).toHaveLength(18);
    await act(async () => {
      await result.current.generatePlayoffs();
    });
    const playoffAssignments = result.current.manifest!.assignments.filter((entry) => entry.roundNumber >= 6);
    expect(playoffAssignments).toHaveLength(18);
    expect(playoffAssignments.every((entry) => entry.matchId.startsWith('Match_PlayoffBlank'))).toBe(true);
    expect(result.current.manifest?.playoffSlots).toBeUndefined();
  });
});
