/**
 * OUT-folder reconciliation: identity by Match id, never by filename or folder.
 *
 * Every scenario here uses results a real scorer produced (`scorePrelimGame`), so the bytes
 * under test are the bytes a room hands back — including the wrong-folder, duplicate, and
 * untouched-assignment cases.
 */

import { describe, expect, test } from 'vitest';
import { assignmentFileContents, buildAssignment } from './assignment';
import { createManifest } from './manifest';
import { planPrelims, ROOM_SLOTS, validateWildcatCompatibility } from './schedule';
import { parseResultFile, playStateOf, reconcileScan, type ScannedInputFile } from './scan';
import { tournamentIdentityFingerprint } from './tournament';
import { loadedSynthetic, scorePartialGame, scorePrelimGame } from '../tests/helpers';

const ROOM_NAMES: Record<string, string> = {
  'slot-gold-1': '319',
  'slot-gold-2': '320',
  'slot-gold-3': '321',
  'slot-maroon-1': '315',
  'slot-maroon-2': '317',
  'slot-maroon-3': '318',
};

function project() {
  const tournament = loadedSynthetic();
  const compat = validateWildcatCompatibility(tournament);
  if (!compat.ok) throw new Error(compat.errors.join(' '));
  const planned = planPrelims(compat.compat);
  const teams = new Map(tournament.teams.map((team) => [team.id, team]));
  const manifest = createManifest({
    tournamentId: tournament.id,
    tournamentName: tournament.name,
    tournamentFingerprint: tournamentIdentityFingerprint(tournament),
    rooms: ROOM_SLOTS.map((slot) => ({
      slotId: slot.id,
      displayName: ROOM_NAMES[slot.id],
      folderName: ROOM_NAMES[slot.id],
    })),
  });
  for (const game of planned) {
    const round = compat.compat.roundsByNumber.get(game.roundNumber)!;
    const built = buildAssignment({
      tournament,
      roundId: round.id,
      roundQbjName: round.qbjName,
      roundNumber: game.roundNumber,
      phaseId: round.phaseId,
      phaseName: round.phaseName,
      slotId: game.slotId,
      roomName: ROOM_NAMES[game.slotId],
      left: teams.get(game.leftTeamId)!,
      right: teams.get(game.rightTeamId)!,
    });
    if (!built.ok) throw new Error(built.error);
    manifest.assignments.push({
      matchId: built.assignment.matchId,
      roundNumber: game.roundNumber,
      roundId: game.roundId,
      slotId: game.slotId,
      leftTeamId: game.leftTeamId,
      rightTeamId: game.rightTeamId,
      fileName: `R0${game.roundNumber} - ${ROOM_NAMES[game.slotId]}.qbj`,
    });
  }
  return { tournament, manifest };
}

function outFile(folderName: string, fileName: string, bytes: string, modifiedMs = 1000): ScannedInputFile {
  return { folderName, fileName, bytes, modifiedMs };
}

describe('play-state detection', () => {
  test('an untouched assignment reads as unplayed', () => {
    const { tournament, manifest } = project();
    const entry = manifest.assignments[0];
    const game = { roundNumber: entry.roundNumber, slotId: entry.slotId };
    void game;
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const round = compat.compat.roundsByNumber.get(entry.roundNumber)!;
    const teams = new Map(tournament.teams.map((team) => [team.id, team]));
    const built = buildAssignment({
      tournament,
      roundId: round.id,
      roundQbjName: round.qbjName,
      roundNumber: entry.roundNumber,
      phaseId: round.phaseId,
      phaseName: round.phaseName,
      slotId: entry.slotId,
      roomName: '319',
      left: teams.get(entry.leftTeamId)!,
      right: teams.get(entry.rightTeamId)!,
    });
    if (!built.ok) throw new Error(built.error);
    const match = (built.assignment.document.objects as Record<string, unknown>[]).find(
      (entry) => entry.type === 'Match',
    )!;
    expect(playStateOf(match).state).toBe('unplayed');
    expect(assignmentFileContents(built.assignment)).toContain(entry.matchId);
  });

  test('a finished export reads as a complete result with a score line', () => {
    const tournament = loadedSynthetic();
    const scored = scorePrelimGame(tournament, 1, 'slot-gold-1');
    const parsed = parseResultFile(outFile('319', 'result.qbj', scored.resultText));
    if (!parsed.ok) throw new Error('should parse');
    expect(parsed.result.fileState).toBe('complete');
    expect(parsed.result.matchId).toBe(scored.matchId);
    expect(parsed.result.scoreLine).toMatch(/ – /);
    expect(parsed.result.candidateId).toContain('319/result.qbj#');
  });

  test('a mid-game copy is parsed but never a result', () => {
    const tournament = loadedSynthetic();
    const partial = scorePartialGame(tournament, 1, 'slot-gold-1');
    const parsed = parseResultFile(outFile('319', 'game.partial.qbj', partial.resultText));
    if (!parsed.ok) throw new Error('should parse');
    expect(parsed.result.fileState).toBe('partial');
    // Scoring content is present — the marker alone keeps it out of the batch.
    expect(parsed.result.playState).not.toBe('unplayed');
  });

  test('an unmarked file with scoring content is treated as not-ready, never finished', () => {
    const tournament = loadedSynthetic();
    const scored = scorePrelimGame(tournament, 1, 'slot-gold-1');
    const rewritten = JSON.parse(scored.resultText) as { objects: Record<string, unknown>[] };
    for (const object of rewritten.objects) {
      if (object.type === 'Match' && typeof object._qbtcp === 'object' && object._qbtcp !== null) {
        delete (object._qbtcp as Record<string, unknown>).file_state;
      }
    }
    const parsed = parseResultFile(outFile('319', 'old-build.qbj', JSON.stringify(rewritten)));
    if (!parsed.ok) throw new Error('should parse');
    expect(parsed.result.fileState).toBe('unknown');
  });
});

