/**
 * A room, as QBBridge needs to know it.
 *
 * Deliberately thin, and deliberately about one thing: a physical room in a building, its pairing
 * identity, and what the relay is currently holding for it. There is no schedule here, no pool,
 * and no notion of what a room is *supposed* to play.
 *
 * In particular there is **no matchup**. A room used to carry `leftTeamId`/`rightTeamId`, which
 * made it simultaneously a physical room, the relay's current state, and the editable matchup for
 * whichever round was selected — three things that change for unrelated reasons. The operator's
 * intent now lives in `roundPlans.ts`, one plan per round, and that separation is what lets a whole
 * set of prelims be entered before the tournament and survive switching rounds.
 */

import type { PlannedPairing } from './roundPlans';
import { isCompletePairing, pairingsByRoom } from './roundPlans';

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
  /** True once a successful mirror has listed this room on the configured relay. */
  relayPublished: boolean;
  /** The match id of the assignment last published for this room, if any. */
  publishedMatchId: string | null;
  /** The round last published for this room. */
  publishedRoundId: string | null;
  /**
   * What the relay accepted, as a comparable identity over the exact assignment payload.
   *
   * Game identity (`publishedMatchId`) says *which* game a result belongs to; this says whether
   * the relay is serving the assignment QBBridge would build now. Null when the room holds no
   * assignment, and for publications that predate the fingerprint. See `assignment.ts`.
   */
  publishedAssignmentFingerprint: string | null;
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
    relayPublished: false,
    publishedMatchId: null,
    publishedRoundId: null,
    publishedAssignmentFingerprint: null,
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
    publishedAssignmentFingerprint: null,
    assignmentRevision: 0,
  };
}

/**
 * Cheap warnings about the selected round's plan.
 *
 * Three things a person mistypes, and nothing else. This is not a schedule-legality engine: a
 * rematch, an odd bracket, a carryover — those are the operator's call and YellowFruit's to
 * validate at import. A warning never blocks a publish.
 *
 * The matchups come in as the selected round's pairings rather than being read off the rooms, so
 * the warnings describe the round on screen. Entering round 5 never produces warnings about the
 * round 1 that happens to be live on the relay.
 */
export function pairingWarnings(
  rooms: readonly Room[],
  pairings: readonly PlannedPairing[],
  teamName: (id: string) => string,
): PairingWarning[] {
  const warnings: PairingWarning[] = [];
  const seenNames = new Map<string, string>();
  const seenTeams = new Map<string, string>();
  const byRoom = pairingsByRoom(pairings);
  for (const room of rooms) {
    const key = room.name.trim().toLocaleLowerCase();
    if (key && seenNames.has(key)) {
      warnings.push({ roomId: room.id, message: `Another room is also called \u201c${room.name}\u201d.` });
    } else if (key) {
      seenNames.set(key, room.id);
    }

    const pairing = byRoom.get(room.id);
    if (!pairing?.leftTeamId || !pairing.rightTeamId) {
      warnings.push({ roomId: room.id, message: 'This room has no matchup yet.' });
      continue;
    }
    if (pairing.leftTeamId === pairing.rightTeamId) {
      warnings.push({ roomId: room.id, message: 'Both sides are the same team.' });
      continue;
    }
    for (const teamId of [pairing.leftTeamId, pairing.rightTeamId]) {
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

/** Rooms with a complete matchup in this round's plan. Only these get an assignment. */
export function publishableRooms(rooms: readonly Room[], pairings: readonly PlannedPairing[]): Room[] {
  const byRoom = pairingsByRoom(pairings);
  return rooms.filter((room) => isCompletePairing(byRoom.get(room.id)));
}
