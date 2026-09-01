import type {
  EntityId,
  GameResult,
  JsonValue,
  Player,
  ResultIssue,
  ResultSource,
  ResultSubmission,
  ScheduledGame,
  SubmittedResultPayload,
  Team,
  TeamGameStat,
  PlayerGameStat,
} from './model';
import { DomainError as TournamentDomainError, newEntityId, systemClock } from './model';

export interface ResultValidationContext {
  readonly scheduledGames: readonly ScheduledGame[];
  readonly teams: readonly Team[];
  readonly players?: readonly Player[];
  readonly packetIds?: readonly EntityId[];
  readonly existingFingerprints?: readonly string[];
}

export interface ResultValidationReport {
  readonly issues: readonly ResultIssue[];
  readonly clean: boolean;
}

export interface TeamGameStatInput extends Partial<Omit<TeamGameStat, 'teamId'>> {
  readonly teamId: EntityId;
}

export interface PlayerGameStatInput extends Partial<Omit<PlayerGameStat, 'playerId' | 'teamId'>> {
  readonly playerId: EntityId;
  readonly teamId: EntityId;
}

export function makeTeamGameStat(input: TeamGameStatInput): TeamGameStat {
  return {
    teamId: input.teamId,
    score: input.score ?? 0,
    tossupsHeard: input.tossupsHeard ?? 0,
    powers: input.powers ?? 0,
    gets: input.gets ?? 0,
    negs: input.negs ?? 0,
    bonusesHeard: input.bonusesHeard ?? 0,
    bonusPoints: input.bonusPoints ?? 0,
    bouncebacks: input.bouncebacks ?? 0,
    lightningPoints: input.lightningPoints ?? 0,
    overtimePoints: input.overtimePoints ?? 0,
  };
}

