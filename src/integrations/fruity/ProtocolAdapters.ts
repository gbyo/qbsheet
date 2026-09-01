/**
 * The two wire surfaces, each written once.
 *
 * # Why an adapter rather than a conditional
 *
 * The route table alone was not enough. QBTCP and the surface it replaces differ in more than
 * spelling: the assignment is a QBJ document with its operational state in a sibling endpoint
 * rather than one JSON object carrying both, a session is opened with different fields and answers
 * with different ones, and progress travels inside a sequenced envelope instead of bare. A client
 * that expressed those differences as conditionals at each call site would have four or five places
 * to forget one, and the one that got forgotten would only be wrong against half the servers in
 * existence.
 *
 * So each surface is an object that knows how to have the same conversation its own way, discovery
 * chooses between them once, and everything above is handed `INormalizedAssignment` and
 * `IOpenedSession` without ever learning which one answered.
 *
 * # Neither adapter parses a game
 *
 * The QBTCP adapter hands the response body to the same reader a file goes through, and the legacy
 * adapter hands its response to the compatibility converter that runs the same validation. Neither
 * one contains a line that knows what a tossup is worth. That is deliberate: a second assignment
 * parser is exactly the drift this migration exists to remove.
 *
 * # Nothing here throws
 *
 * Same rule as the client that owns these. Every operation resolves to a result object, because a
 * rejected promise in a poll is how a scoresheet ends up unmounted by an error boundary mid-round.
 */
import { IGameDefinition } from '../../game/GameDefinition';
import { HelpRequestCategory } from '../../app/HelpRequests';
import {
  IQbtcpDiscovery,
  IQbtcpRoutes,
  legacyRoutes,
  qbtcpRoutes,
  supports,
  unsupportedQbtcpRoutes,
} from '../../qbtcp/QbtcpRoutes';
import { assignmentToGamePackage, qbtcpAssignmentToDefinition } from './FruityGameSource';
import {
  ApiResult,
  AssignmentState,
  IAssignmentResponse,
  IJoinResult,
  INormalizedAssignment,
  IOpenedSession,
  IPresenceUpdate,
  IResultReceipt,
  IResumableSession,
  IRoomIdentity,
  IRoomListEntry,
  IServerIdentity,
  ISessionCredentials,
  ISessionRecovery,
  IRosterAddResult,
  IRosterAmendment,
  IWriterConflict,
  deviceIdHeader,
  operatorNameHeader,
  qbjMediaType,
  roomTokenHeader,
  sessionTokenHeader,
} from './ServerTypes';

export interface IRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** How an adapter reaches the network. Supplied by the client, which owns timeouts and CORS. */
export type RequestFn = <T>(path: string, init?: IRequestOptions) => Promise<ApiResult<T>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function boundedString(value: unknown, maximum = 500): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maximum ? value : undefined;
}

