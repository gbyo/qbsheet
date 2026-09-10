/**
 * Room-centric delivery derivation for #702.
 *
 * The Delivery & Results page reads per-scheduled-game operational state from
 * here instead of scattering `.filter()` calls through JSX or treating the
 * round-level `deliveryMode` as per-game truth. Three concerns stay separate:
 *
 * - intent: what the director expects this game/room to use (explicit
 *   per-game intent, else live QBTCP session evidence, else the round
 *   default, else manual);
 * - readiness: what is actually usable right now (session state, prepared
 *   file currentness, manual handoff);
 * - history: `transfers.assignments` evidence, which is never rewritten when
 *   intent changes.
 */
import { orderDayItems } from '../domain';
import type {
  AssignmentTransfer,
  DeliveryTransport,
  DirectorId,
  DirectorState,
  GameDeliveryIntent,
  GameRecord,
  QbtcpRoomSession,
  ResultSubmission,
  Round,
  ScheduledGame,
} from '../domain';

/**
 * The current operational round: an actively running round wins, otherwise
 * the next round in the persisted day order. (Moved here from assignment.ts
 * so the delivery derivation and the prepare selection share one rule.)
 */
export function currentOperationalRound(state: DirectorState): Round | undefined {
  const rounds = orderDayItems(state.rounds, state.timeline).flatMap((item) =>
    item.round ? [item.round] : [],
  );
  const selected = rounds.find((round) => round.id === state.tournament?.currentRoundId);
  // An actively running round wins. Otherwise the next round in the persisted day
  // order is useful; generating all nine rounds must not make Round 9 current.
  if (selected?.status === 'released') return selected;
  return (
    rounds.find((round) => round.status === 'released') ?? rounds.find((round) => round.status !== 'closed')
  );
}

export type DeliveryIntentSource = 'explicit' | 'session' | 'round-default' | 'manual';

export interface DerivedDeliveryIntent {
  primary: DeliveryTransport;
  fallbacks: DeliveryTransport[];
  source: DeliveryIntentSource;
}

export type AssignmentReadinessState =
  | 'qbtcp-connected'
  | 'qbtcp-delivered'
  | 'file-current'
  | 'file-needed'
  | 'needs-reprepare'
  | 'manual'
  | 'problem';

export interface GameAssignmentReadiness {
  state: AssignmentReadinessState;
  /** Director-language explanation, e.g. why a fallback is offered. */
  message?: string;
  /** A current file exists alongside a non-file primary: a valid backup, never a conflict. */
  backupCurrent: boolean;
  /** A prepared file exists but no longer matches the live assignment revision. */
  backupStale: boolean;
}

export type GameResultState =
  'waiting' | 'received' | 'review' | 'accepted' | 'rejected' | 'conflict' | 'duplicate';

export interface GameResultStatus {
  state: GameResultState;
  submissionId?: DirectorId;
  artifactId?: DirectorId;
  /** Secondary context only: `via QBTCP`, a drive label, `imported file`. Never the title. */
  sourceLabel?: string;
  /** Set only from an accepted record, when the score is safely known. */
  scoreLine?: string;
}

export interface GameDeliveryStatus {
  scheduledGameId: DirectorId;
  roundId: DirectorId;
  roomId: DirectorId | null;
  roomName: string;
  matchup: string;
  intent: DerivedDeliveryIntent;
  assignment: GameAssignmentReadiness;
  result: GameResultStatus;
  /** True when preparing a file is the right next action for this game. */
  needsFile: boolean;
}

const FILE_TRANSPORTS: ReadonlySet<AssignmentTransfer['transportKind']> = new Set([
  'removable-drive',
  'folder',
  'manual-file',
  'download',
]);

function isTransport(value: unknown): value is DeliveryTransport {
  return value === 'qbtcp' || value === 'file' || value === 'manual';
}

