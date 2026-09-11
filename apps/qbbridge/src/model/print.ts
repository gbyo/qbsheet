/**
 * The data a printable room sheet is allowed to contain.
 *
 * `Room.pairingCode` is the active code in QBBridge's room model. A future pending replacement must
 * stay out of this input until the relay has accepted it; a sheet is a physical copy of the code
 * that is usable now, not a preview of the next one.
 */

import type { PairingLink } from './pairing';
import type { Room } from './rooms';

export interface RoomPrintData {
  roomId: string;
  roomName: string;
  tournamentName: string;
  pairingCode: string;
  /** The full canonical launch URL encoded by the QR. */
  pairingUrl: string;
  /** The tournament-scoped address used by the manual Scorer flow. */
  tournamentControlUrl: string;
}

/**
 * Project one active room pairing into the small, deliberately secret-free print model.
 *
 * The management credential is not accepted as an argument, so it cannot accidentally be copied
 * into a printed sheet while this model is extended.
 */
export function buildRoomPrintData(input: {
  tournamentName: string;
  room: Pick<Room, 'id' | 'name' | 'pairingCode'>;
  pairing: PairingLink;
}): RoomPrintData {
  return {
    roomId: input.room.id,
    roomName: input.room.name,
    tournamentName: input.tournamentName,
    pairingCode: input.room.pairingCode,
    pairingUrl: input.pairing.url,
    tournamentControlUrl: input.pairing.server,
  };
}