function firstOf(record: Record<string, unknown> | undefined, keys: readonly string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

/**
 * Read the canonical roster identity returned by either generation of tournament control.
 *
 * An older server may return an empty success body. That is intentionally normalized to `{}` rather
 * than treated as an error, so the existing name-based scoring path remains available.
 */
export function readRosterAddResponse(value: unknown): IRosterAddResult {
  if (!isRecord(value)) return {};
  const player = isRecord(value.player) ? value.player : undefined;
  const team = isRecord(value.team) ? value.team : undefined;
  const playerId = boundedString(
    firstOf(player, ['id', 'player_id', 'playerId']) ?? firstOf(value, ['player_id', 'playerId']),
  );
  const playerName = boundedString(
    firstOf(player, ['name', 'player_name', 'playerName']) ??
      firstOf(value, ['player_name', 'playerName', 'name']),
  );
  const teamId = boundedString(
    firstOf(team, ['id', 'team_id', 'teamId']) ?? firstOf(value, ['team_id', 'teamId']),
  );
  const teamName = boundedString(
    firstOf(team, ['name', 'team_name', 'teamName']) ?? firstOf(value, ['team_name', 'teamName']),
  );
  const warning = boundedString(value.warning, 500);
  return {
    ...(playerId !== undefined ? { playerId } : {}),
    ...(playerName !== undefined ? { playerName } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
    ...(teamName !== undefined ? { teamName } : {}),
    ...(typeof value.created === 'boolean' ? { created: value.created } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}

function readRosterAmendment(value: unknown): IRosterAmendment | null {
  const canonical = readRosterAddResponse(value);
  if (!canonical.playerName || (!canonical.teamName && !canonical.teamId)) return null;
  if (!isRecord(value)) return null;
  const rawQuestion = firstOf(value, ['question_number', 'questionNumber']);
  const questionNumber =
    typeof rawQuestion === 'number' &&
    Number.isInteger(rawQuestion) &&
    rawQuestion >= 1 &&
    rawQuestion <= 10000
      ? rawQuestion
      : undefined;
  return { ...canonical, ...(questionNumber !== undefined ? { questionNumber } : {}) };
}

/** Read bounded, canonical roster amendments without exposing arbitrary recovery payload fields. */
export function readRosterAmendments(value: unknown): IRosterAmendment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap((entry) => {
    const amendment = readRosterAmendment(entry);
    return amendment ? [amendment] : [];
  });
}

/** Read the additive receipt fields while retaining the old `accepted` contract. */
export function readResultReceipt(value: unknown): IResultReceipt {
  const raw = isRecord(value) ? value : {};
  const rawReviewRequired = raw.review_required ?? raw.reviewRequired;
  const rawWarnings = firstOf(raw, ['warning_codes', 'warningCodes', 'warnings']);
  const warningCodes = Array.isArray(rawWarnings)
    ? rawWarnings
        .flatMap((warning) => {
          const text = boundedString(warning, 120);
          return text === undefined ? [] : [text];
        })
        .slice(0, 32)
    : [];
  return {
    // A successful response from the pre-receipt protocol was acceptance. Silence remains that
    // compatibility answer; a newer server can additionally say `received` and `review_required`.
    accepted: raw.accepted !== false,
    ...(typeof raw.received === 'boolean' ? { received: raw.received } : {}),
    ...(typeof rawReviewRequired === 'boolean' ? { reviewRequired: rawReviewRequired } : {}),
    duplicate: raw.duplicate === true,
    ...(boundedString(raw.match_id ?? raw.matchId) !== undefined
      ? { matchId: boundedString(raw.match_id ?? raw.matchId) }
      : {}),
    ...(boundedString(raw.fingerprint) !== undefined ? { fingerprint: boundedString(raw.fingerprint) } : {}),
    ...(warningCodes.length > 0 ? { warningCodes } : {}),
  };
}

/** Read old camelCase and QBTCP snake_case recovery bodies into one safe client shape. */
export function readSessionRecovery(value: unknown, fallbackSessionId?: string): ISessionRecovery | null {
  if (!isRecord(value)) return null;
  const sessionId =
    boundedString(firstOf(value, ['session_id', 'sessionId'])) ?? boundedString(fallbackSessionId);
  if (!sessionId) return null;
  const rawRound = firstOf(value, ['round_number', 'roundNumber']);
  const roundNumber =
    typeof rawRound === 'number' && Number.isInteger(rawRound) && rawRound >= 0 ? rawRound : 0;
  const rawStatus = firstOf(value, ['session_status', 'sessionStatus', 'status']);
  const status =
    rawStatus === 'open' || rawStatus === 'final-received' || rawStatus === 'abandoned'
      ? rawStatus
      : undefined;
  const rawRoundRevision = firstOf(value, ['round_revision', 'roundRevision']);
  const roundRevision =
    typeof rawRoundRevision === 'number' && Number.isInteger(rawRoundRevision) && rawRoundRevision >= 1
      ? rawRoundRevision
      : undefined;
  const rawAssignmentRevision = firstOf(value, ['assignment_revision', 'assignmentRevision']);
  const assignmentRevision =
    typeof rawAssignmentRevision === 'number' &&
    Number.isInteger(rawAssignmentRevision) &&
    rawAssignmentRevision >= 1
      ? rawAssignmentRevision
      : undefined;
  const leftTeam = boundedString(firstOf(value, ['left_team', 'leftTeam'])) ?? '';
  const rightTeam = boundedString(firstOf(value, ['right_team', 'rightTeam'])) ?? '';
  const rawLatest = firstOf(value, ['latest_qbj', 'latestQbj']);
  const rawAmendments = firstOf(value, ['roster_amendments', 'rosterAmendments', 'amendments']);
  return {
    sessionId,
    roundNumber,
    leftTeam,
    rightTeam,
    ...(status !== undefined ? { status } : {}),
    ...(roundRevision !== undefined ? { roundRevision } : {}),
    ...(assignmentRevision !== undefined ? { assignmentRevision } : {}),
    finalReceived: firstOf(value, ['final_received', 'finalReceived']) === true,
    latestQbj: isRecord(rawLatest) ? rawLatest : null,
    ...(Array.isArray(rawAmendments) ? { rosterAmendments: readRosterAmendments(rawAmendments) } : {}),
  };
}

/** Encode only the bounded, advisory presence fields QBTCP defines. */
export function normalizePresenceUpdate(update: IPresenceUpdate): Record<string, unknown> {
  const raw = isRecord(update) ? update : {};
  const normalized: Record<string, unknown> = {};
  if (typeof raw.ready === 'boolean') normalized.ready = raw.ready;

  const rawClient = isRecord(raw.client) ? raw.client : undefined;
  if (rawClient) {
    const client: Record<string, string> = {};
    for (const key of ['name', 'version', 'build', 'commit'] as const) {
      const value = boundedString(rawClient[key], 100);
      if (value !== undefined) client[key] = value;
    }
    if (Object.keys(client).length > 0) normalized.client = client;
  }

  const rawVersions = raw.procedureVersions ?? raw.supportedProcedureVersions ?? raw.procedure_versions;
  if (Array.isArray(rawVersions)) {
    const versions = rawVersions
      .filter(
        (version): version is number =>
          typeof version === 'number' && Number.isInteger(version) && version >= 1,
      )
      .slice(0, 16);
    if (versions.length > 0) normalized.procedure_versions = versions;
  }
  const qbjVersion = boundedString(raw.qbjVersion ?? raw.qbj_version, 50);
  if (qbjVersion !== undefined) normalized.qbj_version = qbjVersion;
  return normalized;
}

/**
 * Read the conflict body of a refused write.
 *
 * `can_take_over: true` is the server saying a person may resolve this. Anything else — including a
 * body this cannot read — is read as no offer, because presenting a takeover button that the server
 * will refuse is worse than presenting none.
 */
export function readWriterConflict(payload: unknown): IWriterConflict {
  if (!isRecord(payload)) return { canTakeOver: false };
  return {
    ...(stringOf(payload.writer_device) ? { writerDevice: stringOf(payload.writer_device) } : {}),
    canTakeOver: payload.can_take_over === true,
  };
}

/** The states QBTCP names. An unrecognized one is read as `none`, so the room waits. */
function readAssignmentState(value: unknown): AssignmentState {
  return value === 'assigned' || value === 'blocked' || value === 'held' ? value : 'none';
}

/** The `/assignment/status` body, read for the parts a scoresheet acts on. */
export function readAssignmentStatus(value: unknown): {
  state: AssignmentState;
  session: IResumableSession | null;
  roundRevision?: number;
  assignmentRevision?: number;
  blockedReason?: string;
  blockedMessage?: string;
  nextAssignmentLabel?: string;
} | null {
  if (!isRecord(value)) return null;
  const rawSession = isRecord(value.session) ? value.session : null;
  const sessionId = rawSession ? stringOf(rawSession.session_id) : undefined;
  const rawNext = isRecord(value.next) ? value.next : null;
  const nextAssignmentLabel =
    rawNext && typeof rawNext.label === 'string' && rawNext.label.trim() !== '' ? rawNext.label : undefined;
  return {
    state: readAssignmentState(value.state),
    session: sessionId ? { sessionId, resumable: rawSession?.resumable !== false } : null,
    ...(typeof value.round_revision === 'number' &&
    Number.isInteger(value.round_revision) &&
    value.round_revision >= 1
      ? { roundRevision: value.round_revision }
      : {}),
    ...(typeof value.assignment_revision === 'number' &&
    Number.isInteger(value.assignment_revision) &&
    value.assignment_revision >= 1
      ? { assignmentRevision: value.assignment_revision }
      : {}),
    ...(stringOf(value.blocked_reason) ? { blockedReason: stringOf(value.blocked_reason) } : {}),
    ...(stringOf(value.blocked_message) ? { blockedMessage: stringOf(value.blocked_message) } : {}),
    ...(nextAssignmentLabel !== undefined ? { nextAssignmentLabel } : {}),
  };
}

export interface IServerAdapter {
  readonly routes: IQbtcpRoutes;
  /** Is anything there, and is it speaking this protocol? */
  verify(): Promise<ApiResult<unknown>>;
  /** What tournament is open. */
  identify(): Promise<ApiResult<IServerIdentity>>;
  /** The optional room picker. An empty list is not an error; it means no listing was offered. */
  listRooms(): Promise<ApiResult<IRoomListEntry[]>>;
  /** Exchange the human pairing code for this room's token. */
  join(code: string, roomId?: string): Promise<ApiResult<IJoinResult>>;
  assignment(identity: IRoomIdentity): Promise<ApiResult<INormalizedAssignment>>;
  openSession(identity: IRoomIdentity, matchId: string): Promise<ApiResult<IOpenedSession>>;
  /** Claim the write lock from another device. A person starts this; it is never automatic. */
  takeWriter(identity: IRoomIdentity, credentials: ISessionCredentials): Promise<ApiResult<IOpenedSession>>;
  updatePresence(identity: IRoomIdentity, update: IPresenceUpdate): Promise<ApiResult<unknown>>;
  requestHelp(
    identity: IRoomIdentity,
    category: HelpRequestCategory,
    message: string,
  ): Promise<ApiResult<unknown>>;
  readHelp(identity: IRoomIdentity): Promise<ApiResult<unknown>>;
  cancelHelp(identity: IRoomIdentity, helpId: string): Promise<ApiResult<unknown>>;
  addRosterPlayer(
    identity: IRoomIdentity,
    credentials: ISessionCredentials,
    teamName: string,
    playerName: string,
    teamId?: string,
    questionNumber?: number,
  ): Promise<ApiResult<IRosterAddResult>>;
  putProgress(credentials: ISessionCredentials, qbj: object, sequence: number): Promise<ApiResult<unknown>>;
  postResult(credentials: ISessionCredentials, qbj: object): Promise<ApiResult<IResultReceipt>>;
  recover(credentials: ISessionCredentials): Promise<ApiResult<ISessionRecovery>>;
}

abstract class BaseAdapter implements IServerAdapter {
  abstract readonly routes: IQbtcpRoutes;

  constructor(protected request: RequestFn) {}

  protected roomHeaders(identity: IRoomIdentity, json?: string): Record<string, string> {
    const headers: Record<string, string> = { [roomTokenHeader]: identity.token };
    if (json) headers['Content-Type'] = json;
    if (identity.deviceId) headers[deviceIdHeader] = identity.deviceId;
    if (identity.operatorName) headers[operatorNameHeader] = identity.operatorName;
    return headers;
  }

  protected sessionHeaders(credentials: ISessionCredentials, json?: string): Record<string, string> {
    const headers: Record<string, string> = { [sessionTokenHeader]: credentials.token };
    if (json) headers['Content-Type'] = json;
    return headers;
  }

  verify(): Promise<ApiResult<unknown>> {
    return this.request(this.routes.status);
  }

  abstract identify(): Promise<ApiResult<IServerIdentity>>;

  abstract listRooms(): Promise<ApiResult<IRoomListEntry[]>>;

  join(code: string, roomId?: string): Promise<ApiResult<IJoinResult>> {
    return this.request(this.routes.pair, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roomId ? { code, roomId } : { code }),
    });
  }

  abstract assignment(identity: IRoomIdentity): Promise<ApiResult<INormalizedAssignment>>;

  abstract openSession(identity: IRoomIdentity, matchId: string): Promise<ApiResult<IOpenedSession>>;

  abstract takeWriter(
    identity: IRoomIdentity,
    credentials: ISessionCredentials,
  ): Promise<ApiResult<IOpenedSession>>;

  updatePresence(identity: IRoomIdentity, update: IPresenceUpdate): Promise<ApiResult<unknown>> {
    return this.request(this.routes.presence(identity.roomId), {
      method: 'POST',
      headers: this.roomHeaders(identity, 'application/json'),
      body: JSON.stringify(normalizePresenceUpdate(update)),
    });
  }

  requestHelp(
    identity: IRoomIdentity,
    category: HelpRequestCategory,
    message: string,
  ): Promise<ApiResult<unknown>> {
    return this.request(this.routes.help(identity.roomId), {
      method: 'POST',
      headers: this.roomHeaders(identity, 'application/json'),
      body: JSON.stringify({ category, message }),
    });
  }

  readHelp(identity: IRoomIdentity): Promise<ApiResult<unknown>> {
    return this.request(this.routes.help(identity.roomId), {
      headers: this.roomHeaders(identity),
    });
  }

  cancelHelp(identity: IRoomIdentity, helpId: string): Promise<ApiResult<unknown>> {
    return this.request(this.routes.helpItem(identity.roomId, helpId), {
      method: 'DELETE',
      headers: this.roomHeaders(identity),
    });
  }

  addRosterPlayer(
    identity: IRoomIdentity,
    credentials: ISessionCredentials,
    teamName: string,
    playerName: string,
    teamId?: string,
    questionNumber?: number,
  ): Promise<ApiResult<IRosterAddResult>> {
    const safeTeamId = boundedString(teamId);
    return this.request<unknown>(this.routes.addPlayer(identity.roomId), {
      method: 'POST',
      headers: {
        ...this.roomHeaders(identity, 'application/json'),
        [sessionTokenHeader]: credentials.token,
      },
      body: JSON.stringify({
        sessionId: credentials.sessionId,
        ...(safeTeamId ? { team_id: safeTeamId } : {}),
        teamName,
        playerName,
        ...(typeof questionNumber === 'number' && Number.isInteger(questionNumber) && questionNumber >= 1
          ? { question_number: questionNumber }
          : {}),
      }),
    }).then((result) => (result.ok ? { ok: true, value: readRosterAddResponse(result.value) } : result));
  }

  abstract putProgress(
    credentials: ISessionCredentials,
    qbj: object,
    sequence: number,
  ): Promise<ApiResult<unknown>>;

  abstract postResult(credentials: ISessionCredentials, qbj: object): Promise<ApiResult<IResultReceipt>>;

  recover(credentials: ISessionCredentials): Promise<ApiResult<ISessionRecovery>> {
    return this.request<unknown>(this.routes.recovery(credentials.sessionId), {
      headers: this.sessionHeaders(credentials),
    }).then((result) => {
      if (!result.ok) return result;
      const recovery = readSessionRecovery(result.value, credentials.sessionId);
      return recovery
        ? { ok: true, value: recovery }
        : { ok: false, error: 'Tournament control sent a recovery answer this page could not read.' };
    });
  }
}

/**
 * The canonical surface.
 *
 * Holds the discovery document, because on this surface discovery is not only how the client chose
 * these routes — it is also the authoritative statement of what the server supports and the only
 * place an unauthenticated client learns the tournament's name.
 */
export class QbtcpAdapter extends BaseAdapter {
  readonly routes = qbtcpRoutes;

  constructor(
    request: RequestFn,
    private discovery: IQbtcpDiscovery,
  ) {
    super(request);
  }

  /**
   * The tournament, from discovery.
   *
   * No request: discovery already carried the name, and the scoring rules that the legacy surface
   * had to be asked for arrive inside the assignment document here. Asking a second endpoint for
   * something already in hand would add a round trip whose only possible outcome is a timeout.
   */
  async identify(): Promise<ApiResult<IServerIdentity>> {
    return {
      ok: true,
      value: {
        name: this.discovery.name ?? 'Tournament control',
        scoringFormat: null,
        timedRounds: false,
        roundCount: 0,
        teamCount: 0,
      },
    };
  }

  /**
   * Exchange a code for the room capability.
   *
   * The one field this renames: QBTCP calls the room capability `token`, and the surface it replaces
   * called it `accessToken`. Everything above holds one name for it, so the rename happens here
   * rather than at the place a token is read.
   */
  override join(code: string, roomId?: string): Promise<ApiResult<IJoinResult>> {
    return this.guard('pairing', 'pairing', () => this.pair(code, roomId));
  }

  private async pair(code: string, roomId?: string): Promise<ApiResult<IJoinResult>> {
    const result = await this.request<unknown>(this.routes.pair, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roomId ? { code, roomId } : { code }),
    });
    if (!result.ok) return result;
    const body = isRecord(result.value) ? result.value : {};
    const paired = stringOf(body.roomId);
    const token = stringOf(body.token) ?? stringOf(body.accessToken);
    if (!paired || !token) {
      return { ok: false, error: 'Tournament control accepted the code but did not pair this room.' };
    }
    return {
      ok: true,
      value: {
        roomId: paired,
        roomName: stringOf(body.roomName) ?? paired,
        ...(stringOf(body.roomDescription) ? { roomDescription: stringOf(body.roomDescription) } : {}),
        accessToken: token,
      },
    };
  }

  async listRooms(): Promise<ApiResult<IRoomListEntry[]>> {
    const result = await this.request<unknown>(this.routes.rooms);
    if (!result.ok) return result;
    const rooms = isRecord(result.value) && Array.isArray(result.value.rooms) ? result.value.rooms : [];
    return {
      ok: true,
      value: rooms.filter(isRecord).flatMap((entry) => {
        const id = stringOf(entry.id);
        if (!id) return [];
        return [
          {
            id,
            name: stringOf(entry.name) ?? id,
            ...(stringOf(entry.description) ? { description: stringOf(entry.description) } : {}),
          },
        ];
      }),
    };
  }

  /**
   * The assignment, in the two pieces QBTCP deliberately keeps apart.
   *
   * Operational state comes from `/assignment/status`, because it is not part of the game and a QBJ
   * body would need invented fields to carry it. The game comes from `/assignment` as an ordinary
   * QBJ document, and is read by the same function a file is read by.
   *
   * The body is fetched only when the status says there is one. When the status endpoint is missing
   * — an early server that shipped the assignment route first — the body speaks for itself, and a
   * `204` means the same thing `state: "none"` does.
   */
  assignment(identity: IRoomIdentity): Promise<ApiResult<INormalizedAssignment>> {
    return this.guard('assignment', 'assignments', () => this.readAssignment(identity));
  }

  private async readAssignment(identity: IRoomIdentity): Promise<ApiResult<INormalizedAssignment>> {
    const base = {
      roomId: identity.roomId,
      roomName: identity.roomName ?? identity.roomId,
      tournamentName: this.discovery.name ?? '',
    };

    const statusPath = this.routes.assignmentStatus(identity.roomId);
    const status = statusPath
      ? await this.request<unknown>(statusPath, { headers: this.roomHeaders(identity) })
      : null;

    // A credential refusal or an unreachable server is this room's answer, whichever endpoint it
    // came from. Anything else about the status endpoint alone is survivable, so it falls through.
    if (
      status &&
      !status.ok &&
      (status.status === undefined || status.status === 401 || status.status === 403)
    ) {
      return status;
    }
    const operational = status?.ok ? readAssignmentStatus(status.value) : null;

    if (operational && operational.state !== 'assigned') {
      return {
        ok: true,
        value: {
          ...base,
          state: operational.state,
          definition: null,
          session: operational.session,
          ...(operational.roundRevision !== undefined ? { roundRevision: operational.roundRevision } : {}),
          ...(operational.assignmentRevision !== undefined
            ? { assignmentRevision: operational.assignmentRevision }
            : {}),
          ...(operational.blockedReason ? { blockedReason: operational.blockedReason } : {}),
          ...(operational.blockedMessage ? { blockedMessage: operational.blockedMessage } : {}),
          ...(operational.nextAssignmentLabel
            ? { nextAssignmentLabel: operational.nextAssignmentLabel }
            : {}),
        },
      };
    }

    const body = await this.request<unknown>(this.routes.assignment(identity.roomId), {
      headers: this.roomHeaders(identity),
    });
    if (!body.ok) return body;

    // `204 No Content` — the server has nothing for this room. Not an empty QBJ document.
    if (body.value === null || body.value === undefined) {
      return {
        ok: true,
        value: {
          ...base,
          state: operational?.state ?? 'none',
          definition: null,
          session: operational?.session ?? null,
          ...(operational?.roundRevision !== undefined ? { roundRevision: operational.roundRevision } : {}),
          ...(operational?.assignmentRevision !== undefined
            ? { assignmentRevision: operational.assignmentRevision }
            : {}),
          ...(operational?.nextAssignmentLabel
            ? { nextAssignmentLabel: operational.nextAssignmentLabel }
            : {}),
        },
      };
    }

    const opened = qbtcpAssignmentToDefinition(body.value);
    if (!opened.ok) {
      const emergency =
        opened.unsupportedProcedureVersion !== undefined
          ? qbtcpAssignmentToDefinition(body.value, { continueWithModeratorInstructions: true })
          : null;
      const emergencyDefinition =
        emergency?.ok && emergency.kind === 'game' ? emergency.definition : undefined;
      return {
        ok: true,
        value: {
          ...base,
          state: 'assigned',
          definition: null,
          session: operational?.session ?? null,
          ...(operational?.roundRevision !== undefined ? { roundRevision: operational.roundRevision } : {}),
          ...(operational?.assignmentRevision !== undefined
            ? { assignmentRevision: operational.assignmentRevision }
            : {}),
          ...(operational?.nextAssignmentLabel
            ? { nextAssignmentLabel: operational.nextAssignmentLabel }
            : {}),
          errors: opened.errors,
          ...(opened.unsupportedProcedureVersion !== undefined
            ? { unsupportedProcedureVersion: opened.unsupportedProcedureVersion }
            : {}),
          ...(emergencyDefinition ? { emergencyDefinition } : {}),
        },
      };
    }
    if (opened.kind === 'choice') {
      return {
        ok: true,
        value: {
          ...base,
          state: 'assigned',
          definition: null,
          session: operational?.session ?? null,
          ...(operational?.roundRevision !== undefined ? { roundRevision: operational.roundRevision } : {}),
          ...(operational?.assignmentRevision !== undefined
            ? { assignmentRevision: operational.assignmentRevision }
            : {}),
          ...(operational?.nextAssignmentLabel
            ? { nextAssignmentLabel: operational.nextAssignmentLabel }
            : {}),
          errors: [
            'Tournament control sent more than one game for this room. Ask tournament control to reissue the assignment.',
          ],
        },
      };
    }
    if (opened.kind === 'backup') {
      return {
        ok: true,
        value: {
          ...base,
          state: 'assigned',
          definition: null,
          session: operational?.session ?? null,
          ...(operational?.nextAssignmentLabel
            ? { nextAssignmentLabel: operational.nextAssignmentLabel }
            : {}),
          errors: ['Tournament control sent a QBSheet recovery backup where an assignment was expected.'],
        },
      };
    }

    const definition = opened.definition;
    return {
      ok: true,
      value: {
        ...base,
        roomName: identity.roomName ?? definition.room?.name ?? identity.roomId,
        tournamentName: definition.tournament.name,
        ...(definition.tournament.key ? { tournamentKey: definition.tournament.key } : {}),
        state: 'assigned',
        definition,
        roundRevision: definition.round.revision,
        ...(definition.round.assignmentRevision !== undefined
          ? { assignmentRevision: definition.round.assignmentRevision }
          : {}),
        ...(scheduledMatchIdOf(definition) ? { scheduledMatchId: scheduledMatchIdOf(definition) } : {}),
        session: operational?.session ?? null,
        ...(operational?.nextAssignmentLabel ? { nextAssignmentLabel: operational.nextAssignmentLabel } : {}),
      },
    };
  }

  /** Sessions are how an assignment is scored, so they are gated with it: QBTCP names no other. */
  openSession(identity: IRoomIdentity, matchId: string): Promise<ApiResult<IOpenedSession>> {
    return this.guard('assignment', 'assignments', () => this.startSession(identity, matchId));
  }

  private async startSession(identity: IRoomIdentity, matchId: string): Promise<ApiResult<IOpenedSession>> {
    const result = await this.request<unknown>(this.routes.openSession(identity.roomId), {
      method: 'POST',
      headers: this.roomHeaders(identity, 'application/json'),
      // Omitted rather than empty when there is none. An empty string is a device identifier that
      // every device without one shares, and the server arbitrates writer ownership by this field.
      body: JSON.stringify({
        match_id: matchId,
        ...(identity.deviceId ? { device_id: identity.deviceId } : {}),
      }),
    });
    if (!result.ok) return result;
    const body = isRecord(result.value) ? result.value : {};
    const sessionId = stringOf(body.session_id);
    const token = stringOf(body.token);
    if (!sessionId || !token) {
      return { ok: false, error: 'Tournament control opened a game but did not say which one.' };
    }
    return { ok: true, value: { sessionId, token, writer: body.writer !== false } };
  }

  async takeWriter(
    identity: IRoomIdentity,
    credentials: ISessionCredentials,
  ): Promise<ApiResult<IOpenedSession>> {
    const result = await this.request<unknown>(`${this.routes.session(credentials.sessionId)}/writer`, {
      method: 'POST',
      headers: this.sessionHeaders(credentials, 'application/json'),
      body: JSON.stringify({
        ...(identity.deviceId ? { device_id: identity.deviceId } : {}),
        take_over: true,
      }),
    });
    if (!result.ok) return result;
    const body = isRecord(result.value) ? result.value : {};
    // The token does not change on a transfer; only who may write with it does.
    return {
      ok: true,
      value: {
        sessionId: stringOf(body.session_id) ?? credentials.sessionId,
        token: stringOf(body.token) ?? credentials.token,
        writer: body.writer !== false,
      },
    };
  }

  /**
   * A snapshot, inside the envelope QBTCP requires.
   *
   * `sequence` is transport metadata and is deliberately outside the `Match`: a client assigns it,
   * a server prefers the higher one, and a QBJ document that carried it would be a QBJ document
   * with an invented field in it.
   */
  putProgress(credentials: ISessionCredentials, qbj: object, sequence: number): Promise<ApiResult<unknown>> {
    return this.guard('progress', 'live progress', () => this.sendProgress(credentials, qbj, sequence));
  }

  private sendProgress(
    credentials: ISessionCredentials,
    qbj: object,
    sequence: number,
  ): Promise<ApiResult<unknown>> {
    return this.request(this.routes.progress(credentials.sessionId), {
      method: 'PUT',
      headers: this.sessionHeaders(credentials, 'application/json'),
      body: JSON.stringify({ sequence, match: qbj }),
    });
  }

  postResult(credentials: ISessionCredentials, qbj: object): Promise<ApiResult<IResultReceipt>> {
    return this.guard('result', 'result submission', () => this.sendResult(credentials, qbj));
  }

  private async sendResult(
    credentials: ISessionCredentials,
    qbj: object,
  ): Promise<ApiResult<IResultReceipt>> {
    const result = await this.request<unknown>(this.routes.result(credentials.sessionId), {
      method: 'POST',
      headers: this.sessionHeaders(credentials, qbjMediaType),
      body: JSON.stringify(qbj),
    });
    if (!result.ok) return result;
    return { ok: true, value: readResultReceipt(result.value) };
  }

  /**
   * Refuse an operation this server did not say it supports.
   *
   * "A client MUST NOT infer support from the absence of an error. A client MUST NOT require a
   * capability that discovery did not advertise." So the route is not requested at all, rather than
   * probed to see what comes back — a probe is the inference the protocol forbids, and against a
   * server that answers something unhelpful it is also how a room ends up acting on a guess.
   */
  private unsupported(capability: string): ApiResult<never> {
    return {
      ok: false,
      unsupported: true,
      error: `Tournament control does not offer ${capability} on this connection.`,
    };
  }

  private guard<T>(
    capability: string,
    described: string,
    operation: () => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> {
    if (!supports(this.discovery, capability)) return Promise.resolve(this.unsupported(described));
    return operation();
  }

  override recover(credentials: ISessionCredentials): Promise<ApiResult<ISessionRecovery>> {
    return this.guard('recovery', 'server-assisted recovery', () => super.recover(credentials));
  }

  override requestHelp(
    identity: IRoomIdentity,
    category: HelpRequestCategory,
    message: string,
  ): Promise<ApiResult<unknown>> {
    return this.guard('help', 'help requests', () => super.requestHelp(identity, category, message));
  }

  override readHelp(identity: IRoomIdentity): Promise<ApiResult<unknown>> {
    return this.guard('help', 'help requests', () => super.readHelp(identity));
  }

  override cancelHelp(identity: IRoomIdentity, helpId: string): Promise<ApiResult<unknown>> {
    return this.guard('help', 'help requests', () => super.cancelHelp(identity, helpId));
  }

  override updatePresence(identity: IRoomIdentity, update: IPresenceUpdate): Promise<ApiResult<unknown>> {
    return this.guard('presence', 'presence', () => super.updatePresence(identity, update));
  }
}