/** Fail-closed sanitizer for persisted per-game intent; garbage loads as absent. */
export function sanitizeDeliveryIntent(value: unknown): GameDeliveryIntent | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const primary = isTransport(record.primary) ? record.primary : undefined;
  const fallbacks = Array.isArray(record.fallbacks)
    ? [...new Set(record.fallbacks.filter((entry) => isTransport(entry) && entry !== primary))]
    : [];
  if (!primary && fallbacks.length === 0) return undefined;
  return { ...(primary ? { primary } : {}), fallbacks };
}

function roundDefault(state: DirectorState, game: ScheduledGame): DeliveryTransport | undefined {
  const round = state.rounds.find((entry) => entry.id === game.roundId);
  if (!round?.deliveryMode) return undefined;
  return round.deliveryMode === 'usb' ? 'file' : round.deliveryMode;
}

/** Live (non-abandoned) QBTCP sessions for a room, newest activity first. */
export function liveRoomSessions(state: DirectorState, roomId: DirectorId | null): QbtcpRoomSession[] {
  if (!roomId) return [];
  return state.qbtcpSessions
    .filter((session) => session.roomId === roomId && session.state !== 'abandoned')
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
}

/** Every session Director has ever seen for a room, including abandoned ones. */
function roomSessions(state: DirectorState, roomId: DirectorId | null): QbtcpRoomSession[] {
  if (!roomId) return [];
  return state.qbtcpSessions.filter((session) => session.roomId === roomId);
}

export function deriveGameDeliveryIntent(state: DirectorState, game: ScheduledGame): DerivedDeliveryIntent {
  const explicit = sanitizeDeliveryIntent(game.deliveryIntent);
  const hasExplicit =
    explicit !== undefined && (explicit.primary !== undefined || (explicit.fallbacks?.length ?? 0) > 0);
  const live = liveRoomSessions(state, game.roomId);
  const fallback = roundDefault(state, game);
  return {
    primary: explicit?.primary ?? (live.length > 0 ? 'qbtcp' : (fallback ?? 'manual')),
    fallbacks: explicit?.fallbacks ?? [],
    source: hasExplicit ? 'explicit' : live.length > 0 ? 'session' : fallback ? 'round-default' : 'manual',
  };
}

