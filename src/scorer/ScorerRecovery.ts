import { IGameSetup } from '../scoring/deriveGame';
import { ProcedureAllowance, ScoreEvent } from '../scoring/ScoreEvents';
import { procedureAllowances } from '../scoring/ProcedureExceptions';
import { IGameDefinition } from '../game/GameDefinition';
import { IGamePackage } from '../game/GamePackage';
import type { IGameSessionHistory } from './GameSession';

export const scorerRecoveryKey = '_yf_scorekeeper_recovery';
/** The current private scorer recovery envelope. */
export const scorerRecoveryVersion = 2;
/** The setup/events-only envelope written before action-level recovery was available. */
export const legacyScorerRecoveryVersion = 1;

export interface IScorerRecoveryPayload {
  version: number;
  setup: IGameSetup;
  events: ScoreEvent[];
  /** Stable, credential-free assignment identity. Absent only in legacy or manual files. */
  identity?: IScorerRecoveryIdentity;
  /** Optional auxiliary action history. The event list remains authoritative. */
  history?: IGameSessionHistory;
}

/** The identity needed to prove that a recovery file belongs to the game on screen. */
export interface IScorerRecoveryIdentity {
  tournamentId?: string;
  matchId?: string;
  roundId?: string;
  assignmentRevision?: number;
  leftTeamId?: string;
  rightTeamId?: string;
  leftTeamName: string;
  rightTeamName: string;
}

export type ScorerRecoveryRejection =
  | 'invalid'
  | 'team-mismatch'
  | 'tournament-id-mismatch'
  | 'match-id-mismatch'
  | 'round-id-mismatch'
  | 'team-id-mismatch';

export type ScorerRecoveryInspection =
  | { kind: 'compatible'; payload: IScorerRecoveryPayload }
  | { kind: 'review-required'; payload: IScorerRecoveryPayload; reason: 'missing-stable-identity' }
  | { kind: 'rejected'; reason: ScorerRecoveryRejection };

export interface ReadScorerRecoveryOptions {
  /** Trusted authenticated session recovery may retain the pre-identity fallback. */
  allowLegacy?: boolean;
}

// Keep historical tossup reading markers parseable; they are not live scoring controls anymore.
const eventTypes = new Set([
  'tossup-buzz',
  'tossup-no-penalty',
  'tossup-reading-resumed',
  'tossup-readout',
  'tossup-dead',
  'bonus',
  'lightning',
  'roster-add',
  'substitution',
  'end-regulation',
  'half-break',
  'half-resume',
  'begin-overtime',
  'begin-sudden-death',
  'timeout',
  'timeout-start',
  'timeout-resume',
  'protest',
  'question-void',
  'end-game-early',
  'adjustment',
  'forfeit',
  'procedure-exception',
  'note',
]);

const protestSubjects = new Set(['tossup-answer', 'bonus-answer', 'question', 'procedure', 'other']);
const procedureAuthorities = new Set(['tournament-director', 'moderator', 'other']);
const protestStatuses = new Set(['open', 'upheld', 'declined', 'withdrawn']);

function validTeam(value: unknown): value is 'left' | 'right' {
  return value === 'left' || value === 'right';
}

function validPlayerList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((name) => typeof name === 'string' && name.trim() !== '') &&
    new Set(value).size === value.length
  );
}

function validStartingLineup(value: unknown, players: string[]): boolean {
  if (value === undefined) return true;
  if (!validPlayerList(value)) return false;
  const lineup = value as string[];
  return new Set(lineup).size === lineup.length && lineup.every((name) => players.includes(name));
}

export function validSetup(value: unknown): value is IGameSetup {
  if (typeof value !== 'object' || value === null) return false;
  const setup = value as Partial<IGameSetup>;
  return (
    typeof setup.left?.name === 'string' &&
    setup.left.name.trim() !== '' &&
    validPlayerList(setup.left.players) &&
    validStartingLineup(setup.left.startingLineup, setup.left.players) &&
    typeof setup.right?.name === 'string' &&
    setup.right.name.trim() !== '' &&
    validPlayerList(setup.right.players) &&
    validStartingLineup(setup.right.startingLineup, setup.right.players)
  );
}

function validBonusPart(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const part = value as Record<string, unknown>;
  if (typeof part.controlledPoints !== 'number' || !Number.isFinite(part.controlledPoints)) return false;
  return (
    part.bouncebackPoints === undefined ||
    (typeof part.bouncebackPoints === 'number' && Number.isFinite(part.bouncebackPoints))
  );
}

