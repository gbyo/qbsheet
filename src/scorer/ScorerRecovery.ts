import { IGameSetup } from '../scoring/deriveGame';
import { ProcedureAllowance, ScoreEvent } from '../scoring/ScoreEvents';
import { procedureAllowances } from '../scoring/ProcedureExceptions';
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
  /** Optional auxiliary action history. The event list remains authoritative. */
  history?: IGameSessionHistory;
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
    value.every((name) => typeof name === 'string' && name.trim() !== '')
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

/** Add an exact, credential-free recovery layer to an otherwise ordinary QBJ match. */
export function attachScorerRecovery(
  qbj: object,
  setup: IGameSetup,
  events: ScoreEvent[],
  history?: IGameSessionHistory,
): object {
  const recoveryHistory = cloneRecoveryHistory(history, events);
  return {
    ...qbj,
    [scorerRecoveryKey]: {
      version: scorerRecoveryVersion,
      setup,
      events,
      ...(recoveryHistory ? { history: recoveryHistory } : {}),
    },
  };
}

/** Read only backups created by this scorer, and only when they belong to the game on screen. */
export function readScorerRecovery(
  value: unknown,
  expected: { left: { name: string }; right: { name: string } },
): IScorerRecoveryPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const payload = (value as Record<string, unknown>)[scorerRecoveryKey] as
    Partial<IScorerRecoveryPayload> | undefined;
  if (!payload) return null;
  const version = payload.version;
  if (
    (version !== scorerRecoveryVersion && version !== legacyScorerRecoveryVersion) ||
    !Array.isArray(payload.events)
  )
    return null;
  if (!payload.events.every(validEvent)) return null;
  if (!validSetup(payload.setup)) return null;
  if (payload.setup.left.name !== expected.left.name || payload.setup.right.name !== expected.right.name)
    return null;
  const history =
    version === scorerRecoveryVersion ? readRecoveryHistory(payload.history, payload.events) : undefined;
  return {
    version,
    setup: payload.setup,
    events: payload.events,
    ...(history ? { history } : {}),
  };
}
