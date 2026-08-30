/**
 * Reading the authorized departures out of a game's history.
 *
 * # The shape of the idea
 *
 * `IRoomProcedure` says what this room may do. A `procedure-exception` event says that somebody with
 * the standing to do so allowed one particular thing it does not. Everything in this file answers
 * one question — "how much has been allowed, and how much of that is still going spare?" — so that
 * `canApplyScoreEvent` can keep saying no to everything else.
 *
 * # Two ways an allowance is spent, and why
 *
 * A **ceiling** allowance raises a number the engine already counts against: an extra timeout raises
 * the team's timeout allocation, an extra tossup lengthens regulation, an overtime continuation
 * lengthens the initial overtime period. Nothing has to be marked as consumed, because the
 * comparison that ends the thing does it: a team with one configured and one granted timeout has
 * taken both when `timeouts[team]` reaches two, and regulation ends again the moment the extra
 * tossup has been played. Counting these any other way would mean two places that both decide when
 * the allowance runs out.
 *
 * A **one-shot** allowance permits an act the engine does not count at all — a lineup change at a
 * boundary the policy forbids, a break the schedule does not contain. Those are spent by the next
 * qualifying event recorded after them, in order, so a director who allows one substitution has
 * allowed one and not every substitution for the rest of the game.
 *
 * # Order matters, so this reads the list rather than a summary
 *
 * `deriveGame` deliberately does not carry a "timeouts still allowed" number, because the answer
 * depends on which events came after which grant. The list is the only place that is true, so these
 * are functions over the list.
 */
import { LeftOrRight } from './types';
import { IProcedureExceptionEvent, ProcedureAllowance, ProcedureAuthority, ScoreEvent } from './ScoreEvents';

/** Every allowance a room can be granted, in the order the exception form offers them. */
export const procedureAllowances: readonly ProcedureAllowance[] = [
  'extra-timeout',
  'substitution',
  'extra-break',
  'skip-break',
  'extra-tossup',
  'overtime-continuation',
  'other',
];

/** What each allowance is called on screen and in the exported result. */
export const procedureAllowanceLabels: Record<ProcedureAllowance, string> = {
  'extra-timeout': 'An extra timeout',
  substitution: 'A lineup change outside the usual opportunity',
  'extra-break': 'An extra break',
  'skip-break': 'Skipping a scheduled break',
  'extra-tossup': 'One more tossup in regulation',
  'overtime-continuation': 'One more tossup in overtime',
  other: 'Something else the room was told to do',
};

/** How the authority reads in a sentence about who allowed it. */
export const procedureAuthorityLabels: Record<ProcedureAuthority, string> = {
  'tournament-director': 'the tournament director',
  moderator: 'the moderator',
  other: 'the room',
};

/** Whether the allowance is about one team rather than about the room. */
export function allowanceNeedsTeam(allowance: ProcedureAllowance): boolean {
  return allowance === 'extra-timeout' || allowance === 'substitution';
}

/** Every exception recorded, in the order they were recorded. */
export function procedureExceptions(events: readonly ScoreEvent[]): IProcedureExceptionEvent[] {
  return events.filter((event): event is IProcedureExceptionEvent => event.type === 'procedure-exception');
}

/**
 * How many of this allowance have been granted, ever.
 *
 * The right question for a ceiling allowance, and the wrong one for a one-shot; see the note at the
 * top.
 */
export function grantedAllowanceCount(
  events: readonly ScoreEvent[],
  allowance: ProcedureAllowance,
  team?: LeftOrRight,
): number {
  return procedureExceptions(events).filter(
    (event) => event.allowance === allowance && (team === undefined || event.team === team),
  ).length;
}

/** Whether an ordinary event spends a one-shot grant of this allowance. */
function spends(event: ScoreEvent, allowance: ProcedureAllowance, team: LeftOrRight | undefined): boolean {
  if (allowance === 'substitution') {
    return event.type === 'substitution' && (team === undefined || event.team === team);
  }
  if (allowance === 'extra-break') return event.type === 'half-break';
  return false;
}