export function validEvent(value: unknown): value is ScoreEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== 'string' || !eventTypes.has(String(event.type))) return false;
  if (!Number.isInteger(event.questionNumber) || Number(event.questionNumber) < 1) return false;
  if ('team' in event && !validTeam(event.team)) return false;
  if (event.type === 'tossup-buzz')
    return (
      validTeam(event.team) &&
      typeof event.playerName === 'string' &&
      event.playerName.trim() !== '' &&
      Number.isInteger(event.answerTypeIndex) &&
      Number(event.answerTypeIndex) >= 0
    );
  if (event.type === 'bonus') {
    if (!validTeam(event.team)) return false;
    const totalsValid =
      event.controlledPoints === undefined ||
      (typeof event.controlledPoints === 'number' && Number.isFinite(event.controlledPoints));
    const bouncebackValid =
      event.bouncebackPoints === undefined ||
      (typeof event.bouncebackPoints === 'number' && Number.isFinite(event.bouncebackPoints));
    const partsValid =
      event.parts === undefined ||
      (Array.isArray(event.parts) && event.parts.length > 0 && event.parts.every(validBonusPart));
    return (
      totalsValid &&
      bouncebackValid &&
      partsValid &&
      (event.controlledPoints !== undefined || event.parts !== undefined)
    );
  }
  if (event.type === 'roster-add')
    return validTeam(event.team) && typeof event.playerName === 'string' && event.playerName.trim() !== '';
  if (event.type === 'substitution')
    return (
      validTeam(event.team) &&
      Array.isArray(event.activePlayers) &&
      event.activePlayers.length > 0 &&
      new Set(event.activePlayers).size === event.activePlayers.length &&
      event.activePlayers.every((name) => typeof name === 'string' && name.trim() !== '')
    );
  if (event.type === 'forfeit')
    return Array.isArray(event.teams) && event.teams.every((team) => team === 'left' || team === 'right');
  if (event.type === 'note') return typeof event.text === 'string';
  if (event.type === 'lightning' || event.type === 'adjustment')
    return validTeam(event.team) && typeof event.points === 'number' && Number.isFinite(event.points);
  // The player is optional: the event is about the team's opportunity, not about a buzz.
  if (event.type === 'tossup-no-penalty')
    return (
      validTeam(event.team) &&
      (event.playerName === undefined ||
        (typeof event.playerName === 'string' && event.playerName.trim() !== ''))
    );
  if (event.type === 'end-regulation')
    return (
      event.lastRegulationQuestion === undefined ||
      (Number.isInteger(event.lastRegulationQuestion) && Number(event.lastRegulationQuestion) >= 0)
    );
  if (event.type === 'half-break')
    return Number.isInteger(event.lastQuestion) && Number(event.lastQuestion) >= 0;
  if (event.type === 'timeout') return validTeam(event.team);
  if (event.type === 'timeout-start') {
    return (
      validTeam(event.team) &&
      (event.startedAt === undefined ||
        (typeof event.startedAt === 'number' && Number.isFinite(event.startedAt) && event.startedAt >= 0))
    );
  }
  if (
    event.type === 'timeout-resume' ||
    event.type === 'begin-overtime' ||
    event.type === 'begin-sudden-death'
  )
    return true;
  if (event.type === 'protest')
    return (
      validTeam(event.team) &&
      protestSubjects.has(String(event.subject)) &&
      protestStatuses.has(String(event.status)) &&
      typeof event.description === 'string' &&
      (event.resolution === undefined || typeof event.resolution === 'string')
    );
  if (event.type === 'question-void')
    return (event.scope === 'tossup' || event.scope === 'bonus') && typeof event.reason === 'string';
  if (event.type === 'end-game-early')
    return (
      typeof event.reason === 'string' &&
      Number.isInteger(event.tossupsRead) &&
      Number(event.tossupsRead) >= 0
    );
  if (event.type === 'procedure-exception')
    return (
      procedureAllowances.includes(event.allowance as ProcedureAllowance) &&
      procedureAuthorities.has(String(event.authority)) &&
      typeof event.reason === 'string' &&
      event.reason.trim() !== '' &&
      (event.playerName === undefined ||
        (typeof event.playerName === 'string' && event.playerName.trim() !== ''))
    );
  return true;
}

