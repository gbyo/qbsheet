/**
 * A room, as QBBridge needs to know it.
 *
 * Deliberately thin: an id, a name, a pairing code, whichever two teams the operator picked for
 * the current round, and what the last publish did. There is no schedule here, no pool, and no
 * notion of what a room is *supposed* to play. The operator knows that, or YellowFruit does.
 */

export type RoomStatus =
  /** Configured locally; this room has not reached the current relay. */
  | 'not-published'
  /** The room and its pairing identity are on the relay, without an active assignment. */
  | 'ready-to-pair'
  /** An assignment is on the relay and QBBridge is waiting for its result. */
  | 'waiting'
  /** A completed result for this room's published match has arrived. */
  | 'result-received';

export interface Room {
  id: string;
  name: string;
  /** The code currently active locally. Only its SHA-256 hash is ever published. */
  pairingCode: string;
  /** A replacement code is not active until a successful mirror publishes its hash. */
  pendingPairingCode: string | null;
  leftTeamId: string | null;
  rightTeamId: string | null;
  /** True once a successful mirror has listed this room on the configured relay. */
  relayPublished: boolean;
  /** The match id of the assignment last published for this room, if any. */
  publishedMatchId: string | null;
  /** The round last published for this room. */
  publishedRoundId: string | null;
  /** Per-room issue number. Advances on every successful publish; the match id does not. */
  assignmentRevision: number;
}

/** The minimum room state needed to clear a room after it has been removed locally. */
export interface RoomTombstone {
  id: string;
  name: string;
  pairingCode: string;
  /** Always null: a pending code was never active on the relay and must not revoke old tokens. */
  pendingPairingCode: null;
  assignmentRevision: number;
}

export interface PairingWarning {
  roomId: string;
  message: string;
}

export function newRoom(id: string, name: string, pairingCode: string): Room {
  return {
    id,
    name,
    pairingCode,
    pendingPairingCode: null,
    leftTeamId: null,
    rightTeamId: null,
    relayPublished: false,
    publishedMatchId: null,
    publishedRoundId: null,
    assignmentRevision: 0,
  };
}

/** Snapshot only the active relay identity of a removed room. */
export function roomTombstone(room: Room): RoomTombstone {
  return {
    id: room.id,
    name: room.name,
    pairingCode: room.pairingCode,
    pendingPairingCode: null,
    assignmentRevision: room.assignmentRevision,
  };
}

/** Keep local room setup while removing facts that belonged to a previous relay. */
export function resetRelayPublication(room: Room): Room {
  return {
    ...room,
    relayPublished: false,
    publishedMatchId: null,
    publishedRoundId: null,
    assignmentRevision: 0,
  };
}

/**
 * Cheap warnings about the current pairing table.
 *
 * Three things a person mistypes, and nothing else. This is not a schedule-legality engine: a
 * rematch, an odd bracket, a carryover — those are the operator's call and YellowFruit's to
 * validate at import. A warning never blocks a publish.
 */
export function pairingWarnings(rooms: readonly Room[], teamName: (id: string) => string): PairingWarning[] {
  const warnings: PairingWarning[] = [];
  const seenNames = new Map<string, string>();
  const seenTeams = new Map<string, string>();
  for (const room of rooms) {
    const key = room.name.trim().toLocaleLowerCase();
    if (key && seenNames.has(key)) {
      warnings.push({ roomId: room.id, message: `Another room is also called “${room.name}”.` });
    } else if (key) {
      seenNames.set(key, room.id);
    }

    if (!room.leftTeamId || !room.rightTeamId) {
      warnings.push({ roomId: room.id, message: 'This room has no matchup yet.' });
      continue;
    }
    if (room.leftTeamId === room.rightTeamId) {
      warnings.push({ roomId: room.id, message: 'Both sides are the same team.' });
      continue;
    }
    for (const teamId of [room.leftTeamId, room.rightTeamId]) {
      const elsewhere = seenTeams.get(teamId);
      if (elsewhere !== undefined && elsewhere !== room.id) {
        warnings.push({
          roomId: room.id,
          message: `${teamName(teamId)} is also in another room this round.`,
        });
      } else {
        seenTeams.set(teamId, room.id);
      }
    }
  }
  return warnings;
}

/** Rooms with two different teams chosen. Only these get an assignment. */
export function publishableRooms(rooms: readonly Room[]): Room[] {
  return rooms.filter((room) => room.leftTeamId && room.rightTeamId && room.leftTeamId !== room.rightTeamId);
}
