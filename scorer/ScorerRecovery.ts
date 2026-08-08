import { IGameSetup } from '../scoring/deriveGame';
import { ScoreEvent } from '../scoring/ScoreEvents';

export const scorerRecoveryKey = '_yf_scorekeeper_recovery';
export const scorerRecoveryVersion = 1;

export interface IScorerRecoveryPayload {
  version: number;
  setup: IGameSetup;
  events: ScoreEvent[];
}

const eventTypes = new Set([
  'tossup-buzz',
  'tossup-no-penalty',
  'tossup-dead',
  'bonus',
  'lightning',
  'roster-add',
  'substitution',
  'end-regulation',
  'half-break',
  'half-resume',
  'timeout',
  'protest',
  'question-void',
  'end-game-early',
  'adjustment',
  'forfeit',
  'note',
]);

const protestSubjects = new Set(['tossup-answer', 'bonus-answer', 'question', 'procedure', 'other']);
const protestStatuses = new Set(['open', 'upheld', 'declined', 'withdrawn']);

function validTeam(value: unknown): value is 'left' | 'right' {
  return value === 'left' || value === 'right';
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
    return validTeam(event.team) && typeof event.playerName === 'string' && Number.isInteger(event.answerTypeIndex);
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
      event.activePlayers.every((name) => typeof name === 'string' && name.trim() !== '')
    );
  if (event.type === 'forfeit')
    return Array.isArray(event.teams) && event.teams.every((team) => team === 'left' || team === 'right');
  if (event.type === 'note') return typeof event.text === 'string';
  if (event.type === 'lightning' || event.type === 'adjustment')
    return validTeam(event.team) && typeof event.points === 'number' && Number.isFinite(event.points);
  // The player is optional: the event is about the team's opportunity, not about a buzz.
  if (event.type === 'tossup-no-penalty')
    return validTeam(event.team) && (event.playerName === undefined || typeof event.playerName === 'string');
  if (event.type === 'end-regulation')
    return (
      event.lastRegulationQuestion === undefined ||
      (Number.isInteger(event.lastRegulationQuestion) && Number(event.lastRegulationQuestion) >= 0)
    );
  if (event.type === 'half-break') return Number.isInteger(event.lastQuestion) && Number(event.lastQuestion) >= 0;
  if (event.type === 'timeout') return validTeam(event.team);
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
    return typeof event.reason === 'string' && Number.isInteger(event.tossupsRead) && Number(event.tossupsRead) >= 0;
  return true;
}

/** Add an exact, credential-free recovery layer to an otherwise ordinary QBJ match. */
export function attachScorerRecovery(qbj: object, setup: IGameSetup, events: ScoreEvent[]): object {
  return {
    ...qbj,
    [scorerRecoveryKey]: {
      version: scorerRecoveryVersion,
      setup,
      events,
    },
  };
}

/** Read only backups created by this scorer, and only when they belong to the game on screen. */
export function readScorerRecovery(
  value: unknown,
  expected: { left: { name: string }; right: { name: string } },
): IScorerRecoveryPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const payload = (value as Record<string, unknown>)[scorerRecoveryKey] as Partial<IScorerRecoveryPayload> | undefined;
  if (payload?.version !== scorerRecoveryVersion || !Array.isArray(payload.events)) return null;
  if (!payload.events.every(validEvent)) return null;
  if (!payload.setup?.left?.name || !payload.setup?.right?.name) return null;
  if (!Array.isArray(payload.setup.left.players) || !Array.isArray(payload.setup.right.players)) return null;
  if (payload.setup.left.name !== expected.left.name || payload.setup.right.name !== expected.right.name) return null;
  return {
    version: scorerRecoveryVersion,
    setup: payload.setup,
    events: payload.events,
  };
}
