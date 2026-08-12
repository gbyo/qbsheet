/**
 * A game somebody described from nothing, turned into an ordinary definition.
 *
 * # Only special while it is being set up
 *
 * A practice, a scrimmage, a tryout and a pickup game all have the same problem: there is no
 * tournament system, so nothing produces an assignment. What they do not have is a different kind of
 * game. So this file exists to answer the setup questions and then get out of the way — what it
 * produces is an `IGameDefinition` like any other, and from the moment `GameStore.create` returns,
 * nothing downstream distinguishes it except who is owed the finished file.
 *
 * # What is deliberately not asked for
 *
 * No tournament key, no scheduled match, no room, no round revision beyond 1, no QBJ object ids. A
 * practice game has none of those, and the package type being able to carry them is not a reason to
 * invent them: every one of those fields means something to somebody outside this device, and a
 * fabricated one is a result that claims to belong to a schedule it was never on.
 *
 * The public metadata is therefore modest on purpose — a tournament called `Practice`, one round
 * named after whatever the scorekeeper called the game. That is honest, and it is enough for the
 * result to export as a standards-shaped QBJ through the ordinary builder's fallback ids.
 *
 * # Identity is local, and is not the package
 *
 * Two practices between the same two teams on the same afternoon are two games, not one game opened
 * twice. `gamePackageIdentity` cannot tell them apart, and the fields that would — a match id, a
 * tournament key — are exactly the ones that must not be faked. So a manual game gets a
 * device-local record identity instead, which never leaves this browser. See `ICreateGameInput`.
 */
import { IGameDefinition } from './GameDefinition';
import {
  IGamePackageTeam,
  gamePackageFormat,
  gamePackageProducer,
  gamePackageVersion,
} from './GamePackage';
import { playerNameMaxLength, readRosterLines, rosterLineProblems } from './Roster';
import { IBasicScoringRulesInput, basicScoringRulesProblems, basicScorekeeperFormat } from '../qbj/BasicScoringRules';
import {
  IRoomProcedure,
  SubstitutionPolicy,
  maximumHalfLengthMinutes,
  maximumTimeoutDurationSeconds,
  maximumTimeoutsPerTeam,
  roomProcedureIsActive,
  roomProcedureVersion,
} from '../scoring/RoomProcedure';

/** What a manual game is called when the scorekeeper did not name it. */
export const defaultManualGameLabel = 'Practice game';

/** The tournament name a manual game reports. Not a tournament; a truthful placeholder. */
export const manualTournamentName = 'Practice';

/** One side of the setup form, exactly as it is typed. */
export interface IManualTeamInput {
  name: string;
  /** The roster textarea, unparsed. One player per line; see `readRosterLines`. */
  players: string;
}

/**
 * How the room runs the game, as the form collects it.
 *
 * Separate from the scoring rules for the same reason `IRoomProcedure` is: none of it changes what
 * anything is worth. Kept as its own shape rather than as a partial `IRoomProcedure` because a form
 * has an in-between state — halves on with no length yet — that a procedure does not.
 */
export interface IManualRoundOptions {
  halves: boolean;
  /** Blank means QBSheet does not run the clock. No length is invented. */
  halfLengthMinutes?: number;
  timeoutsPerTeam: number;
  /** Blank means the timeout is recorded but not counted down. */
  timeoutDurationSeconds?: number;
  substitutionPolicy: SubstitutionPolicy;
}

export const manualRoundOptionDefaults: IManualRoundOptions = {
  halves: false,
  timeoutsPerTeam: 0,
  substitutionPolicy: 'any-boundary',
};

export interface IManualGameInput {
  /** Free text. A human label for headers, Recent Games and export context; never an identifier. */
  gameLabel: string;
  left: IManualTeamInput;
  right: IManualTeamInput;
  rules: IBasicScoringRulesInput;
  options: IManualRoundOptions;
}

/** Which part of the form a complaint belongs under, so it can be shown next to its fields. */
export type ManualGameSection = 'teams' | 'rules' | 'options';

export interface IManualGameProblem {
  section: ManualGameSection;
  message: string;
}

/** What to call a side that has not been named yet. */
function sideLabel(name: string, side: 'left' | 'right'): string {
  const trimmed = name.trim();
  return trimmed === '' ? (side === 'left' ? 'The left team' : 'The right team') : trimmed;
}

function teamProblems(input: IManualGameInput): string[] {
  const problems: string[] = [];
  const left = input.left.name.trim();
  const right = input.right.name.trim();

  if (left === '') problems.push('Enter a name for the left team.');
  if (right === '') problems.push('Enter a name for the right team.');
  if (left !== '' && right !== '' && left.toLocaleLowerCase() === right.toLocaleLowerCase()) {
    problems.push('Team names must be different.');
  }
  if (left.length > playerNameMaxLength) problems.push('The left team name is too long.');
  if (right.length > playerNameMaxLength) problems.push('The right team name is too long.');

  for (const side of ['left', 'right'] as const) {
    const label = sideLabel(input[side].name, side);
    const names = readRosterLines(input[side].players);
    if (names.length === 0) problems.push(`${label} needs at least one player.`);
    problems.push(...rosterLineProblems(names).map((problem) => `${label}: ${problem}`));
  }

  return problems;
}

