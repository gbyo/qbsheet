/**
 * Turning the pairing table into one relay publication.
 *
 * Two steps, both small: decide what every configured room should be holding this round, then
 * send the whole set as one `PUT manage/mirror`. There is no queue, no partial retry and no
 * reconciliation. A publish either reached the relay or it did not, and the operator is told
 * which.
 *
 * # Every room, every time
 *
 * The plan covers each configured room, not only the ones playing. A room with no matchup this
 * round is published with its assignment cleared rather than omitted, because the relay upserts
 * and never deletes: a room left out of the payload keeps whatever it was last given. Omitting an
 * unused room would leave a scorekeeper in Room 103 able to open last round's game — a real,
 * correctly formatted assignment for a match nobody is playing, with no signal that it is stale.
 */

import { buildAssignment, type PreparedAssignment } from './assignment';
import { pairingCodeHash } from './pairing';
import { relayPublishMirror, type MirrorRoomInput, type RelayConnection } from './relay';
import type { Room } from './rooms';
import type { BridgeRound, BridgeTournament } from './tournament';

/** What one room should be holding after this publish. */
export interface RoomPublication {
  roomId: string;
  roomName: string;
  /** The game this room is being given, or null when it is being cleared. */
  assignment: PreparedAssignment | null;
  /** Why the room has no game this round. Always set when `assignment` is null. */
  clearedReason: string | null;
}

export interface PublishPlan {
  publications: RoomPublication[];
  /** The rooms that are getting a game. */
  assignments: PreparedAssignment[];
  /** The rooms whose assignment is being cleared, and why. Shown to the operator, never silent. */
  cleared: { roomId: string; roomName: string; reason: string }[];
}

export function planRound(
  tournament: BridgeTournament,
  round: BridgeRound,
  rooms: readonly Room[],
): PublishPlan {
  const teams = new Map(tournament.teams.map((team) => [team.id, team]));
  const publications: RoomPublication[] = [];

  for (const room of rooms) {
    const clear = (reason: string): void => {
      publications.push({
        roomId: room.id,
        roomName: room.name,
        assignment: null,
        clearedReason: reason,
      });
    };

    if (!room.leftTeamId || !room.rightTeamId) {
      clear('No matchup chosen for this round.');
      continue;
    }
    if (room.leftTeamId === room.rightTeamId) {
      clear('Both sides of this room are the same team.');
      continue;
    }
    const left = teams.get(room.leftTeamId);
    const right = teams.get(room.rightTeamId);
    if (!left || !right) {
      // A team that vanished when the `.yft` was reloaded. Clearing rather than skipping is the
      // point: skipping would leave the room serving whatever it held before.
      clear('A team in this room is not in the loaded YellowFruit file. Reload the file.');
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
      clear(built.error);
      continue;
    }
    publications.push({
      roomId: room.id,
      roomName: room.name,
      assignment: built.assignment,
      clearedReason: null,
    });
  }

  return {
    publications,
    assignments: publications
      .map((entry) => entry.assignment)
      .filter((entry): entry is PreparedAssignment => entry !== null),
    cleared: publications
      .filter((entry) => entry.assignment === null)
      .map((entry) => ({
        roomId: entry.roomId,
        roomName: entry.roomName,
        reason: entry.clearedReason ?? 'No game this round.',
      })),
  };
}

export interface PublishOutcome {
  /** The mirror revision the relay accepted. Persist it; the next publish is this plus one. */
  revision: number;
  assignments: PreparedAssignment[];
  /** The rooms whose assignment the relay just cleared. */
  clearedRoomIds: string[];
}

/**
 * Publish a planned round.
 *
 * Every room in the plan restates its pairing hash, whether or not it is getting a game: the
 * relay replaces a listed room's columns wholesale, so a room republished without one would stop
 * accepting the code on its QR. A cleared room keeps its id, its name and that hash, and loses
 * only its assignment and match id.
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
  if (input.plan.publications.length === 0) {
    throw new Error('There are no rooms to publish. Add a room first.');
  }
  if (input.plan.assignments.length === 0) {
    throw new Error('No room in this round has two teams chosen.');
  }
  const byId = new Map(input.rooms.map((room) => [room.id, room]));
  const mirrorRooms: MirrorRoomInput[] = [];
  for (const publication of input.plan.publications) {
    const room = byId.get(publication.roomId);
    if (!room) continue;
    mirrorRooms.push({
      roomId: room.id,
      name: room.name,
      pairingCodeHash: await pairingCodeHash(room.pairingCode),
      assignmentQbj: publication.assignment?.document ?? null,
      matchId: publication.assignment?.matchId ?? null,
      // A cleared room's issue number still advances, so a scorer holding the old assignment can
      // tell that what it has was superseded rather than merely unchanged.
      assignmentRevision: publication.assignment?.assignmentRevision ?? room.assignmentRevision + 1,
    });
  }
  const revision = input.lastRevision + 1;
  await relayPublishMirror(connection, {
    directorEpoch: input.epoch,
    revision,
    tournamentName: input.tournamentName,
    rooms: mirrorRooms,
  });
  return {
    revision,
    assignments: input.plan.assignments,
    clearedRoomIds: input.plan.cleared.map((entry) => entry.roomId),
  };
}
