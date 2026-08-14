/**
 * The two steps between an address and a room capability, in one place.
 *
 * # Why they were extracted
 *
 * There are now three ways into a pairing — an address typed on the homepage, a QR code, and a link
 * somebody tapped — and exactly one of them is allowed to be the real implementation. Reaching a
 * server involves discovery, a capability check, and an identify call in a specific order for
 * specific reasons, and a second copy of that sequence written for the QR path would be a second
 * place for a room to end up talking to a server that cannot run its tournament. So the sequence
 * lives here and `ConnectedSetup` calls it from all three.
 *
 * # Nothing here holds state
 *
 * Two functions and a client. Which screen is showing, which stage it is on, and what is done with a
 * failure remain the caller's, because those are the parts that legitimately differ: a typed address
 * that cannot be reached offers the file workflow, and a launch link that cannot be reached is a
 * projector nobody can see any more.
 *
 * # The code is a parameter and never anything else
 *
 * `exchangePairingCode` takes the short code, spends it, and returns a room capability. It is not
 * stored, not returned, not logged and not attached to the result. See `PairingLaunch`.
 */
import FruityServerClient, {
  IRoomListEntry,
  normalizeBaseUrl,
} from '../integrations/fruity/FruityServerClient';
import { IPairedRoom, newDeviceId } from './ConnectedSession';

/** A tournament-control server that has answered, been checked, and named itself. */
export interface IControlConnection {
  client: FruityServerClient;
  tournamentName: string;
  /** Empty when the server offers no room picker, which is not an error. */
  rooms: IRoomListEntry[];
  /** Set when a listing was offered and failed. The pairing code path still works. */
  roomsError?: string;
}

export type ControlOpenResult =
  | { ok: true; value: IControlConnection }
  | {
      ok: false;
      error: string;
      /**
       * Whether this is a "nothing is there" failure rather than a refusal.
       *
       * Drives the offer of the file workflow, which needs no server at all. No status is the shape
       * of both "nothing answered" and "this browser refused to go there", and a room can act on
       * either the same way.
       */
      unreachable: boolean;
    };

/**
 * Reach tournament control and find out whether this room can score against it.
 *
 * Discovery happens on the first call and settles which protocol surface everything after this uses;
 * nothing above this line ever learns which one that was. The capability check is deliberately here
 * rather than at kickoff, because a server that cannot do the job should be found out at the address
 * box, and naming what is missing is the difference between a director who can go and fix their
 * server and one who cannot.
 */
export async function openControl(address: string): Promise<ControlOpenResult> {
  const normalized = normalizeBaseUrl(address);
  if (!normalized.ok) return { ok: false, error: normalized.error, unreachable: false };

  const client = new FruityServerClient(normalized.value);
  const verified = await client.verify();
  if (!verified.ok) {
    return {
      ok: false,
      unreachable: verified.status === undefined,
      error:
        verified.status === undefined
          ? 'Tournament control could not be reached from this browser.'
          : verified.error,
    };
  }

  const missing = client.missingCapabilities();
  if (missing.length > 0) {
    return {
      ok: false,
      unreachable: true,
      error: `Tournament control at this address does not offer ${missing.join(', ')}. This room cannot score against it. A game file works with no server at all.`,
    };
  }

  const identified = await client.identify();
  const rooms = await client.listRooms();
  if (!identified.ok) return { ok: false, error: identified.error, unreachable: false };

  return {
    ok: true,
    value: {
      client,
      tournamentName: identified.value.name,
      rooms: rooms.ok ? rooms.value : [],
      ...(rooms.ok
        ? {}
        : {
            roomsError: `Room list could not be loaded (${rooms.error}). You can still enter a pairing code manually.`,
          }),
    },
  };
}

export type PairingExchangeResult =
  | { ok: true; value: IPairedRoom }
  | { ok: false; error: string };

/**
 * Spend the short code and keep what it bought.
 *
 * `existingDeviceId` is passed when this browser already had one, so a re-pair keeps the identity
 * tournament control has been arbitrating writer ownership with. The room id and the room name come
 * back from the server and are never taken from the caller: the server is authoritative about which
 * room a code actually opened, and a launch link's `room` is a request rather than an answer.
 */
export async function exchangePairingCode(
  client: FruityServerClient,
  code: string,
  roomId: string | undefined,
  existingDeviceId?: string,
): Promise<PairingExchangeResult> {
  const trimmed = code.trim();
  if (trimmed === '') return { ok: false, error: 'Enter the pairing code for this room.' };

  const joined = await client.join(trimmed, roomId === undefined || roomId === '' ? undefined : roomId);
  if (!joined.ok) return { ok: false, error: joined.error };

  return {
    ok: true,
    value: {
      baseUrl: client.baseUrl,
      roomId: joined.value.roomId,
      roomName: joined.value.roomName,
      roomToken: joined.value.accessToken,
      deviceId: existingDeviceId ?? newDeviceId(),
    },
  };
}
