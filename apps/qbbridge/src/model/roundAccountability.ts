/**
 * Explicit round accountability: every relevant team, one disposition per round.
 *
 * QBBridge deliberately never infers how many games a round should hold, which avoids false
 * completeness claims but also lets an unassigned team, a mistyped prelim, or a missing game
 * sail through to Publish Round unnoticed. This module is the other half of that bargain: the
 * operator states intent explicitly — each team is assigned to exactly one game, on a bye, or
 * intentionally inactive — and the round can then prove its accounting before anything reaches
 * the relay.
 *
 * # What is derived, and what is stated
 *
 * Assignment is derived from the round's pairings in `roundPlans.ts` and is never stored here.
 * Only the two non-playing dispositions are stated: `bye` (the format leaves this team out this
 * round) and `inactive` (the team is not playing this round at all, e.g. a withdrawn team still
 * in the file). A team with neither is expected to appear in exactly one complete pairing; a
 * team that appears nowhere is `unaccounted`, never an implied bye.
 *
 * # By id, like everything else
 *
 * Dispositions reference teams and rounds by stable id. Reconciliation against a reloaded `.yft`
 * drops references to ids that are gone and reports the counts, exactly like `reconcilePlans` —
 * a repair by team name would be a guess, and a wrong guess benches the wrong team.
 */

import type { PlannedPairing } from './roundPlans';

/** The two ways a team can explicitly sit out a round. */
export type TeamDispositionKind = 'bye' | 'inactive';

/** One round's stated non-playing teams. Sparse: a round with no byes has no entry. */
export interface RoundDisposition {
  roundId: string;
  byes: string[];
  inactive: string[];
}

/** One team's stated disposition in one round, or null when the team is expected to play. */
export function dispositionFor(
  dispositions: readonly RoundDisposition[],
  roundId: string | null,
  teamId: string,
): TeamDispositionKind | null {
  if (roundId === null) return null;
  const entry = dispositions.find((item) => item.roundId === roundId);
  if (!entry) return null;
  if (entry.byes.includes(teamId)) return 'bye';
  if (entry.inactive.includes(teamId)) return 'inactive';
  return null;
}

function withoutEmptyDisposition(entry: RoundDisposition): RoundDisposition | null {
  return entry.byes.length === 0 && entry.inactive.length === 0 ? null : entry;
}

/**
 * State (or clear) one team's disposition in one round.
 *
 * Setting a kind removes the other kind for the same team: a team cannot be both on a bye and
 * inactive, and the setter refuses to record the contradiction rather than detecting it later.
 * Clearing the last entry drops the round, so "is anything stated here" stays about existence.
 */
export function setTeamDisposition(
  dispositions: readonly RoundDisposition[],
  roundId: string,
  teamId: string,
  kind: TeamDispositionKind | null,
): RoundDisposition[] {
  const existing = dispositions.find((item) => item.roundId === roundId) ?? {
    roundId,
    byes: [],
    inactive: [],
  };
  const byes = existing.byes.filter((entry) => entry !== teamId);
  const inactive = existing.inactive.filter((entry) => entry !== teamId);
  if (kind === 'bye') byes.push(teamId);
  if (kind === 'inactive') inactive.push(teamId);
  const trimmed = withoutEmptyDisposition({ roundId, byes, inactive });
  const index = dispositions.findIndex((item) => item.roundId === roundId);
  if (index === -1) return trimmed === null ? [...dispositions] : [...dispositions, trimmed];
  const copy = [...dispositions];
  if (trimmed === null) copy.splice(index, 1);
  else copy[index] = trimmed;
  return copy;
}

/** Persisted dispositions are a trust boundary; keep only well-formed id lists. */
export function normalizeRoundDispositions(value: unknown): RoundDisposition[] {
  if (!Array.isArray(value)) return [];
  const next: RoundDisposition[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.roundId !== 'string') continue;
    const byes = Array.isArray(record.byes)
      ? record.byes.filter((teamId): teamId is string => typeof teamId === 'string')
      : [];
    const inactive = Array.isArray(record.inactive)
      ? record.inactive.filter((teamId): teamId is string => typeof teamId === 'string')
      : [];
    // A stored contradiction is corruption, not intent: let neither side claim the team,
    // so the team reads as unaccounted rather than as decided.
    const cleanByes = byes.filter((teamId) => !inactive.includes(teamId));
    const cleanInactive = inactive.filter((teamId) => !byes.includes(teamId));
    if (cleanByes.length === 0 && cleanInactive.length === 0) continue;
    next.push({
      roundId: record.roundId,
      byes: [...new Set(cleanByes)],
      inactive: [...new Set(cleanInactive)],
    });
  }
  return next;
}

