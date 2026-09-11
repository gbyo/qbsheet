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
 *
 * # Two inputs, because there are two sources of truth
 *
 * `rooms` says what exists physically and what the relay is currently holding: ids, names, pairing
 * hashes, publication state, assignment revisions. `pairings` says what the operator wants *this
 * round* to be, and nothing else — see `roundPlans.ts`. Passing the matchups in explicitly rather
 * than reading them off the rooms is the whole point: it is what makes "publish round 1" mean
 * round 1 even while round 5 is the round being edited on screen, and it is why a publish is a
 * snapshot of a plan rather than a read of live UI state.
 */

import { buildAssignment, type PreparedAssignment } from './assignment';
import { pairingCodeHash } from './pairing';
import { relayPublishMirror, type MirrorRoomInput, type RelayConnection } from './relay';
import type { Room, RoomTombstone } from './rooms';
import { isCompletePairing, pairingsByRoom, type PlannedPairing } from './roundPlans';
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

export interface PublicationReviewItem {
  roomId: string;
  roomName: string;
  message: string;
}

/**
 * Turn the exact plan and its read-only pairing warnings into the review shown before publishing.
 *
 * The plan's cleared entries matter as much as advisory warnings: a room omitted from a pairing
 * table is deliberately cleared on the relay, so the operator must see that consequence before
 * choosing the exceptional publish action.
 */
export function publicationReviewItems(
  plan: PublishPlan,
  warnings: readonly { roomId: string; message: string }[],
  rooms: readonly Room[] = [],
  pairings: readonly PlannedPairing[] = [],
  teamName: (teamId: string) => string = (teamId) => teamId,
): PublicationReviewItem[] {
  const items: PublicationReviewItem[] = [];
  const seen = new Set<string>();
  const add = (roomId: string, roomName: string, message: string): void => {
    const key = `${roomId}\u001f${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ roomId, roomName, message });
  };

  const roomNames = new Map(plan.publications.map((entry) => [entry.roomId, entry.roomName]));
  const clearedReasons = new Map(plan.cleared.map((entry) => [entry.roomId, entry.reason]));
  for (const entry of plan.cleared) {
    add(entry.roomId, entry.roomName, `${entry.reason} This room will be cleared.`);
  }

  const roomsByName = new Map<string, Room[]>();
  for (const room of rooms) {
    const normalizedName = room.name.trim().toLocaleLowerCase();
    if (!normalizedName) {
      add(room.id, room.name || room.id, 'This room name is blank; result routing would be ambiguous.');
      continue;
    }
    roomsByName.set(normalizedName, [...(roomsByName.get(normalizedName) ?? []), room]);
  }
  for (const duplicates of roomsByName.values()) {
    if (duplicates.length < 2) continue;
    const detail = `The name “${duplicates[0]?.name ?? ''}” is used by ${duplicates.length} configured rooms (${duplicates.map((room) => room.id).join(', ')}).`;
    for (const room of duplicates) add(room.id, room.name, detail);
  }

  const plannedByRoom = pairingsByRoom(pairings);
  const roomsByTeam = new Map<string, Room[]>();
  for (const room of rooms) {
    const pairing = plannedByRoom.get(room.id);
    if (!isCompletePairing(pairing)) continue;
    for (const teamId of [pairing.leftTeamId, pairing.rightTeamId]) {
      roomsByTeam.set(teamId, [...(roomsByTeam.get(teamId) ?? []), room]);
    }
  }
  for (const [teamId, assignments] of roomsByTeam) {
    const uniqueRooms = [...new Map(assignments.map((room) => [room.id, room])).values()];
    if (uniqueRooms.length < 2) continue;
    const message = `${teamName(teamId)} is assigned in multiple rooms this round: ${uniqueRooms.map((room) => room.name).join(', ')}.`;
    for (const room of uniqueRooms) add(room.id, room.name, message);
  }

  for (const warning of warnings) {
    // The exact plan already explains a same-team pairing as a clear. Do not repeat the lower-level
    // field warning as a second review item for the same room and consequence.
    if (/same team/i.test(warning.message) && /same team/i.test(clearedReasons.get(warning.roomId) ?? '')) {
      continue;
    }
    add(warning.roomId, roomNames.get(warning.roomId) ?? warning.roomId, warning.message);
  }
  return items;
}

function summarize(publications: RoomPublication[]): PublishPlan {
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

function roomSetupPublication(room: { id: string; name: string }): RoomPublication {
  return {
    roomId: room.id,
    roomName: room.name,
    assignment: null,
    clearedReason: 'Room setup only; no assignment is being sent.',
  };
}

export function planRound(
  tournament: BridgeTournament,
  round: BridgeRound,
  rooms: readonly Room[],
  pairings: readonly PlannedPairing[],
  tombstones: readonly RoomTombstone[] = [],
): PublishPlan {
  const teams = new Map(tournament.teams.map((team) => [team.id, team]));
  const plannedByRoom = pairingsByRoom(pairings);
  const publications: RoomPublication[] = [];

  for (const room of rooms) {
    const planned = plannedByRoom.get(room.id);
    const clear = (reason: string): void => {
      publications.push({
        roomId: room.id,
        roomName: room.name,
        assignment: null,
        clearedReason: reason,
      });
    };

    if (!planned?.leftTeamId || !planned.rightTeamId) {
      clear('No matchup chosen for this round.');
      continue;
    }
    if (!isCompletePairing(planned)) {
      clear('Both sides of this room are the same team.');
      continue;
    }
    const left = teams.get(planned.leftTeamId);
    const right = teams.get(planned.rightTeamId);
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

  publications.push(...tombstones.map(roomSetupPublication));
  return summarize(publications);
}

/** Build the explicit pre-round mirror: rooms and pairing hashes, with every assignment cleared. */
export function planRoomSetup(
  rooms: readonly Room[],
  tombstones: readonly RoomTombstone[] = [],
): PublishPlan {
  return summarize([...rooms.map(roomSetupPublication), ...tombstones.map(roomSetupPublication)]);
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
    tombstones?: readonly RoomTombstone[];
  },
): Promise<PublishOutcome> {
  if (input.plan.publications.length === 0) {
    throw new Error('There are no rooms to publish. Add a room first.');
  }
  // A plan with no assignments is valid for the explicit room-setup action. The relay still gets
  // every room and clears any old assignment while keeping its pairing hash and tokens intact.
  const byId = new Map<string, Room | RoomTombstone>(input.rooms.map((room) => [room.id, room]));
  for (const tombstone of input.tombstones ?? []) byId.set(tombstone.id, tombstone);
  const mirrorRooms: MirrorRoomInput[] = [];
  for (const publication of input.plan.publications) {
    const room = byId.get(publication.roomId);
    if (!room) continue;
    mirrorRooms.push({
      roomId: room.id,
      name: room.name,
      pairingCodeHash: await pairingCodeHash(room.pendingPairingCode ?? room.pairingCode),
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