/** Exact refusal for an explicit QBTCP version newer than this client can interpret. */
export function unsupportedQbtcpMessage(version: number): string {
  return `Tournament control uses QBTCP v${version}. This version of QBSheet supports v1. Update QBSheet or score from an assignment file.`;
}

/**
 * Adapter selected only after a server explicitly announces a future QBTCP version.
 *
 * It never probes a legacy endpoint and never sends a request after discovery. A version mismatch is
 * a protocol decision, not a transient network failure, so the refusal is stable and actionable.
 */
export class UnsupportedQbtcpAdapter implements IServerAdapter {
  readonly routes = unsupportedQbtcpRoutes;

  constructor(private discovery: IQbtcpDiscovery) {}

  private refusal<T>(): ApiResult<T> {
    return { ok: false, unsupported: true, error: unsupportedQbtcpMessage(this.discovery.version) };
  }

  verify(): Promise<ApiResult<unknown>> {
    return Promise.resolve(this.refusal());
  }

  identify(): Promise<ApiResult<IServerIdentity>> {
    return Promise.resolve(this.refusal());
  }

  listRooms(): Promise<ApiResult<IRoomListEntry[]>> {
    return Promise.resolve(this.refusal());
  }

  join(): Promise<ApiResult<IJoinResult>> {
    return Promise.resolve(this.refusal());
  }

