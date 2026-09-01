/**
 * What tournament control says, in two vocabularies, and the one this application speaks.
 *
 * # Why there are two wire vocabularies here
 *
 * A scoresheet has to work against two kinds of server for as long as the migration lasts. A QBTCP
 * server answers `/qbtcp/v1/assignment` with a QBJ document and keeps the operational state in a
 * sibling endpoint; a pre-QBTCP server answers `/api/v1/rooms/:id/assignment` with a JSON shape of
 * its own that mixes the game and the operational state together. Those are genuinely different
 * documents, not different spellings, and pretending otherwise is how a client ends up with a
 * parser that reads neither properly.
 *
 * # And why there is only one normalized vocabulary
 *
 * Everything above the client — the room screen, the connected runtime, the scorer — is given
 * `INormalizedAssignment` and never learns which surface produced it. That is the whole point of
 * the adapter split: the protocol question is answered once, at discovery, and then it stops being
 * a question. A component that had to branch on the wire format would be a component that can be
 * wrong on one of the two servers without anybody noticing until a tournament.
 *
 * # Credentials are types here and nothing else
 *
 * A room token and a session token are strings this file names. They are never rendered, never
 * logged, and never put in a URL; see `FruityServerClient` for the rule and `PortableQbj` for the
 * boundary that keeps them out of anything that leaves the device.
 */
import { IGameDefinition } from '../../game/GameDefinition';
import { IScorekeeperFormat } from '../../scoring/ScorekeeperFormat';
import { IRoomProcedure } from '../../scoring/RoomProcedure';
import { ITeamRoster } from '../../game/Roster';

export const sessionTokenHeader = 'x-yf-session-token';
export const roomTokenHeader = 'x-yf-room-token';
export const deviceIdHeader = 'x-yf-device-id';
export const operatorNameHeader = 'x-yf-operator-name';

/** The media type a QBJ document travels as. Not `application/json`, deliberately. */
export const qbjMediaType = 'application/vnd.quizbowl.qbj+json';

export type ApiResult<T> =
  | { ok: true; value: T }
  /**
   * `error` is always safe to show. `detail` is set only when the server itself explained the
   * refusal, so a caller can show that explanation without ever showing our status-code fallback.
   *
   * `payload` is the parsed error body, for the two refusals that carry structure a client acts on:
   * a writer conflict says whether a takeover is offered, and a rejected result says whether the
   * statistics were already on record.
   *
   * `unsupported` marks a refusal this client made on its own, because discovery did not advertise
   * the capability. It has no status because no request was sent, and it is distinguished from a
   * network failure for exactly that reason: nothing is going to change by trying again.
   */
  | { ok: false; error: string; status?: number; detail?: string; payload?: unknown; unsupported?: boolean };

export interface IRoomIdentity {
  roomId: string;
  token: string;
  deviceId?: string;
  operatorName?: string;
  /**
   * What the room is called, as pairing named it.
   *
   * Descriptive only, and carried here so that the canonical surface — which resolves the room from
   * the token and therefore never repeats its name in a response — can still say "Room 204" on
   * screen without a second endpoint to ask.
   */
  roomName?: string;
}

export interface ISessionCredentials {
  sessionId: string;
  token: string;
}

export interface IServerIdentity {
  tournamentKey?: string;
  name: string;
  scoringFormat: IScorekeeperFormat | null;
  roomProcedure?: IRoomProcedure;
  timedRounds: boolean;
  roundCount: number;
  teamCount: number;
}

export interface IRoomListEntry {
  id: string;
  name: string;
  description?: string;
}

export interface IJoinResult {
  roomId: string;
  roomName: string;
  roomDescription?: string;
  accessToken: string;
}

// --- the legacy `/api/v1` wire shapes ----------------------------------------------------------

export interface IAssignedMatchup {
  scheduledMatchId: string;
  roundNumber: number;
  roundName: string;
  packetName?: string;
  /**
   * Which issue of this round's pairings the assignment came from.
   *
   * Optional on the wire because a server built before game packages existed does not send it. An
   * absent revision is read as 1 — the first issue — which is correct for every tournament that has
   * never rebracketed and is the only assumption available for one that has.
   */
  roundRevision?: number;
  /** Which issue of this room's assignment the matchup came from, when the server supplies it. */
  assignmentRevision?: number;
  leftTeam: ITeamRoster;
  rightTeam: ITeamRoster;
  status: string;
}

export interface ISessionResumeInfo {
  sessionId: string;
  token: string;
  status: string;
  finalReceived: boolean;
  rejectionReason?: string;
}

export interface IAssignmentResponse {
  roomId: string;
  roomName: string;
  tournamentName: string;
  tournamentKey?: string;
  current: IAssignedMatchup | null;
  session: ISessionResumeInfo | null;
  blockedReason?: string;
  blockedMessage?: string;
  scoringFormat: IScorekeeperFormat | null;
  roomProcedure?: IRoomProcedure;
  timedRounds: boolean;
  /** Instructions for the manual backup, when the tournament configured any. Free text. */
  resultHandoffInstruction?: string;
}

