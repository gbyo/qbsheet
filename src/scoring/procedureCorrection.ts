/**
 * Correcting how the room runs the game, once it is already running one.
 *
 * # The situation this is for
 *
 * A room is set up for one timeout per team and the tournament gives two. A director announces at
 * lunch that the afternoon rounds break after tossup 10 rather than at halftime. A room was
 * configured with the restrictive substitution policy by somebody copying last year's settings, and
 * this tournament does not have one.
 *
 * `correctFormat` already does this for the scoring rules and the two problems are not the same
 * shape. A scoring rule decides what a recorded answer was *worth*, so correcting one reprices the
 * scoresheet and the interesting question is whether the history can survive the change. A procedure
 * decides what the room was *allowed to do*, and correcting one cannot reprice anything: the breaks
 * that were taken were taken, the timeouts that were called were called.
 *
 * # So what does a procedure correction do to history?
 *
 * Nothing, and that is the deliberate answer.
 *
 * A room that has recorded two breaks and is then corrected to a procedure scheduling one has still
 * taken two breaks. Deleting one to make the scoresheet agree with the new configuration would be
 * erasing a thing that happened in order to tidy up a setting — the exact inversion of what this
 * application is for. So the recorded history stands, and the consequence is *stated* before the
 * correction is applied, in the same breath as the change itself.
 *
 * What that leaves is one honest question the scorekeeper has to answer, and this module's job is to
 * put it in front of them rather than to guess:
 *
 *   - the procedure was wrong all along → correct it, and accept the consequence lines;
 *   - the room was told to do one unusual thing → do not correct anything; record an exception
 *     against the history instead (see `ProcedureExceptions`).
 *
 * # What it refuses
 *
 * Only what would make the recorded history impossible under the corrected procedure — a timeout
 * allocation lowered below the number a team has already used, less whatever was separately
 * authorized. That is not a consequence to accept; it is a scoresheet that fails its own rules with
 * no way back, which is what `correctFormat` refuses for the same reason.
 */
import {
  IRoomProcedure,
  isKnownRoomProcedureVersion,
  maximumHalfLengthMinutes,
  maximumRoomBreaks,
  maximumRoomBreakTossup,
  maximumTimeoutDurationSeconds,
  maximumTimeoutsPerTeam,
  ProtestCheckpointPolicy,
  roomBreaks,
  SubstitutionPolicy,
} from './RoomProcedure';
import { extraTimeoutsGranted } from './ProcedureExceptions';
import { IDerivedGame } from './deriveGame';
import { ScoreEvent } from './ScoreEvents';
import { correctionNote, correctionSummary, describeChange, ICorrectionChange } from './gameCorrection';
import { LeftOrRight } from './types';

export type ProcedureCorrection =
  | {
      ok: true;
      procedure: IRoomProcedure;
      changes: ICorrectionChange[];
      /**
       * What the corrected procedure says about things the room has already done.
       *
       * Never a refusal and never silent. A room that took a break the corrected schedule does not
       * contain keeps that break, and is told in one sentence that it now has one more break on its
       * scoresheet than its procedure schedules.
       */
      consequences: string[];
      /** True when nothing about the procedure actually differs, so there is nothing to write. */
      unchanged: boolean;
      summary: string;
    }
  | { ok: false; problems: string[] };

const protestPolicyLabels: Record<ProtestCheckpointPolicy, string> = {
  none: 'never stop play',
  'phase-boundaries': 'stop at overtime and sudden death',
  'strict-overtime': 'stop at sudden death and during it',
};

const substitutionPolicyLabels: Record<SubstitutionPolicy, string> = {
  'any-boundary': 'at any tossup boundary',
  'breaks-timeouts-overtime': 'at breaks, timeouts and phase checkpoints',
};