export function makePlayerGameStat(input: PlayerGameStatInput): PlayerGameStat {
  return {
    playerId: input.playerId,
    teamId: input.teamId,
    tossupsHeard: input.tossupsHeard ?? 0,
    powers: input.powers ?? 0,
    gets: input.gets ?? 0,
    negs: input.negs ?? 0,
    bonusesHeard: input.bonusesHeard ?? 0,
    bonusPoints: input.bonusPoints ?? 0,
    bouncebacks: input.bouncebacks ?? 0,
    points: input.points ?? 0,
    notes: input.notes?.trim() ?? '',
  };
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function stableResultValue(payload: SubmittedResultPayload): unknown {
  return canonicalize({
    ...payload,
    teamScores: [...payload.teamScores].sort((left, right) => left.teamId.localeCompare(right.teamId)),
    playerStats: [...payload.playerStats].sort((left, right) => left.playerId.localeCompare(right.playerId)),
  });
}

/** A deterministic, dependency-free fingerprint for duplicate submission detection. */
export function fingerprintResult(payload: SubmittedResultPayload): string {
  const text = JSON.stringify(stableResultValue(payload));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function resultIssue(
  code: string,
  severity: ResultIssue['severity'],
  message: string,
  entityIds: readonly EntityId[] = [],
): ResultIssue {
  return { code, severity, message, entityIds };
}

function numericIssues(payload: SubmittedResultPayload): ResultIssue[] {
  const issues: ResultIssue[] = [];
  for (const score of payload.teamScores) {
    const fields: readonly (keyof Omit<TeamGameStat, 'teamId'>)[] = [
      'score',
      'tossupsHeard',
      'powers',
      'gets',
      'negs',
      'bonusesHeard',
      'bonusPoints',
      'bouncebacks',
      'lightningPoints',
      'overtimePoints',
    ];
    for (const field of fields) {
      if (!isFiniteNonNegative(score[field])) {
        issues.push(
          resultIssue('invalid-statistic', 'error', `Team ${field} must be a non-negative finite number.`, [
            score.teamId,
          ]),
        );
      }
    }
  }
  for (const stat of payload.playerStats) {
    const fields: readonly (keyof Omit<PlayerGameStat, 'playerId' | 'teamId' | 'notes'>)[] = [
      'tossupsHeard',
      'powers',
      'gets',
      'negs',
      'bonusesHeard',
      'bonusPoints',
      'bouncebacks',
      'points',
    ];
    for (const field of fields) {
      if (!isFiniteNonNegative(stat[field])) {
        issues.push(
          resultIssue('invalid-statistic', 'error', `Player ${field} must be a non-negative finite number.`, [
            stat.playerId,
          ]),
        );
      }
    }
  }
  return issues;
}

/** Validate a result against the expected scheduled game before it can be accepted. */
export function validateResultSubmission(
  payload: SubmittedResultPayload,
  context: ResultValidationContext,
): ResultValidationReport {
  const issues: ResultIssue[] = [];
  const scheduledGame = context.scheduledGames.find((game) => game.id === payload.scheduledGameId);
  const teamById = new Map(context.teams.map((team) => [team.id, team]));

  if (!scheduledGame) {
    issues.push(
      resultIssue('unknown-game', 'error', `Scheduled game “${payload.scheduledGameId}” does not exist.`, [
        payload.scheduledGameId,
      ]),
    );
    return { issues: [...issues, ...numericIssues(payload)], clean: false };
  }
  if (scheduledGame.kind === 'bye') {
    issues.push(
      resultIssue('bye-cannot-submit', 'error', 'A bye does not accept a game result.', [
        scheduledGame.id,
        scheduledGame.byeTeamId,
      ]),
    );
  } else {
    if (payload.phaseId !== scheduledGame.phaseId) {
      issues.push(
        resultIssue('phase-mismatch', 'error', 'The submitted phase does not match the assignment.', [
          scheduledGame.id,
        ]),
      );
    }
    if (payload.roundId !== scheduledGame.roundId) {
      issues.push(
        resultIssue('round-mismatch', 'error', 'The submitted round does not match the assignment.', [
          scheduledGame.id,
        ]),
      );
    }
    if (scheduledGame.roomId && payload.roomId !== scheduledGame.roomId) {
      issues.push(
        resultIssue(
          'room-mismatch',
          'error',
          'The submission came from a different room than the assignment.',
          [scheduledGame.id, scheduledGame.roomId, payload.roomId ?? ''],
        ),
      );
    }
    if (scheduledGame.packetId && payload.packetId !== scheduledGame.packetId) {
      issues.push(
        resultIssue(
          'packet-mismatch',
          'error',
          'The submission references a different packet than the assignment.',
          [scheduledGame.id, scheduledGame.packetId, payload.packetId ?? ''],
        ),
      );
    }
    const expectedTeams = new Set([scheduledGame.teamAId, scheduledGame.teamBId]);
    const submittedTeams = payload.teamScores.map((score) => score.teamId);
    if (
      payload.teamScores.length !== 2 ||
      new Set(submittedTeams).size !== submittedTeams.length ||
      submittedTeams.some((teamId) => !expectedTeams.has(teamId))
    ) {
      issues.push(
        resultIssue(
          'team-mismatch',
          'error',
          'The result must contain exactly the two teams assigned to the game.',
          [scheduledGame.id, ...submittedTeams],
        ),
      );
    }
  }

  for (const score of payload.teamScores) {
    if (!teamById.has(score.teamId)) {
      issues.push(
        resultIssue('unknown-team', 'error', `Team “${score.teamId}” does not exist.`, [score.teamId]),
      );
    }
  }
  if (new Set(payload.teamScores.map((score) => score.teamId)).size !== payload.teamScores.length) {
    issues.push(
      resultIssue(
        'duplicate-team-score',
        'error',
        'A result cannot contain duplicate team score lines.',
        payload.teamScores.map((score) => score.teamId),
      ),
    );
  }
  if (new Set(payload.playerStats.map((stat) => stat.playerId)).size !== payload.playerStats.length) {
    issues.push(
      resultIssue(
        'duplicate-player-stat',
        'error',
        'A result cannot contain duplicate player stat lines.',
        payload.playerStats.map((stat) => stat.playerId),
      ),
    );
  }
  if (context.players) {
    const playerById = new Map(context.players.map((player) => [player.id, player]));
    for (const stat of payload.playerStats) {
      const player = playerById.get(stat.playerId);
      if (!player) {
        issues.push(
          resultIssue('unknown-player', 'error', `Player “${stat.playerId}” does not exist.`, [
            stat.playerId,
          ]),
        );
      } else if (player.teamId !== stat.teamId) {
        issues.push(
          resultIssue(
            'player-team-mismatch',
            'error',
            `Player “${player.name}” is not registered to the submitted team.`,
            [player.id, stat.teamId],
          ),
        );
      }
    }
  }
  if (context.packetIds && payload.packetId && !context.packetIds.includes(payload.packetId)) {
    issues.push(
      resultIssue('unknown-packet', 'error', `Packet “${payload.packetId}” does not exist.`, [
        payload.packetId,
      ]),
    );
  }
  if (context.existingFingerprints?.includes(fingerprintResult(payload))) {
    issues.push(
      resultIssue(
        'duplicate-submission',
        'warning',
        'An identical result submission has already been received.',
        [payload.scheduledGameId],
      ),
    );
  }
  if (
    payload.outcome === 'cancelled' &&
    payload.teamScores.some((score) => score.score !== 0 || score.tossupsHeard !== 0)
  ) {
    issues.push(
      resultIssue(
        'cancelled-with-stats',
        'warning',
        'A cancelled game includes scoring statistics; review before acceptance.',
        [payload.scheduledGameId],
      ),
    );
  }
  issues.push(...numericIssues(payload));
  const errors = issues.some((current) => current.severity === 'error');
  return { issues, clean: !errors && issues.length === 0 };
}

export interface CreateResultSubmissionInput {
  readonly id?: EntityId;
  readonly receivedAt?: string;
  readonly source: ResultSource;
  readonly sessionId?: EntityId | null;
  readonly roomId?: EntityId | null;
  readonly clientId?: string | null;
  readonly rawPayload?: JsonValue;
  readonly payload: SubmittedResultPayload;
}

export function createResultSubmission(
  input: CreateResultSubmissionInput,
  context: ResultValidationContext,
): ResultSubmission {
  const issues = validateResultSubmission(input.payload, context).issues;
  const fingerprint = fingerprintResult(input.payload);
  const duplicate = issues.some((current) => current.code === 'duplicate-submission');
  const hasErrors = issues.some((current) => current.severity === 'error');
  return {
    id: input.id ?? newEntityId('submission'),
    receivedAt: input.receivedAt ?? systemClock.now(),
    source: input.source,
    sessionId: input.sessionId ?? null,
    roomId: input.roomId ?? null,
    clientId: input.clientId?.trim() || null,
    fingerprint,
    rawPayload: input.rawPayload ?? (input.payload as unknown as JsonValue),
    payload: input.payload,
    issues,
    status: duplicate ? 'duplicate' : hasErrors || issues.length > 0 ? 'review' : 'clean',
    duplicateOfSubmissionId: null,
    acceptedResultId: null,
  };
}

export interface AcceptedResult {
  readonly submission: ResultSubmission;
  readonly result: GameResult;
}

export function acceptResultSubmission(
  submission: ResultSubmission,
  acceptedBy: string,
  options: { readonly id?: EntityId; readonly acceptedAt?: string; readonly overrideReason?: string } = {},
): AcceptedResult {
  const errors = submission.issues.filter((current) => current.severity === 'error');
  if (errors.length > 0) {
    throw new TournamentDomainError(
      `Cannot accept result: ${errors.map((current) => current.message).join(' ')}`,
      'result-has-errors',
    );
  }
  if (submission.status === 'duplicate') {
    throw new TournamentDomainError('Cannot accept a duplicate result submission.', 'duplicate-result');
  }
  const normalizedActor = acceptedBy.trim();
  if (!normalizedActor)
    throw new TournamentDomainError('An accepting operator is required.', 'missing-actor');
  if (submission.issues.length > 0 && !options.overrideReason?.trim()) {
    throw new TournamentDomainError(
      'A reviewed result needs an explicit acceptance note.',
      'missing-acceptance-note',
    );
  }
  const acceptedAt = options.acceptedAt ?? systemClock.now();
  const result: GameResult = {
    ...submission.payload,
    id: options.id ?? newEntityId('result'),
    fingerprint: submission.fingerprint,
    source: submission.source,
    receivedAt: submission.receivedAt,
    acceptedAt,
    acceptedBy: normalizedActor,
    reviewStatus: 'accepted',
    revision: 1,
    originalSubmissionId: submission.id,
    supersedesResultId: null,
  };
  return {
    submission: { ...submission, status: 'accepted', acceptedResultId: result.id },
    result,
  };
}

export interface ResultRevisionInput {
  readonly id?: EntityId;
  readonly source?: ResultSource;
  readonly revisedAt?: string;
  readonly revisedBy: string;
  readonly reason: string;
}

/** Create a pending correction while retaining the original accepted result as history. */
export function reviseAcceptedResult(
  previous: GameResult,
  changes: Partial<SubmittedResultPayload>,
  input: ResultRevisionInput,
): GameResult {
  if (previous.reviewStatus !== 'accepted') {
    throw new TournamentDomainError('Only an accepted result can be revised.', 'result-not-accepted');
  }
  if (!input.revisedBy.trim())
    throw new TournamentDomainError('A correcting operator is required.', 'missing-actor');
  if (!input.reason.trim())
    throw new TournamentDomainError('A correction reason is required.', 'missing-correction-reason');
  if (changes.scheduledGameId !== undefined && changes.scheduledGameId !== previous.scheduledGameId) {
    throw new TournamentDomainError(
      'A result correction cannot move a result to another scheduled game.',
      'result-game-change',
    );
  }
  if (changes.phaseId !== undefined && changes.phaseId !== previous.phaseId) {
    throw new TournamentDomainError(
      'A result correction cannot move a result to another phase.',
      'result-phase-change',
    );
  }
  if (changes.roundId !== undefined && changes.roundId !== previous.roundId) {
    throw new TournamentDomainError(
      'A result correction cannot move a result to another round.',
      'result-round-change',
    );
  }
  const payload: SubmittedResultPayload = {
    scheduledGameId: changes.scheduledGameId ?? previous.scheduledGameId,
    phaseId: changes.phaseId ?? previous.phaseId,
    roundId: changes.roundId ?? previous.roundId,
    roomId: changes.roomId === undefined ? previous.roomId : changes.roomId,
    packetId: changes.packetId === undefined ? previous.packetId : changes.packetId,
    outcome: changes.outcome ?? previous.outcome,
    teamScores: changes.teamScores ?? previous.teamScores,
    playerStats: changes.playerStats ?? previous.playerStats,
    notes: changes.notes ?? previous.notes,
  };
  return {
    ...payload,
    id: input.id ?? newEntityId('result'),
    fingerprint: fingerprintResult(payload),
    source: input.source ?? previous.source,
    receivedAt: input.revisedAt ?? systemClock.now(),
    acceptedAt: null,
    acceptedBy: null,
    reviewStatus: 'pending',
    revision: previous.revision + 1,
    originalSubmissionId: previous.originalSubmissionId,
    supersedesResultId: previous.id,
  };
}