/**
 * What is wrong with the round options.
 *
 * Reported rather than clamped. `readRoomProcedure` clamps, because it is reading a value that came
 * off a wire and a room that will not load is worse than a room with a wrong timeout count; a person
 * looking at the box they just typed in is owed the opposite treatment.
 */
function optionProblems(options: IManualRoundOptions): string[] {
  const problems: string[] = [];

  if (
    !Number.isInteger(options.timeoutsPerTeam) ||
    options.timeoutsPerTeam < 0 ||
    options.timeoutsPerTeam > maximumTimeoutsPerTeam
  ) {
    problems.push(`Timeouts per team must be between 0 and ${maximumTimeoutsPerTeam}.`);
  }

  const halfLength = options.halfLengthMinutes;
  if (options.halves && halfLength !== undefined) {
    if (!Number.isFinite(halfLength) || halfLength <= 0 || halfLength > maximumHalfLengthMinutes) {
      problems.push(`Half length must be between 1 and ${maximumHalfLengthMinutes} minutes.`);
    }
  }

  const timeoutLength = options.timeoutDurationSeconds;
  if (options.timeoutsPerTeam > 0 && timeoutLength !== undefined) {
    if (
      !Number.isInteger(timeoutLength) ||
      timeoutLength <= 0 ||
      timeoutLength > maximumTimeoutDurationSeconds
    ) {
      problems.push(`Timeout length must be between 1 and ${maximumTimeoutDurationSeconds} seconds.`);
    }
  }

  return problems;
}

/** Everything standing between this form and a game, in the order the form shows it. */
export function manualGameProblems(input: IManualGameInput): IManualGameProblem[] {
  return [
    ...teamProblems(input).map((message) => ({ section: 'teams' as const, message })),
    ...basicScoringRulesProblems(input.rules).map((message) => ({ section: 'rules' as const, message })),
    ...optionProblems(input.options).map((message) => ({ section: 'options' as const, message })),
  ];
}

/**
 * The procedure this form describes, or nothing.
 *
 * Nothing when every setting is at its inactive default, because attaching an object that asks the
 * room to do exactly what it would have done anyway is a difference the game menu, the QBJ and every
 * later reader has to look at and discard.
 */
export function manualRoomProcedure(options: IManualRoundOptions): IRoomProcedure | undefined {
  const procedure: IRoomProcedure = {
    version: roomProcedureVersion,
    halves: options.halves,
    // A clock length with no halves to apply it to is not a rule anybody stated.
    ...(options.halves && options.halfLengthMinutes !== undefined
      ? { halfLengthMinutes: options.halfLengthMinutes }
      : {}),
    timeoutsPerTeam: options.timeoutsPerTeam,
    ...(options.timeoutsPerTeam > 0 && options.timeoutDurationSeconds !== undefined
      ? { timeoutDurationSeconds: options.timeoutDurationSeconds }
      : {}),
    ...(options.substitutionPolicy !== 'any-boundary'
      ? { substitutionPolicy: options.substitutionPolicy }
      : {}),
  };
  return roomProcedureIsActive(procedure) ? procedure : undefined;
}

export type ManualGameResult =
  | { ok: true; definition: IGameDefinition }
  | { ok: false; problems: IManualGameProblem[] };

/** The typed-in game as an ordinary definition, or the reasons it is not one yet. */
export function defineManualGame(input: IManualGameInput): ManualGameResult {
  const problems = manualGameProblems(input);
  if (problems.length > 0) return { ok: false, problems };

  const format = basicScorekeeperFormat(input.rules);
  if (!format) {
    // Unreachable while `manualGameProblems` consults the same judgement, and kept because "the
    // form said it was fine" is not a reason to hand the scorer a format nothing checked.
    return { ok: false, problems: [{ section: 'rules', message: 'Enter a playable scoring format.' }] };
  }

  const side = (team: IManualTeamInput): IGamePackageTeam => ({
    name: team.name.trim(),
    players: readRosterLines(team.players).map((name) => ({ name })),
  });

  const procedure = manualRoomProcedure(input.options);
  const label = input.gameLabel.trim() === '' ? defaultManualGameLabel : input.gameLabel.trim();

  return {
    ok: true,
    definition: {
      format: gamePackageFormat,
      version: gamePackageVersion,
      producer: gamePackageProducer,
      tournament: { name: manualTournamentName },
      round: { number: 1, name: label, revision: 1 },
      left: side(input.left),
      right: side(input.right),
      scorekeeperFormat: format,
      ...(procedure ? { procedure } : {}),
      origin: 'manual',
    },
  };
}

/** Monotonic within a page, so two games created in the same millisecond still differ. */
let manualSequence = 0;

/**
 * A device-local record identity for a manual game.
 *
 * Never written into a QBJ, never a `scheduledMatchId`, never a tournament identifier. It exists so
 * that a second practice between the same two teams is a second record rather than an accidental
 * reopen of the first, and it is stored on the record so it survives a reload for the same reason
 * the game does.
 *
 * Random where the browser will give us randomness, and still unique where it will not: the
 * timestamp and the counter alone are enough for one device, which is the only scope this has.
 */
export function newManualRecordIdentity(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  }
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  manualSequence += 1;
  return `manual:${Date.now().toString(36)}-${manualSequence.toString(36)}-${random}`;
}