/**
 * Read action-level metadata without turning it into a second event journal.
 *
 * This deliberately follows the best-effort shape checks used by GameSession and QBSheetBackup:
 * an invalid stack is dropped, while a usable sibling stack can still be retained. Format-aware
 * redo validation belongs to useGameEvents, which has the scoring format needed to reject a frame
 * that is structurally valid but impossible to replay. Nothing here derives or repairs frames.
 */
function readRecoveryHistory(value: unknown, events: ScoreEvent[]): IGameSessionHistory | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const history = value as Partial<IGameSessionHistory>;
  const undo =
    Array.isArray(history.undo) &&
    history.undo.every((frame) => typeof frame === 'number' && Number.isInteger(frame) && frame > 0) &&
    history.undo.reduce((sum, frame) => sum + frame, 0) <= events.length
      ? history.undo.slice()
      : [];
  const redo =
    Array.isArray(history.redo) &&
    history.redo.every(
      (frame) => Array.isArray(frame) && frame.length > 0 && frame.every((event) => validEvent(event)),
    )
      ? history.redo.map((frame) => frame.map((event) => ({ ...event })))
      : [];
  return undo.length > 0 || redo.length > 0 ? { undo, redo } : undefined;
}

function cloneRecoveryHistory(
  history: IGameSessionHistory | undefined,
  events: ScoreEvent[],
): IGameSessionHistory | undefined {
  return readRecoveryHistory(history, events);
}

const recoverySecretKeys = new Set([
  'accesstoken',
  'token',
  'sessiontoken',
  'sessionid',
  'sessioncredentials',
  'roomtoken',
  'pairingcode',
  'deviceid',
  'authorization',
  'credentials',
  'secret',
]);

function stripRecoverySecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripRecoverySecrets(entry));
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (recoverySecretKeys.has(key.replace(/[-_\s]/g, '').toLowerCase())) continue;
    output[key] = stripRecoverySecrets(entry);
  }
  return output;
}

function identityText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 500 ? value : undefined;
}

function readRecoveryIdentity(value: unknown): IScorerRecoveryIdentity | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) return null;
  const identity = value as Partial<IScorerRecoveryIdentity>;
  const leftTeamName = identityText(identity.leftTeamName);
  const rightTeamName = identityText(identity.rightTeamName);
  if (!leftTeamName || !rightTeamName) return null;
  const result: IScorerRecoveryIdentity = { leftTeamName, rightTeamName };
  for (const field of ['tournamentId', 'matchId', 'roundId', 'leftTeamId', 'rightTeamId'] as const) {
    const next = identityText(identity[field]);
    if (identity[field] !== undefined && next === undefined) return null;
    if (next !== undefined) result[field] = next;
  }
  if (
    identity.assignmentRevision !== undefined &&
    (!Number.isInteger(identity.assignmentRevision) || Number(identity.assignmentRevision) < 1)
  )
    return null;
  if (identity.assignmentRevision !== undefined) result.assignmentRevision = identity.assignmentRevision;
  return result;
}

/** Build the recovery identity from the assignment fields already carried by the scorer. */
export function scorerRecoveryIdentity(
  gamePackage: IGamePackage | IGameDefinition | undefined,
  setup: IGameSetup,
): IScorerRecoveryIdentity {
  const definition = gamePackage as (IGameDefinition & Partial<IGamePackage>) | undefined;
  const qbjIdentity = definition?.qbjIdentity;
  return {
    leftTeamName: setup.left.name,
    rightTeamName: setup.right.name,
    ...((qbjIdentity?.tournamentId ?? definition?.tournament.key)
      ? { tournamentId: qbjIdentity?.tournamentId ?? definition?.tournament.key }
      : {}),
    ...((qbjIdentity?.matchId ?? definition?.scheduledMatchId)
      ? { matchId: qbjIdentity?.matchId ?? definition?.scheduledMatchId }
      : {}),
    ...(qbjIdentity?.roundId ? { roundId: qbjIdentity.roundId } : {}),
    ...(definition?.round.assignmentRevision !== undefined
      ? { assignmentRevision: definition.round.assignmentRevision }
      : {}),
    ...(qbjIdentity?.teamIds?.left ? { leftTeamId: qbjIdentity.teamIds.left } : {}),
    ...(qbjIdentity?.teamIds?.right ? { rightTeamId: qbjIdentity.teamIds.right } : {}),
  };
}

