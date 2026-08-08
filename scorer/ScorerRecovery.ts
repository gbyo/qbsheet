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
  'tossup-dead',
  'bonus',
  'lightning',
  'roster-add',
  'substitution',
  'end-regulation',
  'adjustment',
  'forfeit',
  'note',
]);

function validEvent(value: unknown): value is ScoreEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== 'string' || !eventTypes.has(String(event.type))) return false;
  if (!Number.isInteger(event.questionNumber) || Number(event.questionNumber) < 1) return false;
  if ('team' in event && event.team !== 'left' && event.team !== 'right') return false;
  if (event.type === 'tossup-buzz')
    return typeof event.playerName === 'string' && Number.isInteger(event.answerTypeIndex);
  if (event.type === 'roster-add') return typeof event.playerName === 'string' && event.playerName.trim() !== '';
  if (event.type === 'substitution')
    return Array.isArray(event.activePlayers) && event.activePlayers.every((name) => typeof name === 'string');
  if (event.type === 'forfeit')
    return Array.isArray(event.teams) && event.teams.every((team) => team === 'left' || team === 'right');
  if (event.type === 'note') return typeof event.text === 'string';
  if (event.type === 'lightning' || event.type === 'adjustment') return Number.isFinite(event.points);
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