/** `after tossups 5, 10 and 15`, or `not scheduled`. */
export function breaksPhrase(procedure: IRoomProcedure | undefined): string {
  const breaks = roomBreaks(procedure);
  if (breaks.length === 0) return procedure?.halves === true ? 'one, when the moderator says' : 'none';
  const numbers = breaks.map((entry) => String(entry.afterTossup));
  if (numbers.length === 1) return `after tossup ${numbers[0]}`;
  return `after tossups ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

/** Structural problems with a proposed procedure, before it is compared against anything. */
export function roomProcedureProblems(procedure: IRoomProcedure): string[] {
  const problems: string[] = [];
  if (!isKnownRoomProcedureVersion(procedure.version)) {
    problems.push('This room procedure was written by a newer version of QBSheet and cannot be edited here.');
  }
  if (
    !Number.isInteger(procedure.timeoutsPerTeam) ||
    procedure.timeoutsPerTeam < 0 ||
    procedure.timeoutsPerTeam > maximumTimeoutsPerTeam
  ) {
    problems.push(`Timeouts per team must be a whole number from 0 to ${maximumTimeoutsPerTeam}.`);
  }
  if (procedure.halfLengthMinutes !== undefined) {
    if (
      !Number.isFinite(procedure.halfLengthMinutes) ||
      procedure.halfLengthMinutes <= 0 ||
      procedure.halfLengthMinutes > maximumHalfLengthMinutes
    ) {
      problems.push(`A half must be between 1 and ${maximumHalfLengthMinutes} minutes long.`);
    }
  }
  if (procedure.timeoutDurationSeconds !== undefined) {
    if (
      !Number.isInteger(procedure.timeoutDurationSeconds) ||
      procedure.timeoutDurationSeconds <= 0 ||
      procedure.timeoutDurationSeconds > maximumTimeoutDurationSeconds
    ) {
      problems.push(`A timeout must be between 1 and ${maximumTimeoutDurationSeconds} seconds long.`);
    }
  }
  const breaks = roomBreaks(procedure);
  if (breaks.length > maximumRoomBreaks)
    problems.push(`A round may have at most ${maximumRoomBreaks} breaks.`);
  for (const entry of breaks) {
    if (
      !Number.isInteger(entry.afterTossup) ||
      entry.afterTossup < 1 ||
      entry.afterTossup > maximumRoomBreakTossup
    ) {
      problems.push(`A break must fall after a tossup from 1 to ${maximumRoomBreakTossup}.`);
      break;
    }
  }
  if (new Set(breaks.map((entry) => entry.afterTossup)).size !== breaks.length) {
    problems.push('Two breaks are scheduled after the same tossup.');
  }
  return problems;
}

/**
 * Whether a procedure correction can be applied, and what it would do.
 *
 * Pure. Nothing is written and nothing is decided here about *whether* to apply it; that is the
 * scorekeeper's, after reading `changes` and `consequences`.
 */
export default function correctProcedure(
  from: IRoomProcedure | undefined,
  to: IRoomProcedure,
  events: readonly ScoreEvent[],
  game: IDerivedGame,
): ProcedureCorrection {
  const invalid = roomProcedureProblems(to);
  if (invalid.length > 0) return { ok: false, problems: invalid };

  const problems: string[] = [];
  const changes: ICorrectionChange[] = [];
  const consequences: string[] = [];

  // --- timeouts ---------------------------------------------------------------------------------

  const configuredBefore = from?.timeoutsPerTeam ?? 0;
  for (const side of ['left', 'right'] as LeftOrRight[]) {
    const taken = game.timeouts[side];
    // Separately authorized timeouts are not the procedure's business and must not count against a
    // corrected allocation: a room told it may have one, granted a second by the director, and then
    // corrected to two has not thereby exceeded anything.
    const authorized = extraTimeoutsGranted(events, side);
    if (taken > to.timeoutsPerTeam + authorized) {
      problems.push(
        `${game[side].name} has already taken ${taken} ${
          taken === 1 ? 'timeout' : 'timeouts'
        }, which is more than the corrected procedure allows. Record the extra one as an authorized timeout, or correct the questions first.`,
      );
    }
  }
  describeChange(changes, 'Timeouts per team', configuredBefore, to.timeoutsPerTeam);
  describeChange(
    changes,
    'Timeout length',
    from?.timeoutDurationSeconds === undefined ? undefined : `${from.timeoutDurationSeconds}s`,
    to.timeoutDurationSeconds === undefined ? undefined : `${to.timeoutDurationSeconds}s`,
  );

  // --- breaks -----------------------------------------------------------------------------------

  const breaksBefore = breaksPhrase(from);
  const breaksAfter = breaksPhrase(to);
  describeChange(changes, 'Breaks', breaksBefore, breaksAfter);
  describeChange(
    changes,
    'Half length',
    from?.halfLengthMinutes === undefined ? undefined : `${from.halfLengthMinutes} min`,
    to.halfLengthMinutes === undefined ? undefined : `${to.halfLengthMinutes} min`,
  );

  const breaksTaken = game.halfBreaks.length;
  const scheduled = roomBreaks(to).length;
  if (breaksTaken > 0 && !to.halves && scheduled === 0) {
    consequences.push(
      `This room has already stopped ${breaksTaken === 1 ? 'once' : `${breaksTaken} times`}. Those breaks stay on the scoresheet; the corrected procedure simply schedules none.`,
    );
  } else if (scheduled > 0 && breaksTaken > scheduled) {
    consequences.push(
      `This room has already stopped ${breaksTaken} times and the corrected schedule has ${scheduled}. The breaks already taken stay on the scoresheet.`,
    );
  } else if (scheduled > 0 && breaksTaken > 0) {
    const next = roomBreaks(to)[breaksTaken];
    consequences.push(
      next === undefined
        ? `The ${breaksTaken === 1 ? 'break' : 'breaks'} already taken count against the corrected schedule, which leaves none outstanding.`
        : `The ${breaksTaken === 1 ? 'break' : 'breaks'} already taken count against the corrected schedule; the next one falls after tossup ${next.afterTossup}.`,
    );
  }

  // --- policies ---------------------------------------------------------------------------------

  const substitutionBefore = substitutionPolicyLabels[from?.substitutionPolicy ?? 'any-boundary'];
  const substitutionAfter = substitutionPolicyLabels[to.substitutionPolicy ?? 'any-boundary'];
  describeChange(changes, 'Lineup changes', substitutionBefore, substitutionAfter);
  if (
    substitutionBefore !== substitutionAfter &&
    to.substitutionPolicy === 'breaks-timeouts-overtime' &&
    events.some((event) => event.type === 'substitution' && event.questionNumber > 1)
  ) {
    consequences.push(
      'Lineup changes already recorded stay exactly as they are. The tighter policy applies from now on.',
    );
  }

  describeChange(
    changes,
    'Open protests',
    protestPolicyLabels[from?.protestCheckpoints ?? 'none'],
    protestPolicyLabels[to.protestCheckpoints ?? 'none'],
  );

  if (problems.length > 0) return { ok: false, problems };

  const unchanged = changes.length === 0;
  return {
    ok: true,
    procedure: to,
    changes,
    consequences,
    unchanged,
    summary: unchanged ? '' : correctionNote(`Room procedure: ${correctionSummary(changes)}`),
  };
}