export interface ISessionRecovery {
  sessionId: string;
  roundNumber: number;
  leftTeam: string;
  rightTeam: string;
  /** Session lifecycle as reported by tournament control, when the server supplies it. */
  status?: 'open' | 'final-received' | 'abandoned';
  /** Pairing revision metadata carried by recovery-capable servers, when available. */
  roundRevision?: number;
  assignmentRevision?: number;
  finalReceived: boolean;
  /** The most recent payload this session sent, or null if it never sent one. */
  latestQbj: object | null;
  /** Append-only roster changes made by tournament control after the original assignment. */
  rosterAmendments?: IRosterAmendment[];
}

/** Optional, non-authoritative client information included in presence diagnostics. */
export interface IQbtcpClientDiagnostics {
  name?: string;
  version?: string;
  build?: string;
  commit?: string;
}

/** Presence keeps its original `ready` field and adds optional, non-authoritative diagnostics. */
export interface IPresenceUpdate {
  ready?: boolean;
  client?: IQbtcpClientDiagnostics;
  /** Public camelCase name; the QBTCP wire spelling is `procedure_versions`. */
  procedureVersions?: number[];
  /** Accepted as a compatibility alias for callers that use the brief's wording. */
  supportedProcedureVersions?: number[];
  qbjVersion?: string;
}

/** Canonical identity returned after a roster add; every field is optional for old empty-body success. */
export interface IRosterAddResult {
  playerId?: string;
  playerName?: string;
  teamId?: string;
  teamName?: string;
  created?: boolean;
  warning?: string;
}

/** A durable roster amendment returned as part of recovery. */
export interface IRosterAmendment extends IRosterAddResult {
  questionNumber?: number;
}

// --- the one normalized vocabulary -------------------------------------------------------------

/**
 * What tournament control says this room should be doing.
 *
 * QBTCP names all four states; the legacy surface only ever expressed `assigned`, `none` and
 * `blocked`, and its `held` is indistinguishable from `none`. Reading a legacy hold as `none` is
 * the safe direction: it means the room waits rather than starting something.
 */
export type AssignmentState = 'assigned' | 'none' | 'blocked' | 'held';

/**
 * A session tournament control already has open for this assignment.
 *
 * The token is present only when the server handed one back. QBTCP's `assignment/status` names the
 * session without re-issuing its capability, because a room token is not authority to read a
 * session — the room reopens the session to get a token, and reopening returns the same session
 * rather than a second one.
 */
export interface IResumableSession {
  sessionId: string;
  resumable: boolean;
  /** Present only where the surface returned it. Absent means reopen to obtain one. */
  token?: string;
  status?: string;
  finalReceived?: boolean;
  rejectionReason?: string;
}

/**
 * One assignment, however it arrived.
 *
 * `definition` is the game itself, already through the same parser a file goes through. Everything
 * else is operational: it describes the room's situation, not the game, and it is deliberately kept
 * out of the QBJ document for exactly that reason.
 */
export interface INormalizedAssignment {
  state: AssignmentState;
  roomId: string;
  roomName: string;
  tournamentName: string;
  tournamentKey?: string;
  /** The game to score. Null whenever `state` is not `assigned`. */
  definition: IGameDefinition | null;
  /** A deliberately gated fallback for a procedure version this build cannot enforce. */
  emergencyDefinition?: IGameDefinition;
  /** Present when `definition` is withheld because the procedure is newer than this build. */
  unsupportedProcedureVersion?: number;
  /** The handle a session is opened against. `Match.id` on QBTCP; the scheduled match on legacy. */
  scheduledMatchId?: string;
  /** Pairing and room-assignment revisions, when the active surface reports them separately. */
  roundRevision?: number;
  assignmentRevision?: number;
  session: IResumableSession | null;
  blockedReason?: string;
  blockedMessage?: string;
  /** Opaque room-facing copy supplied by assignment/status for the following game. */
  nextAssignmentLabel?: string;
  /**
   * Why an assignment that arrived could not be turned into a game.
   *
   * Distinguished from a failed request: control answered, the room is assigned something, and the
   * document is unusable. The room has to be told that in those words rather than shown an empty
   * screen that looks like "nothing assigned yet".
   */
  errors?: string[];
}

/** A session this device has opened and may write to. */
export interface IOpenedSession {
  sessionId: string;
  token: string;
  /**
   * Whether this device holds the write lock.
   *
   * QBTCP says so explicitly. The legacy surface has no writer concept, so opening a session there
   * is taken as holding it — which is what that server's behaviour already amounted to.
   */
  writer: boolean;
}

/** What became of a final that reached tournament control. */
export interface IResultReceipt {
  accepted: boolean;
  /** True when the authenticated result was durably retained, even if it needs review. */
  received?: boolean;
  /** True when a director must review the retained result before it becomes canonical. */
  reviewRequired?: boolean;
  /** True when this exact statistical result was already on record. The correct answer to a retry. */
  duplicate: boolean;
  matchId?: string;
  fingerprint?: string;
  /** Stable, bounded warning identifiers supplied by tournament control. */
  warningCodes?: string[];
}

/** A refused write that a person, not a retry, has to resolve. */
export interface IWriterConflict {
  /** The device tournament control believes is scoring. Opaque; shown only as "another device". */
  writerDevice?: string;
  canTakeOver: boolean;
}
