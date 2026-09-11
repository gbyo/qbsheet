/**
 * Proactive emergency assignment packs: the next N rounds on a USB stick, before anything breaks.
 *
 * The relay-outage fallback already exports one round's assignments *after* a failure. That is
 * the wrong moment to discover the round was never fully planned: this pack covers the next N
 * rounds, prepared ahead of the event to a chosen folder, each game as the same ordinary
 * one-game QBJ a scorer would have received from the relay.
 *
 * # Same builder, same match ids — by construction, not by review
 *
 * The pack is built with `planRound`, the exact function ordinary publication uses, so pack
 * match ids equal live publication match ids for the same plan. A test pins that equality:
 * rebuilding the builder's output by hand would be a second answer to the same question, and
 * the copy is the one that drifts.
 *
 * # A pack is a separate delivery path, and it says so
 *
 * Every pack carries a manifest (source fingerprint, generation time, every file with its
 * match id) and a README that states the authority rule: handing a pack file to a scorer
 * while the relay also serves that room creates two active writers. Exporting a pack whose
 * rooms are currently live on the relay additionally raises authority warnings the UI must
 * show before writing anything — the export itself is allowed (packs are made while things
 * work), but never quiet about the conflict.
 */

import { assignmentFileContents, assignmentFileName } from './assignment';
import { planRound } from './publish';
import type { Room } from './rooms';
import type { RoundPlan } from './roundPlans';
import type { BridgeRound, BridgeTournament } from './tournament';

/** One file in the pack. Assignment files are exclusive-create; manifest/README overwrite. */
export interface PackFile {
  fileName: string;
  contents: string;
  kind: 'assignment' | 'manifest' | 'readme';
  overwrite: boolean;
  roundId?: string;
  roomId?: string;
  matchId?: string;
}

export interface PackManifest {
  format: 'qbbridge-emergency-pack';
  formatVersion: 1;
  generatedAt: string;
  yftFingerprint: string | null;
  tournamentName: string;
  rounds: {
    roundId: string;
    roundName: string;
    files: { fileName: string; roomId: string; matchId: string }[];
  }[];
  skippedRoundIds: string[];
  totalAssignmentFiles: number;
}

export interface EmergencyPack {
  files: PackFile[];
  manifest: PackManifest;
  readme: string;
}

export type BuildPackResult = { ok: true; pack: EmergencyPack } | { ok: false; errors: string[] };

function readmeText(input: {
  tournamentName: string;
  generatedAt: string;
  yftFingerprint: string | null;
  totalFiles: number;
}): string {
  return [
    `QBSheet Bridge emergency assignment pack — ${input.tournamentName}`,
    `Generated ${input.generatedAt} from YellowFruit fingerprint ${input.yftFingerprint ?? 'unknown'}.`,
    '',
    `This folder holds ${input.totalFiles} unplayed one-game QBJ assignment(s), one file per game,`,
    'plus PACK-MANIFEST.json listing every file with its match id. Each file opens directly in',
    'QBSheet Scorer by local handoff or USB, exactly like a relay assignment.',
    '',
    'AUTHORITY WARNING: these files are a SEPARATE delivery path from the relay. If the relay',
    'is also serving a game for the same room, handing out the pack file creates TWO ACTIVE',
    'WRITERS for one game and their results will collide. Use a pack file only when the relay',
    'cannot serve that room — relay unreachable, or the room was deliberately cleared — and never',
    'publish the same round to the relay after a scorer has opened one of these files without',
    'confirming no scorer opened the relay game first.',
    '',
    'Do not edit these files by hand. A renamed or edited file no longer matches its manifest',
    'entry and must be treated as suspect.',
    '',
  ].join('\n');
}

/**
 * Build the next N rounds' assignments, starting at `startRoundId` in round order.
 *
 * Rounds with no complete pairings are skipped and listed in the manifest — an empty round is
 * not a pack error, but silently omitting it would be. Zero assignments across all N rounds is
 * an error: a pack with no games protects nothing.
 */
