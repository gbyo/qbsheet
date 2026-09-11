/**
 * Turning the pairing table into one relay publication.
 *
 * Two steps, both small: build one assignment per room that has a matchup, then hand the set to
 * `PUT manage/mirror` as one call. There is no queue, no partial retry and no reconciliation. A
 * publish either reached the relay or it did not, and the operator is told which.
 */

import { buildAssignment, type PreparedAssignment } from './assignment';
import { pairingCodeHash } from './pairing';
import { relayPublishMirror, type MirrorRoomInput, type RelayConnection } from './relay';
import { publishableRooms, type Room } from './rooms';
import type { BridgeRound, BridgeTournament } from './tournament';

export interface PublishPlan {
  assignments: PreparedAssignment[];
  /** Rooms that could not be built, and why. A publish proceeds for the rest. */
  skipped: { roomId: string; roomName: string; reason: string }[];
}

export function planRound(
  tournament: BridgeTournament,
  round: BridgeRound,
  rooms: readonly Room[],
): PublishPlan {
  const teams = new Map(tournament.teams.map((team) => [team.id, team]));
  const assignments: PreparedAssignment[] = [];
  const skipped: PublishPlan['skipped'] = [];
  for (const room of publishableRooms(rooms)) {
    const left = teams.get(room.leftTeamId ?? '');
    const right = teams.get(room.rightTeamId ?? '');
    if (!left || !right) {
      skipped.push({
        roomId: room.id,
        roomName: room.name,
        reason: 'A team in this room is not in the loaded YellowFruit file. Reload the file.',
      });
      continue;
    }
    const built = buildAssignment({
      tournament,
      round,
      roomId: room.id,
      roomName: room.name,
      left,
      right,
      // Same pairing, next issue. The match identity does not move with it.
      assignmentRevision: room.assignmentRevision + 1,
    });
    if (!built.ok) {
      skipped.push({ roomId: room.id, roomName: room.name, reason: built.error });
      continue;
    }
    assignments.push(built.assignment);
  }
  return { assignments, skipped };
}

export interface PublishOutcome {
  /** The mirror revision the relay accepted. Persist it; the next publish is this plus one. */
  revision: number;
  assignments: PreparedAssignment[];
}

/**
 * Publish a planned round.
 *
 * Every room in the plan restates its pairing hash, because the relay replaces a listed room's
 * columns wholesale and a room republished without one would stop accepting the code on its QR.
 */
export async function publishRound(
  connection: RelayConnection,
  input: {
    epoch: number;
    lastRevision: number;
    tournamentName: string;
    plan: PublishPlan;
    rooms: readonly Room[];
  },
): Promise<PublishOutcome> {
  if (input.plan.assignments.length === 0) {
    throw new Error('No room in this round has two teams chosen.');
  }
  const byId = new Map(input.rooms.map((room) => [room.id, room]));
  const mirrorRooms: MirrorRoomInput[] = [];
  for (const assignment of input.plan.assignments) {
    const room = byId.get(assignment.roomId);
    if (!room) continue;
    mirrorRooms.push({
      roomId: room.id,
      name: room.name,
      pairingCodeHash: await pairingCodeHash(room.pairingCode),
      assignmentQbj: assignment.document,
      matchId: assignment.matchId,
      assignmentRevision: assignment.assignmentRevision,
    });
  }
  const revision = input.lastRevision + 1;
  await relayPublishMirror(connection, {
    directorEpoch: input.epoch,
    revision,
    tournamentName: input.tournamentName,
    rooms: mirrorRooms,
  });
  return { revision, assignments: input.plan.assignments };
}
