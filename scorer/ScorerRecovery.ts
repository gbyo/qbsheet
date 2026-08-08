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
  'note',
]);

const protestSubjects = new Set(['tossup-answer', 'bonus-answer', 'question', 'procedure', 'other']);
const protestStatuses = new Set(['open', 'upheld', 'declined', 'withdrawn']);

function validTeam(value: unknown): value is 'left' | 'right' {
  return value === 'left' || value === 'right';
}

function validPlayerList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === 'string' && name.trim() !== '');
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
      (event.playerName === undefined || (typeof event.playerName === 'string' && event.playerName.trim() !== ''))
    );
  if (event.type === 'end-regulation')
    return (
      event.lastRegulationQuestion === undefined ||
      (Number.isInteger(event.lastRegulationQuestion) && Number(event.lastRegulationQuestion) >= 0)
    );
  if (event.type === 'half-break') return Number.isInteger(event.lastQuestion) && Number(event.lastQuestion) >= 0;
  if (event.type === 'timeout') return validTeam(event.team);
  if (event.type === 'timeout-start') {
    return (
      validTeam(event.team) &&
      (event.startedAt === undefined ||
        (typeof event.startedAt === 'number' && Number.isFinite(event.startedAt) && event.startedAt >= 0))
    );
  }
  if (event.type === 'timeout-resume' || event.type === 'begin-overtime' || event.type === 'begin-sudden-death')
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
  if (!validSetup(payload.setup)) return null;
  if (payload.setup.left.name !== expected.left.name || payload.setup.right.name !== expected.right.name) return null;
  return {
    version: scorerRecoveryVersion,
    setup: payload.setup,
    events: payload.events,
  };
}
