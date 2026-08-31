/**
 * Short, human-readable descriptions of the format and room procedure a game actually carries.
 *
 * This is deliberately a formatter over the parsed descriptors, not a second rules model. The
 * setup screen and Game details must tell the same story, especially for formats that are not the
 * familiar three-answer-type/three-part shape. Keeping the wording here also makes it harder for a
 * component to accidentally describe what it assumes instead of what QBSheet parsed.
 */
import {
  IRoomProcedure,
  protestCheckpointPolicy,
  roomBreaks,
  roomTakesBreaks,
  substitutionPolicy,
} from './RoomProcedure';
import { IScorekeeperFormat } from './ScorekeeperFormat';

function listWithAnd(values: readonly string[]): string {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

function formatPointValue(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function bonusSummary(format: IScorekeeperFormat): string {
  if (!format.bonus.enabled) return 'no bonuses';

  const shape = format.bonus.regular
    ? ''
    : `, ${format.bonus.minimumParts}–${format.bonus.maximumParts} parts`;
  const bounceBack = format.bonus.bounceBack ? ', bouncing back' : '';
  return `${format.bonus.maximumScore}-point bonuses${shape}${bounceBack}`;
}

function overtimeSummary(format: IScorekeeperFormat): string | undefined {
  const { minimumQuestionCount: count, includesBonuses } = format.overtime;
  // Sudden-death overtime is the default descriptor and does not need to add noise to every
  // ordinary game. Include it when the format made the unusual choice of bonuses in overtime.
  if (count === 1 && !includesBonuses) return undefined;
  const period = count === 1 ? 'sudden-death overtime' : `${count}-tossup overtime`;
  return includesBonuses ? `${period} with bonuses` : period;
}

function lightningSummary(format: IScorekeeperFormat): string | undefined {
  if (!format.lightning.enabled) return undefined;
  const count = format.lightning.countPerTeam;
  const rounds = `${count} lightning round${count === 1 ? '' : 's'} per team`;
  return `${rounds} in ${format.lightning.divisor}-point increments`;
}

/**
 * Describe the parsed scoring format in one line.
 *
 * The format name is retained when it exists because it is useful context (and is not interpreted as
 * a rule). Every structural part after it comes from `IScorekeeperFormat`, including answer values,
 * player count, bonus shape, timing, overtime and lightning. No NAQT/ACF defaults are inferred.
 */
export function formatSummary(format: IScorekeeperFormat): string {
  const values = format.answerTypes.map((answerType) => formatPointValue(answerType.value));
  const regulation = `${format.regulation.tossupCount} tossups${format.regulation.timed ? ' planned' : ''}${
    format.regulation.timed && format.regulation.maximumTossupCount !== format.regulation.tossupCount
      ? ` (up to ${format.regulation.maximumTossupCount})`
      : ''
  }`;
  const timing = format.regulation.timed ? 'timed' : 'untimed';
  const extras = [overtimeSummary(format), lightningSummary(format)].filter(
    (value): value is string => value !== undefined,
  );

  return [
    format.name.trim(),
    regulation,
    values.length > 0 ? values.join(' / ') : 'no answer values',
    `${format.players.maximumActive} player${format.players.maximumActive === 1 ? '' : 's'}`,
    bonusSummary(format),
    timing,
    ...extras,
  ]
    .filter((value) => value !== '')
    .join(' · ');
}

function breakSummary(procedure: IRoomProcedure | undefined): string {
  const breaks = roomBreaks(procedure);
  if (breaks.length === 0)
    return roomTakesBreaks(procedure) ? 'one break when the moderator says' : 'no breaks';

  const descriptions = breaks.map((roomBreak) => {
    const label = roomBreak.label?.trim();
    return label === undefined || label === ''
      ? `after tossup ${roomBreak.afterTossup}`
      : `${label} (after tossup ${roomBreak.afterTossup})`;
  });
  return `${breaks.length === 1 ? 'break' : 'breaks'} ${listWithAnd(descriptions)}`;
}

function timeoutSummary(procedure: IRoomProcedure | undefined): string {
  const count = procedure?.timeoutsPerTeam ?? 0;
  if (count === 0) return 'no timeouts tracked';
  const duration =
    procedure?.timeoutDurationSeconds === undefined
      ? ''
      : ` (${procedure.timeoutDurationSeconds}-second timeouts)`;
  return `${count} timeout${count === 1 ? '' : 's'} each${duration}`;
}

function substitutionSummary(procedure: IRoomProcedure | undefined): string {
  return substitutionPolicy(procedure) === 'breaks-timeouts-overtime'
    ? 'lineups change at breaks, timeouts, and phase checkpoints'
    : 'lineups change at any boundary';
}

function protestSummary(procedure: IRoomProcedure | undefined): string | undefined {
  switch (protestCheckpointPolicy(procedure)) {
    case 'phase-boundaries':
      return 'protests checked at phase boundaries';
    case 'strict-overtime':
      return 'protests checked at sudden death';
    default:
      return undefined;
  }
}

/** Describe the parsed room procedure in one line. */
export function procedureSummary(procedure: IRoomProcedure | undefined): string {
  const clock =
    procedure?.halfLengthMinutes === undefined ? undefined : `${procedure.halfLengthMinutes}-minute halves`;
  return [
    timeoutSummary(procedure),
    breakSummary(procedure),
    substitutionSummary(procedure),
    clock,
    protestSummary(procedure),
  ]
    .filter((value): value is string => value !== undefined)
    .join(' · ');
}

/** Both lines used by setup/review surfaces, kept together so they cannot drift apart. */
export function gameFormatSummary(
  format: IScorekeeperFormat,
  procedure: IRoomProcedure | undefined,
): { format: string; procedure: string } {
  return { format: formatSummary(format), procedure: procedureSummary(procedure) };
}