export function buildEmergencyPack(input: {
  tournament: BridgeTournament;
  rounds: readonly BridgeRound[];
  startRoundId: string | null;
  roundCount: number;
  rooms: readonly Room[];
  plans: readonly RoundPlan[];
  generatedAt: string;
  yftFingerprint: string | null;
}): BuildPackResult {
  const startIndex =
    input.startRoundId === null
      ? 0
      : Math.max(
          0,
          input.rounds.findIndex((round) => round.id === input.startRoundId),
        );
  const selected = input.rounds.slice(startIndex, startIndex + Math.max(1, input.roundCount));
  if (selected.length === 0) {
    return { ok: false, errors: ['There are no rounds to pack. Load a YellowFruit file first.'] };
  }

  const errors: string[] = [];
  const files: PackFile[] = [];
  const manifestRounds: PackManifest['rounds'] = [];
  const skippedRoundIds: string[] = [];

  for (const round of selected) {
    const pairings = input.plans.find((plan) => plan.roundId === round.id)?.pairings ?? [];
    const plan = planRound(input.tournament, round, input.rooms, pairings, []);
    if (plan.assignments.length === 0) {
      skippedRoundIds.push(round.id);
      continue;
    }
    const roundFiles: PackManifest['rounds'][number]['files'] = [];
    const seenNames = new Set<string>();
    for (const assignment of plan.assignments) {
      const fileName = assignmentFileName(assignment);
      if (seenNames.has(fileName)) {
        errors.push(
          `Round ${round.displayName} produced the same file name twice (${fileName}). The pack is not written.`,
        );
        continue;
      }
      seenNames.add(fileName);
      files.push({
        fileName,
        contents: assignmentFileContents(assignment),
        kind: 'assignment',
        overwrite: false,
        roundId: round.id,
        roomId: assignment.roomId,
        matchId: assignment.matchId,
      });
      roundFiles.push({ fileName, roomId: assignment.roomId, matchId: assignment.matchId });
    }
    manifestRounds.push({ roundId: round.id, roundName: round.displayName, files: roundFiles });
  }

  if (errors.length > 0) return { ok: false, errors };
  if (files.length === 0) {
    return {
      ok: false,
      errors: [
        'None of the selected rounds has a complete pairing. Enter the matchups first — a pack with no games protects nothing.',
      ],
    };
  }

  const manifest: PackManifest = {
    format: 'qbbridge-emergency-pack',
    formatVersion: 1,
    generatedAt: input.generatedAt,
    yftFingerprint: input.yftFingerprint,
    tournamentName: input.tournament.name,
    rounds: manifestRounds,
    skippedRoundIds,
    totalAssignmentFiles: files.length,
  };
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  const readme = readmeText({
    tournamentName: input.tournament.name,
    generatedAt: input.generatedAt,
    yftFingerprint: input.yftFingerprint,
    totalFiles: files.length,
  });
  return {
    ok: true,
    pack: {
      files: [
        ...files,
        { fileName: 'PACK-MANIFEST.json', contents: manifestContents, kind: 'manifest', overwrite: true },
        { fileName: 'PACK-README.txt', contents: readme, kind: 'readme', overwrite: true },
      ],
      manifest,
      readme,
    },
  };
}

/**
 * Authority conflicts between a built pack and what the relay is currently serving.
 *
 * One warning per conflicting room: the relay holds a game for a room the pack also covers.
 * Whether the match ids agree or not, handing out the file risks two active writers — an
 * agreeing id still diverges the moment either side republishes. Rooms the relay holds nothing
 * for are safe and stay quiet.
 */
export function packAuthorityWarnings(input: {
  pack: EmergencyPack;
  rooms: readonly Pick<Room, 'id' | 'name' | 'publishedMatchId' | 'publishedRoundId'>[];
  roundName: (roundId: string) => string;
}): string[] {
  const liveByRoom = new Map(
    input.rooms.filter((room) => room.publishedMatchId !== null).map((room) => [room.id, room] as const),
  );
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const file of input.pack.files) {
    if (file.kind !== 'assignment' || !file.roomId || !file.roundId || seen.has(file.roomId)) continue;
    seen.add(file.roomId);
    const live = liveByRoom.get(file.roomId);
    if (!live) continue;
    const sameGame = live.publishedMatchId === file.matchId && live.publishedRoundId === file.roundId;
    warnings.push(
      `Room “${live.name}” is live on the relay${sameGame ? ' with this same game' : ''} ` +
        `(round ${input.roundName(live.publishedRoundId ?? file.roundId)}). ` +
        `Handing out its pack file creates two active writers — continue only if no scorer will open the relay game.`,
    );
  }
  return warnings;
}