  assignment(): Promise<ApiResult<INormalizedAssignment>> {
    return Promise.resolve(this.refusal());
  }

  openSession(): Promise<ApiResult<IOpenedSession>> {
    return Promise.resolve(this.refusal());
  }

  takeWriter(): Promise<ApiResult<IOpenedSession>> {
    return Promise.resolve(this.refusal());
  }

  updatePresence(): Promise<ApiResult<unknown>> {
    return Promise.resolve(this.refusal());
  }

  requestHelp(): Promise<ApiResult<unknown>> {
    return Promise.resolve(this.refusal());
  }

  readHelp(): Promise<ApiResult<unknown>> {
    return Promise.resolve(this.refusal());
  }

  cancelHelp(): Promise<ApiResult<unknown>> {
    return Promise.resolve(this.refusal());
  }

  addRosterPlayer(): Promise<ApiResult<IRosterAddResult>> {
    return Promise.resolve(this.refusal());
  }

  putProgress(): Promise<ApiResult<unknown>> {
    return Promise.resolve(this.refusal());
  }

  postResult(): Promise<ApiResult<IResultReceipt>> {
    return Promise.resolve(this.refusal());
  }

  recover(): Promise<ApiResult<ISessionRecovery>> {
    return Promise.resolve(this.refusal());
  }
}