/** What reconciling dispositions against a reloaded `.yft` had to drop. */
export interface DispositionReconciliation {
  dispositions: RoundDisposition[];
  /** How many team references were dropped because the team is gone from the file. */
  droppedTeamCount: number;
  /** Round ids dropped because the round is gone from the file. */
  droppedRoundIds: string[];
}

/**
 * Bring stated dispositions back into agreement with the reloaded file.
 *
 * By id, and only by id — see `reconcilePlans`. A dropped disposition fails open toward
 * `unaccounted`, which the publish gate then refuses to ignore.
 */
export function reconcileDispositions(
  dispositions: readonly RoundDisposition[],
  known: { roundIds: ReadonlySet<string>; teamIds: ReadonlySet<string> },
): DispositionReconciliation {
  const next: RoundDisposition[] = [];
  const droppedRoundIds: string[] = [];
  let droppedTeamCount = 0;
  for (const entry of dispositions) {
    if (!known.roundIds.has(entry.roundId)) {
      droppedRoundIds.push(entry.roundId);
      continue;
    }
    const byes = entry.byes.filter((teamId) => {
      if (known.teamIds.has(teamId)) return true;
      droppedTeamCount += 1;
      return false;
    });
    const inactive = entry.inactive.filter((teamId) => {
      if (known.teamIds.has(teamId)) return true;
      droppedTeamCount += 1;
      return false;
    });
    if (byes.length > 0 || inactive.length > 0) next.push({ roundId: entry.roundId, byes, inactive });
  }
  return { dispositions: next, droppedTeamCount, droppedRoundIds };
}

/** One team's assignment footprint in a round. */
export interface AssignedTeam {
  teamId: string;
  roomIds: string[];
}

/** The full accounting of one round: every known team in exactly one bucket. */
export interface RoundAccount {
  /** Teams appearing in at least one pairing side, with every room that names them. */
  assigned: AssignedTeam[];
  /** Teams explicitly on a bye. */
  byes: string[];
  /** Teams explicitly inactive. */
  inactive: string[];
  /** Known teams with no assignment and no stated disposition. Never an implied bye. */
  unaccounted: string[];
  /** Assigned teams named in more than one room. */
  duplicates: AssignedTeam[];
  /** Teams both assigned and stated bye/inactive. */
  contradictions: string[];
  /** Rooms with exactly one side chosen. */
  incomplete: { roomId: string; chosenTeamId: string; side: 'left' | 'right' }[];
  /** Pairing sides naming teams the loaded file no longer has. */
  staleTeamIds: string[];
  /** Pairings in rooms that no longer exist locally. */
  staleRoomIds: string[];
  /** Complete, playable pairings. */
  games: number;
  /** e.g. "12 teams accounted for · 6 games · 0 byes". */
  summary: string;
}

/**
 * Account for every known team in one round.
 *
 * `teamIds` is the authoritative set from the loaded `.yft`; `roomIds` the configured rooms.
 * Unknown ids are reported as stale rather than folded into any bucket, and a stale side never
 * counts its team as assigned — a cleared selection is one dropdown, a phantom game is a round.
 */