function fileTransfersForGame(state: DirectorState, gameId: DirectorId): AssignmentTransfer[] {
  return state.transfers.assignments
    .filter(
      (transfer) =>
        transfer.scheduledGameId === gameId &&
        transfer.status === 'written' &&
        FILE_TRANSPORTS.has(transfer.transportKind),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function qbtcpDelivered(state: DirectorState, gameId: DirectorId): boolean {
  if (
    state.transfers.assignments.some(
      (transfer) => transfer.scheduledGameId === gameId && transfer.transportKind === 'qbtcp',
    )
  ) {
    return true;
  }
  // A session that reached the room proves the assignment escaped Director
  // over QBTCP even without a separate transfer record.
  const game = state.scheduledGames.find((entry) => entry.id === gameId);
  return roomSessions(state, game?.roomId ?? null).some(
    (session) =>
      session.state === 'assigned' || session.state === 'live' || session.state === 'result-received',
  );
}

export function deriveAssignmentReadiness(
  state: DirectorState,
  game: ScheduledGame,
  intent: DerivedDeliveryIntent = deriveGameDeliveryIntent(state, game),
): GameAssignmentReadiness {
  const fileHistory = fileTransfersForGame(state, game.id);
  const latestFile = fileHistory[0];
  const backupCurrent =
    intent.primary !== 'file' && latestFile?.assignmentRevision === game.assignmentRevision;
  const backupStale =
    intent.primary !== 'file' &&
    latestFile !== undefined &&
    latestFile.assignmentRevision !== game.assignmentRevision;
  const live = liveRoomSessions(state, game.roomId);

  if (intent.primary === 'manual') {
    return { state: 'manual', backupCurrent, backupStale };
  }
  if (intent.primary === 'file') {
    if (!latestFile) {
      return { state: 'file-needed', backupCurrent: false, backupStale: false };
    }
    if (latestFile.assignmentRevision !== game.assignmentRevision) {
      return {
        state: 'needs-reprepare',
        message: `The prepared file is from assignment revision ${latestFile.assignmentRevision}; the live assignment is revision ${game.assignmentRevision}.`,
        backupCurrent: false,
        backupStale: false,
      };
    }
    return { state: 'file-current', backupCurrent: false, backupStale: false };
  }
  // QBTCP primary.
  if (live.length > 0) {
    const session = live[0]!;
    if (session.state === 'result-received' || session.resultReceived) {
      return {
        state: 'qbtcp-connected',
        message: 'The scorer is connected and the result has arrived.',
        backupCurrent,
        backupStale,
      };
    }
    return {
      state: 'qbtcp-connected',
      message:
        session.state === 'live'
          ? 'The scorer is connected and scoring.'
          : 'The scorer is connected and waiting.',
      backupCurrent,
      backupStale,
    };
  }
  if (qbtcpDelivered(state, game.id)) {
    return {
      state: 'qbtcp-delivered',
      message: backupCurrent
        ? 'The session dropped after delivery; a current file backup is prepared.'
        : 'The assignment was delivered, but the session is no longer connected.',
      backupCurrent,
      backupStale,
    };
  }
  return {
    state: 'problem',
    message: backupCurrent
      ? 'No live QBTCP session, but a current file backup is prepared.'
      : 'No live QBTCP session for this room.',
    backupCurrent,
    backupStale,
  };
}

function scoreLineForRecord(
  state: DirectorState,
  record: GameRecord,
  game: ScheduledGame,
): string | undefined {
  const scoreFor = (teamId: DirectorId | null) =>
    teamId ? (record.scores.find((entry) => entry.teamId === teamId)?.score ?? null) : null;
  const left = scoreFor(game.leftTeamId);
  const right = scoreFor(game.rightTeamId);
  if (left === null || right === null) return undefined;
  return `${teamName(state, game.leftTeamId)} ${left} – ${teamName(state, game.rightTeamId)} ${right}`;
}

export function deriveGameResultStatus(state: DirectorState, game: ScheduledGame): GameResultStatus {
  const recordById = new Map(state.games.map((record) => [record.id, record]));
  const submissions = state.submissions.filter(
    (submission) =>
      submission.status !== 'superseded' && recordById.get(submission.gameId)?.scheduledGameId === game.id,
  );
  const acceptedRecord = state.games.find(
    (record) => record.scheduledGameId === game.id && record.status === 'accepted',
  );
  if (acceptedRecord) {
    return {
      state: 'accepted',
      submissionId: submissions.find((submission) => submission.status === 'accepted')?.id,
      scoreLine: scoreLineForRecord(state, acceptedRecord, game),
      sourceLabel: sourceLabelForSubmissions(state, submissions),
    };
  }
  const ordered = [...submissions].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  const current = ordered[0];
  if (!current) return { state: 'waiting' };
  if (ordered.some((submission) => submission.conflictWith)) {
    return { state: 'conflict', ...resultContext(state, ordered, current) };
  }
  if (current.status === 'review') return { state: 'review', ...resultContext(state, ordered, current) };
  if (current.status === 'rejected' && ordered.every((submission) => submission.status === 'rejected')) {
    return { state: 'rejected', ...resultContext(state, ordered, current) };
  }
  if (current.status === 'duplicate' && ordered.every((submission) => submission.status === 'duplicate')) {
    return { state: 'duplicate', ...resultContext(state, ordered, current) };
  }
  return { state: 'received', ...resultContext(state, ordered, current) };
}

function resultContext(
  state: DirectorState,
  submissions: ResultSubmission[],
  current: ResultSubmission,
): Pick<GameResultStatus, 'submissionId' | 'artifactId' | 'sourceLabel'> {
  const artifact = state.transfers.artifacts.find((entry) => entry.submissionId === current.id);
  return {
    submissionId: current.id,
    ...(artifact ? { artifactId: artifact.id } : {}),
    sourceLabel: sourceLabelForSubmissions(state, submissions, artifact?.sourceLabel),
  };
}

function sourceLabelForSubmissions(
  state: DirectorState,
  submissions: ResultSubmission[],
  preferred?: string,
): string | undefined {
  if (preferred) return preferred;
  const artifact = submissions
    .map((submission) => state.transfers.artifacts.find((entry) => entry.submissionId === submission.id))
    .find((entry) => entry !== undefined);
  if (artifact) return artifact.sourceLabel;
  // QBTCP returns arrive as submissions tied to a room session, not files.
  if (submissions.some((submission) => submission.sessionId)) return 'via QBTCP';
  if (submissions.length > 0) return 'imported file';
  return undefined;
}

export function teamName(state: DirectorState, teamId: DirectorId | null): string {
  if (!teamId) return 'Bye';
  return state.teams.find((team) => team.id === teamId)?.displayName ?? 'Unknown team';
}

export function matchupForGame(state: DirectorState, game: ScheduledGame): string {
  return `${teamName(state, game.leftTeamId)} vs ${teamName(state, game.rightTeamId)}`;
}

function transportNoun(transport: DeliveryTransport): string {
  return transport === 'qbtcp' ? 'QBTCP' : transport === 'file' ? 'file' : 'manual delivery';
}

/** Audit/UI sentence fragment for an explicit intent, e.g. `QBTCP with file fallback`. */
export function describeDeliveryIntent(intent: GameDeliveryIntent): string {
  const clean = sanitizeDeliveryIntent(intent);
  const primary = clean?.primary ? transportNoun(clean.primary) : 'derived route';
  const extra = (clean?.fallbacks ?? []).filter((fallback: DeliveryTransport) => fallback !== clean?.primary);
  if (extra.length === 0) return primary;
  return `${primary} with ${extra.map(transportNoun).join(' and ')} fallback`;
}

/** True when preparing a file is the right next action for this game. */
export function gameNeedsFiles(state: DirectorState, game: ScheduledGame): boolean {
  const readiness = deriveAssignmentReadiness(state, game).state;
  return readiness === 'file-needed' || readiness === 'needs-reprepare';
}

export interface CurrentRoundDelivery {
  round: Round | undefined;
  rows: GameDeliveryStatus[];
  needingFiles: GameDeliveryStatus[];
  qbtcpProblem: GameDeliveryStatus[];
  awaitingResult: GameDeliveryStatus[];
  needingReview: GameDeliveryStatus[];
}

/** The primary Delivery page model: one row per non-bye current-round game, gaps first. */
export function deriveCurrentRoundDelivery(state: DirectorState): CurrentRoundDelivery {
  const round = currentOperationalRound(state);
  const games = round
    ? state.scheduledGames.filter(
        (game) => game.roundId === round.id && !game.bye && game.status !== 'cancelled',
      )
    : [];
  const rows = games.map((game) => {
    const intent = deriveGameDeliveryIntent(state, game);
    const assignment = deriveAssignmentReadiness(state, game, intent);
    const result = deriveGameResultStatus(state, game);
    const roomName = game.roomId
      ? (state.rooms.find((room) => room.id === game.roomId)?.name ?? 'Unassigned room')
      : 'No room assigned';
    return {
      scheduledGameId: game.id,
      roundId: game.roundId,
      roomId: game.roomId,
      roomName,
      matchup: matchupForGame(state, game),
      intent,
      assignment,
      result,
      needsFile: assignment.state === 'file-needed' || assignment.state === 'needs-reprepare',
    };
  });
  const rank = (row: GameDeliveryStatus): number => {
    if (row.assignment.state === 'problem') return 0;
    if (row.assignment.state === 'needs-reprepare') return 1;
    if (row.result.state === 'conflict' || row.result.state === 'review') return 2;
    if (row.assignment.state === 'file-needed') return 3;
    return 4;
  };
  rows.sort((a, b) => rank(a) - rank(b) || a.roomName.localeCompare(b.roomName));
  return {
    round,
    rows,
    needingFiles: rows.filter((row) => row.needsFile),
    qbtcpProblem: rows.filter((row) => row.assignment.state === 'problem'),
    awaitingResult: rows.filter((row) => row.result.state === 'waiting'),
    needingReview: rows.filter((row) => row.result.state === 'review' || row.result.state === 'conflict'),
  };
}