/** The strongest identity the assignment gave the game, for opening a session against it. */
function scheduledMatchIdOf(definition: IGameDefinition): string | undefined {
  return definition.scheduledMatchId ?? definition.qbjIdentity?.matchId;
}

/**
 * The surface deployed before QBTCP was named.
 *
 * Kept whole rather than emulated. Its assignment response is one object carrying both the game and
 * the room's situation, its sessions are opened and answered with different field names, and its
 * snapshots are bare. Every one of those is translated here and nowhere else.
 */
export class LegacyAdapter extends BaseAdapter {
  readonly routes = legacyRoutes;

  identify(): Promise<ApiResult<IServerIdentity>> {
    return this.request(this.routes.tournament);
  }

  async listRooms(): Promise<ApiResult<IRoomListEntry[]>> {
    const result = await this.request<{ rooms: IRoomListEntry[] }>(this.routes.rooms);
    if (!result.ok) return result;
    return { ok: true, value: Array.isArray(result.value?.rooms) ? result.value.rooms : [] };
  }

  async assignment(identity: IRoomIdentity): Promise<ApiResult<INormalizedAssignment>> {
    const result = await this.request<IAssignmentResponse>(this.routes.assignment(identity.roomId), {
      headers: this.roomHeaders(identity),
    });
    if (!result.ok) return result;
    const response = result.value;
    // Read rather than trusted. The response is untyped JSON from the network whatever the cast
    // says, and a session block missing its identifier or its token would otherwise hand the caller
    // credentials that are `undefined` behind a type that promises two strings.
    const rawSession = isRecord(response) && isRecord(response.session) ? response.session : null;
    const sessionId = rawSession ? stringOf(rawSession.sessionId) : undefined;
    const sessionToken = rawSession ? stringOf(rawSession.token) : undefined;
    const session: IResumableSession | null =
      sessionId && sessionToken
        ? {
            sessionId,
            token: sessionToken,
            // This surface never described a session it did not intend the room to resume.
            resumable: rawSession?.finalReceived !== true,
            ...(stringOf(rawSession?.status) ? { status: stringOf(rawSession?.status) } : {}),
            finalReceived: rawSession?.finalReceived === true,
            ...(stringOf(rawSession?.rejectionReason)
              ? { rejectionReason: stringOf(rawSession?.rejectionReason) }
              : {}),
          }
        : null;

    // Either field is the server saying this room is held. A block with a reason and no message is
    // still a block, and reading it as an ordinary assignment would let the room start anyway.
    const blocked = Boolean(response.blockedMessage) || Boolean(response.blockedReason);

    const base = {
      roomId: response.roomId,
      roomName: response.roomName,
      tournamentName: response.tournamentName,
      ...(response.tournamentKey ? { tournamentKey: response.tournamentKey } : {}),
      session,
      ...(response.blockedReason ? { blockedReason: response.blockedReason } : {}),
      ...(response.blockedMessage ? { blockedMessage: response.blockedMessage } : {}),
    };

    if (!response.current) {
      return { ok: true, value: { ...base, state: blocked ? 'blocked' : 'none', definition: null } };
    }

    const built = assignmentToGamePackage({ assignment: response, matchup: response.current });
    if (!built.ok) {
      return {
        ok: true,
        value: {
          ...base,
          state: 'assigned',
          definition: null,
          scheduledMatchId: response.current.scheduledMatchId,
          errors: built.errors,
        },
      };
    }
    return {
      ok: true,
      value: {
        ...base,
        // A blocked room on this surface still receives the matchup; the block is what stops it.
        state: blocked ? 'blocked' : 'assigned',
        definition: built.value,
        scheduledMatchId: response.current.scheduledMatchId,
        roundRevision: built.value.round.revision,
        ...(built.value.round.assignmentRevision !== undefined
          ? { assignmentRevision: built.value.round.assignmentRevision }
          : {}),
      },
    };
  }