describe('reconciliation', () => {
  test('a full round of six results reconciles with no problems', () => {
    const { manifest } = project();
    const slots = Object.keys(ROOM_NAMES);
    const files = slots.map((slot) => {
      const tournament = loadedSynthetic();
      const scored = scorePrelimGame(tournament, 1, slot);
      return outFile(ROOM_NAMES[slot], `R01 - ${ROOM_NAMES[slot]}.qbj`, scored.resultText);
    });
    const report = reconcileScan(manifest, files);
    expect(report.problems).toEqual([]);
    expect(report.scans).toHaveLength(6);
    for (const scan of report.scans) {
      expect(scan.candidates).toHaveLength(1);
      expect(scan.needsChoice).toBe(false);
      expect(scan.chosen).toBeDefined();
      expect(scan.untouchedCopies).toHaveLength(0);
    }
  });

  test('a result in the wrong OUT folder is identified by Match id with a warning', () => {
    const { manifest } = project();
    const tournament = loadedSynthetic();
    // The 319 game (slot-gold-1), dropped into 321's OUT folder under a misleading name.
    const scored = scorePrelimGame(tournament, 2, 'slot-gold-1');
    const report = reconcileScan(manifest, [outFile('321', 'R02 - 321 - whatever.qbj', scored.resultText)]);
    expect(report.problems).toEqual([]);
    expect(report.scans).toHaveLength(1);
    const [scan] = report.scans;
    expect(scan.assignment.slotId).toBe('slot-gold-1');
    expect(scan.chosen?.matchId).toBe(scored.matchId);
    expect(scan.wrongFolder).toEqual({ foundIn: '321', expectedRoom: '319', roundNumber: 2 });
  });

  test('an untouched assignment in OUT is not treated as a completed result', () => {
    const { tournament, manifest } = project();
    const entry = manifest.assignments.find((a) => a.roundNumber === 3 && a.slotId === 'slot-gold-2')!;
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const round = compat.compat.roundsByNumber.get(3)!;
    const teams = new Map(tournament.teams.map((team) => [team.id, team]));
    const built = buildAssignment({
      tournament,
      roundId: round.id,
      roundQbjName: round.qbjName,
      roundNumber: 3,
      phaseId: round.phaseId,
      phaseName: round.phaseName,
      slotId: entry.slotId,
      roomName: '320',
      left: teams.get(entry.leftTeamId)!,
      right: teams.get(entry.rightTeamId)!,
    });
    if (!built.ok) throw new Error(built.error);
    const report = reconcileScan(manifest, [
      outFile('320', 'R03 - 320.qbj', assignmentFileContents(built.assignment)),
    ]);
    expect(report.problems).toEqual([]);
    expect(report.scans).toHaveLength(1);
    expect(report.scans[0].candidates).toHaveLength(0);
    expect(report.scans[0].untouchedCopies).toHaveLength(1);
    expect(report.scans[0].chosen).toBeUndefined();
  });

  test('duplicate results require an explicit choice and remember it', () => {
    const { manifest } = project();
    const tournament = loadedSynthetic();
    const first = scorePrelimGame(tournament, 1, 'slot-maroon-1');
    const second = scorePrelimGame(tournament, 1, 'slot-maroon-1');
    const files = [
      outFile('315', 'game-a.qbj', first.resultText, 1000),
      outFile('315', 'game-b.qbj', second.resultText, 2000),
    ];
    const undecided = reconcileScan(manifest, files);
    expect(undecided.scans).toHaveLength(1);
    expect(undecided.scans[0].candidates).toHaveLength(2);
    expect(undecided.scans[0].needsChoice).toBe(true);
    expect(undecided.scans[0].chosen).toBeUndefined();

    manifest.selectedResults[first.matchId] = 'game-b.qbj';
    const decided = reconcileScan(manifest, files);
    expect(decided.scans[0].needsChoice).toBe(false);
    expect(decided.scans[0].chosen?.fileName).toBe('game-b.qbj');

    // A choice pointing at a file no longer on disk reopens the decision.
    manifest.selectedResults[first.matchId] = 'gone.qbj';
    const reopened = reconcileScan(manifest, files);
    expect(reopened.scans[0].needsChoice).toBe(true);
  });

  test('a partial copy is shown as not-ready and never batched', () => {
    const { manifest } = project();
    const tournament = loadedSynthetic();
    const partial = scorePartialGame(tournament, 1, 'slot-gold-1');
    const report = reconcileScan(manifest, [outFile('319', 'game.partial.qbj', partial.resultText)]);
    expect(report.problems).toEqual([]);
    expect(report.scans).toHaveLength(1);
    expect(report.scans[0].candidates).toHaveLength(0);
    expect(report.scans[0].partialCopies).toHaveLength(1);
    expect(report.scans[0].chosen).toBeUndefined();
  });

  test('same basename in two OUT folders needs a choice resolved by candidate identity', () => {
    const { manifest } = project();
    const tournament = loadedSynthetic();
    const first = scorePrelimGame(tournament, 1, 'slot-maroon-2');
    const second = scorePrelimGame(tournament, 1, 'slot-maroon-2');
    // Same Match, same basename, different rooms (a misdrop plus a correction).
    const files = [
      outFile('317', 'result.qbj', first.resultText, 1000),
      outFile('318', 'result.qbj', second.resultText, 2000),
    ];
    const undecided = reconcileScan(manifest, files);
    expect(undecided.scans[0].candidates).toHaveLength(2);
    expect(undecided.scans[0].needsChoice).toBe(true);
    const [a, b] = undecided.scans[0].candidates;
    expect(a.candidateId).not.toBe(b.candidateId);

    // A bare basename no longer resolves an ambiguous pair.
    manifest.selectedResults[first.matchId] = 'result.qbj';
    expect(reconcileScan(manifest, files).scans[0].needsChoice).toBe(true);

    manifest.selectedResults[first.matchId] = b.candidateId;
    const decided = reconcileScan(manifest, files);
    expect(decided.scans[0].needsChoice).toBe(false);
    expect(decided.scans[0].chosen?.candidateId).toBe(b.candidateId);
    expect(decided.scans[0].chosen?.folderName).toBe('318');
  });

  test("another tournament's QBJ is rejected with a specific message", () => {
    const { manifest } = project();
    const foreign = loadedSynthetic();
    const scored = scorePrelimGame(
      { ...foreign, id: 'Tournament_Other' } as typeof foreign,
      1,
      'slot-gold-1',
    );
    const report = reconcileScan(manifest, [outFile('319', 'foreign.qbj', scored.resultText)]);
    expect(report.scans).toHaveLength(0);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].problem.kind).toBe('foreign-tournament');
    expect(report.problems[0].problem.message).toMatch(/another tournament/);
  });

  test('a game this project never generated is rejected', () => {
    const { manifest } = project();
    const tournament = loadedSynthetic();
    // A valid envelope with a foreign Match id: same tournament, unknown game.
    const known = scorePrelimGame(tournament, 1, 'slot-gold-1');
    const tampered = JSON.parse(known.resultText) as {
      objects: Record<string, unknown>[];
    };
    for (const object of tampered.objects) {
      if (object.type === 'Match') object.id = 'yfshuttle-match-unknown';
      if (object.type === 'Round' && Array.isArray(object.matches)) {
        object.matches = [{ $ref: 'yfshuttle-match-unknown' }];
      }
    }
    const report = reconcileScan(manifest, [outFile('319', 'stray.qbj', JSON.stringify(tampered))]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].problem.kind).toBe('unknown-game');
  });

  test('a file naming the right game but different teams is refused', () => {
    const { manifest } = project();
    const tournament = loadedSynthetic();
    const known = scorePrelimGame(tournament, 1, 'slot-gold-1');
    const tampered = JSON.parse(known.resultText) as {
      objects: Record<string, unknown>[];
    };
    // Repoint one side at a team that was never scheduled in this game.
    for (const object of tampered.objects) {
      if (object.type !== 'Match' || !Array.isArray(object.match_teams)) continue;
      const sides = object.match_teams as Record<string, unknown>[];
      (sides[0].team as Record<string, unknown>).$ref = 'Team_Seed1';
    }
    const report = reconcileScan(manifest, [outFile('319', 'edited.qbj', JSON.stringify(tampered))]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].problem.kind).toBe('mismatch');
  });

  test('garbage files are reported, not fatal', () => {
    const { manifest } = project();
    const report = reconcileScan(manifest, [
      outFile('319', 'notes.txt', 'not json at all'),
      outFile('319', 'old.qbj', JSON.stringify({ version: '1.0.0', objects: [] })),
    ]);
    expect(report.problems).toHaveLength(2);
    expect(report.scans).toHaveLength(0);
  });
});