export function accountRound(input: {
  pairings: readonly PlannedPairing[];
  dispositions: readonly RoundDisposition[];
  roundId: string | null;
  teamIds: ReadonlySet<string>;
  roomIds: ReadonlySet<string>;
}): RoundAccount {
  const roomsByTeam = new Map<string, string[]>();
  const incomplete: RoundAccount['incomplete'] = [];
  const staleTeams = new Set<string>();
  const staleRooms = new Set<string>();
  let games = 0;

  for (const pairing of input.pairings) {
    if (!input.roomIds.has(pairing.roomId)) {
      staleRooms.add(pairing.roomId);
      continue;
    }
    const left = pairing.leftTeamId;
    const right = pairing.rightTeamId;
    if (left !== null && !input.teamIds.has(left)) staleTeams.add(left);
    if (right !== null && !input.teamIds.has(right)) staleTeams.add(right);
    const knownLeft = left !== null && input.teamIds.has(left) ? left : null;
    const knownRight = right !== null && input.teamIds.has(right) ? right : null;
    if (knownLeft !== null && knownRight !== null) {
      if (knownLeft !== knownRight) {
        games += 1;
        roomsByTeam.set(knownLeft, [...(roomsByTeam.get(knownLeft) ?? []), pairing.roomId]);
        roomsByTeam.set(knownRight, [...(roomsByTeam.get(knownRight) ?? []), pairing.roomId]);
      }
      // A same-team pairing builds nothing; it reads as unaccounted, not assigned.
      continue;
    }
    if (knownLeft !== null || knownRight !== null) {
      const chosen = (knownLeft ?? knownRight) as string;
      incomplete.push({
        roomId: pairing.roomId,
        chosenTeamId: chosen,
        side: knownLeft !== null ? 'left' : 'right',
      });
      roomsByTeam.set(chosen, [...(roomsByTeam.get(chosen) ?? []), pairing.roomId]);
    }
  }

  const entry =
    input.roundId === null ? undefined : input.dispositions.find((item) => item.roundId === input.roundId);
  const byes = (entry?.byes ?? []).filter((teamId) => input.teamIds.has(teamId));
  const inactive = (entry?.inactive ?? []).filter((teamId) => input.teamIds.has(teamId));
  const excused = new Set([...byes, ...inactive]);

  const assigned: AssignedTeam[] = [...roomsByTeam].map(([teamId, roomIds]) => ({ teamId, roomIds }));
  const duplicates = assigned.filter((team) => team.roomIds.length > 1);
  const contradictions = assigned.filter((team) => excused.has(team.teamId)).map((team) => team.teamId);
  const accountedFor = new Set<string>([...roomsByTeam.keys(), ...excused]);
  const unaccounted = [...input.teamIds].filter((teamId) => !accountedFor.has(teamId));

  const accountedCount = input.teamIds.size - unaccounted.length;
  const summary =
    `${accountedCount} team${accountedCount === 1 ? '' : 's'} accounted for` +
    ` · ${games} game${games === 1 ? '' : 's'}` +
    ` · ${byes.length} bye${byes.length === 1 ? '' : 's'}`;

  return {
    assigned,
    byes,
    inactive,
    unaccounted,
    duplicates,
    contradictions,
    incomplete,
    staleTeamIds: [...staleTeams],
    staleRoomIds: [...staleRooms],
    games,
    summary,
  };
}

/** The publish gate: what stops a publish, and what the operator must explicitly review. */
export interface PublishGate {
  /** Publish is refused while any block stands. No override. */
  blocks: string[];
  /** Publish proceeds only through the explicit review dialog. */
  warnings: string[];
}

/**
 * Decide whether a round may publish.
 *
 * Blocks are states where publishing would send a wrong game or contradict stated intent: a
 * team in two rooms, a team both playing and benched, or references to teams/rooms that no
 * longer exist. Warnings are states where the round may be legitimately ragged — a team nobody
 * has placed yet — but the operator must say so on the record. Incomplete pairings are not
 * listed here: `planRound` already publishes those rooms cleared, and the cleared-room review
 * item is their warning.
 */
export function roundPublishGate(
  account: RoundAccount,
  teamName: (teamId: string) => string = (teamId) => teamId,
): PublishGate {
  const blocks: string[] = [];
  const warnings: string[] = [];

  for (const duplicate of account.duplicates) {
    blocks.push(
      `${teamName(duplicate.teamId)} is assigned in ${duplicate.roomIds.length} rooms this round. ` +
        `Remove one assignment before publishing.`,
    );
  }
  for (const teamId of account.contradictions) {
    blocks.push(
      `${teamName(teamId)} is both assigned to a game and marked bye/inactive. ` +
        `Clear one before publishing.`,
    );
  }
  for (const teamId of account.staleTeamIds) {
    blocks.push(
      `This round names a team the loaded YellowFruit file no longer has (${teamId}). ` +
        `Reload the file and re-enter the matchup.`,
    );
  }
  for (const roomId of account.staleRoomIds) {
    blocks.push(
      `This round plans a game in a room that no longer exists (${roomId}). ` +
        `Remove the room or re-enter the matchup.`,
    );
  }
  if (account.unaccounted.length > 0) {
    const names = account.unaccounted.map(teamName);
    const shown = names.slice(0, 5).join(', ');
    const more = names.length > 5 ? `, and ${names.length - 5} more` : '';
    warnings.push(
      `${account.unaccounted.length} team${account.unaccounted.length === 1 ? ' is' : 's are'} ` +
        `neither assigned nor marked bye/inactive: ${shown}${more}. ` +
        `Place every team or publish anyway as an explicit exception.`,
    );
  }
  return { blocks, warnings };
}