  async openSession(identity: IRoomIdentity, matchId: string): Promise<ApiResult<IOpenedSession>> {
    const result = await this.request<{ sessionId?: string; token?: string }>(
      this.routes.openSession(identity.roomId),
      {
        method: 'POST',
        headers: this.roomHeaders(identity, 'application/json'),
        body: JSON.stringify({ scheduledMatchId: matchId, scorer: 'first-party' }),
      },
    );
    if (!result.ok) return result;
    const { sessionId, token } = result.value ?? {};
    if (!sessionId || !token) {
      return { ok: false, error: 'Tournament control opened a game but did not say which one.' };
    }
    // This surface has no writer concept, so a session it handed over is one this device may write.
    return { ok: true, value: { sessionId, token, writer: true } };
  }

  async takeWriter(): Promise<ApiResult<IOpenedSession>> {
    return {
      ok: false,
      error:
        'This tournament control cannot move a game between devices. Ask tournament control to reassign the room.',
    };
  }

  /** Bare, because this surface has no envelope and would not know what to do with a sequence. */
  putProgress(credentials: ISessionCredentials, qbj: object): Promise<ApiResult<unknown>> {
    return this.request(this.routes.progress(credentials.sessionId), {
      method: 'PUT',
      headers: this.sessionHeaders(credentials, 'application/json'),
      body: JSON.stringify(qbj),
    });
  }

  // Ungated, and it has to be: this surface has no discovery document to ask, so every capability
  // question here is answered by trying. That is the deprecation, not an oversight.
  async postResult(credentials: ISessionCredentials, qbj: object): Promise<ApiResult<IResultReceipt>> {
    const result = await this.request<unknown>(this.routes.result(credentials.sessionId), {
      method: 'POST',
      headers: this.sessionHeaders(credentials, 'application/json'),
      body: JSON.stringify(qbj),
    });
    if (!result.ok) return result;
    return { ok: true, value: readResultReceipt(result.value) };
  }
}