/**
 * Grants of a one-shot allowance that nothing has used yet.
 *
 * Walked in recorded order: a grant is spent by the first qualifying event *after* it, so recording
 * the substitution a director allowed does not also authorize the one a coach asks for at tossup 14.
 */
export function unspentAllowances(
  events: readonly ScoreEvent[],
  allowance: ProcedureAllowance,
  team?: LeftOrRight,
): IProcedureExceptionEvent[] {
  const pending: IProcedureExceptionEvent[] = [];
  for (const event of events) {
    if (event.type === 'procedure-exception') {
      if (event.allowance === allowance && (team === undefined || event.team === team)) pending.push(event);
      continue;
    }
    if (pending.length > 0 && spends(event, allowance, team)) pending.shift();
  }
  return pending;
}

/** Timeouts this team may take beyond its configured allocation. */
export function extraTimeoutsGranted(events: readonly ScoreEvent[], team: LeftOrRight): number {
  return grantedAllowanceCount(events, 'extra-timeout', team);
}

/**
 * Tossups regulation has been lengthened by.
 *
 * A ceiling, so every grant counts and the extension simply stops applying once they have been
 * played. `canApplyScoreEvent` refuses to grant one at all once overtime has been played, because
 * lengthening regulation after the fact would reclassify tossups the room already played as overtime
 * — which is a correction to history and belongs in the scoresheet review, not here.
 */
export function extraRegulationTossups(events: readonly ScoreEvent[]): number {
  return grantedAllowanceCount(events, 'extra-tossup');
}

/** Tossups the initial overtime period has been lengthened by. */
export function extraOvertimeTossups(events: readonly ScoreEvent[]): number {
  return grantedAllowanceCount(events, 'overtime-continuation');
}

/** Scheduled breaks the room was told not to take, which move the schedule's cursor along. */
export function breaksSkipped(events: readonly ScoreEvent[]): number {
  return grantedAllowanceCount(events, 'skip-break');
}

/** Whether a break the schedule does not contain has been authorized and not yet taken. */
export function extraBreakAvailable(events: readonly ScoreEvent[]): boolean {
  return unspentAllowances(events, 'extra-break').length > 0;
}

/** Whether a lineup change outside the usual opportunity has been authorized for this team. */
export function substitutionAllowed(events: readonly ScoreEvent[], team: LeftOrRight): boolean {
  return unspentAllowances(events, 'substitution', team).length > 0;
}

/** An exception as anything that has to describe one holds it: the event, or the derived form. */
export interface IProcedureExceptionFacts {
  questionNumber: number;
  allowance: ProcedureAllowance;
  authority: ProcedureAuthority;
  reason: string;
  teamName?: string;
  playerName?: string;
}

/**
 * One exception as a line somebody can read on a result.
 *
 * The same sentence everywhere it appears — the review list, Game details, the pre-submit warnings,
 * `Match.notes` — because a room, a director and an importer reading four different descriptions of
 * one ruling is four chances to conclude the software invented it.
 */
export function procedureExceptionLine(facts: IProcedureExceptionFacts): string {
  const subject = facts.teamName ? ` for ${facts.teamName}` : '';
  const player = facts.playerName ? ` · ${facts.playerName}` : '';
  const who = ` (allowed by ${procedureAuthorityLabels[facts.authority]})`;
  return `Q${facts.questionNumber} ${procedureAllowanceLabels[facts.allowance]}${subject}${player}${who}: ${facts.reason}`;
}

/** The facts for one recorded exception event, given the names its team is playing under. */
export function exceptionFacts(
  exception: IProcedureExceptionEvent,
  teamNames: Record<LeftOrRight, string>,
): IProcedureExceptionFacts {
  return {
    questionNumber: exception.questionNumber,
    allowance: exception.allowance,
    authority: exception.authority,
    reason: exception.reason,
    ...(exception.team ? { teamName: teamNames[exception.team] } : {}),
    ...(exception.playerName ? { playerName: exception.playerName } : {}),
  };
}