/** Add an exact, credential-free recovery layer to an otherwise ordinary QBJ match. */
export function attachScorerRecovery(
  qbj: object,
  setup: IGameSetup,
  events: ScoreEvent[],
  history?: IGameSessionHistory,
  identity?: IScorerRecoveryIdentity,
): object {
  const safeSetup = stripRecoverySecrets(setup) as IGameSetup;
  const safeEvents = stripRecoverySecrets(events) as ScoreEvent[];
  const recoveryHistory = cloneRecoveryHistory(history, safeEvents);
  const recoveryIdentity = readRecoveryIdentity(identity);
  return {
    ...(stripRecoverySecrets(qbj) as object),
    [scorerRecoveryKey]: {
      version: scorerRecoveryVersion,
      setup: safeSetup,
      events: safeEvents,
      ...(recoveryIdentity ? { identity: recoveryIdentity } : {}),
      ...(recoveryHistory ? { history: recoveryHistory } : {}),
    },
  };
}

function expectedIdentity(value: IScorerRecoveryIdentity | IGameSetup): IScorerRecoveryIdentity {
  if ('leftTeamName' in value) return value;
  return {
    leftTeamName: value.left.name,
    rightTeamName: value.right.name,
  };
}

/** Inspect a recovery file without silently upgrading an unprovable legacy match to safe status. */
export function inspectScorerRecovery(
  value: unknown,
  expectedValue: IScorerRecoveryIdentity | IGameSetup,
): ScorerRecoveryInspection {
  const expected = expectedIdentity(expectedValue);
  if (typeof value !== 'object' || value === null) return { kind: 'rejected', reason: 'invalid' };
  const payload = (value as Record<string, unknown>)[scorerRecoveryKey] as
    Partial<IScorerRecoveryPayload> | undefined;
  if (!payload) return { kind: 'rejected', reason: 'invalid' };
  const version = payload.version;
  if (
    (version !== scorerRecoveryVersion && version !== legacyScorerRecoveryVersion) ||
    !Array.isArray(payload.events)
  )
    return { kind: 'rejected', reason: 'invalid' };
  if (!payload.events.every(validEvent) || !validSetup(payload.setup))
    return { kind: 'rejected', reason: 'invalid' };
  const identity = readRecoveryIdentity(payload.identity);
  if (identity === null) return { kind: 'rejected', reason: 'invalid' };
  if (
    payload.setup.left.name !== expected.leftTeamName ||
    payload.setup.right.name !== expected.rightTeamName
  )
    return { kind: 'rejected', reason: 'team-mismatch' };

  if (identity) {
    if (expected.tournamentId && identity.tournamentId && expected.tournamentId !== identity.tournamentId)
      return { kind: 'rejected', reason: 'tournament-id-mismatch' };
    if (expected.matchId && identity.matchId && expected.matchId !== identity.matchId)
      return { kind: 'rejected', reason: 'match-id-mismatch' };
    if (expected.roundId && identity.roundId && expected.roundId !== identity.roundId)
      return { kind: 'rejected', reason: 'round-id-mismatch' };
    if (expected.leftTeamId && identity.leftTeamId && expected.leftTeamId !== identity.leftTeamId)
      return { kind: 'rejected', reason: 'team-id-mismatch' };
    if (expected.rightTeamId && identity.rightTeamId && expected.rightTeamId !== identity.rightTeamId)
      return { kind: 'rejected', reason: 'team-id-mismatch' };
  }

  const history =
    version === scorerRecoveryVersion ? readRecoveryHistory(payload.history, payload.events) : undefined;
  const recovered: IScorerRecoveryPayload = {
    version,
    setup: payload.setup,
    events: payload.events,
    ...(identity ? { identity } : {}),
    ...(history ? { history } : {}),
  };

  // A scheduled match id is the proof that separates a rematch from the first meeting.
  if (!identity || !expected.matchId || !identity.matchId) {
    return { kind: 'review-required', payload: recovered, reason: 'missing-stable-identity' };
  }
  return { kind: 'compatible', payload: recovered };
}

/** Read only backups created by this scorer, and only when they belong to the game on screen. */
export function readScorerRecovery(
  value: unknown,
  expected: IScorerRecoveryIdentity | IGameSetup,
  options: ReadScorerRecoveryOptions = {},
): IScorerRecoveryPayload | null {
  const inspected = inspectScorerRecovery(value, expected);
  if (inspected.kind === 'compatible') return inspected.payload;
  if (inspected.kind === 'review-required' && options.allowLegacy) return inspected.payload;
  return null;
}
