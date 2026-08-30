/**
 * How a room runs a game, as opposed to how a game is scored.
 *
 * # Why this is separate from the scoring rules
 *
 * `IScorekeeperFormat` is `ScoringRules` restated, and everything in it decides what a game is worth:
 * answer values, bonus structure, overtime length, lightning. None of that varies by room. Halves,
 * clock length and timeouts are a different kind of thing — they decide how a room *conducts* the
 * round, they are not part of any statistic YellowFruit stores, and local tournaments modify them
 * routinely. NAQT itself is played in halves at some events and straight through at others, and the
 * repo's own compatibility audit notes that timing varies by audience and event.
 *
 * So they live here, optional and off by default, and the scoring engine never reads them. A room
 * with no procedure configured behaves exactly as it did before this file existed.
 *
 * # No duration is invented
 *
 * YellowFruit stores `timed` as a bare boolean and no half length anywhere, which is why the room
 * has always had to be told by the moderator that time expired. Rather than hard-coding a number
 * that would be wrong for half the tournaments that use it, the length is a setting the director
 * fills in when they want the room to show a clock, and is simply absent otherwise.
 *
 * # Breaks are stated, not approximated
 *
 * `halves` says a room stops once, somewhere the moderator chooses. That is one tournament's
 * procedure, not every tournament's: events break after tossup 5 and 10, between sets, at the end of
 * a packet, or at several stated points in a round. Version 3 therefore carries `breaks` — the
 * tossups after which this room stops — and `halves` remains for the rooms that only ever wanted the
 * single moderator-chosen break, and for every procedure already written to a file or a wire.
 *
 * A break is the boundary everything procedural hangs off: it is where the score is agreed, where
 * substitutions are available under the restrictive policy, and where the clock pauses. So stating
 * the breaks precisely is what lets substitution availability be precise, which is the whole point
 * of configuring them.
 */

/**
 * Bumped when the shape changes. Older versions are migrated by `readRoomProcedure`.
 *
 * Every version in `readableRoomProcedureVersions` is one this build can interpret without guessing.
 * A procedure from the future is not read at all — a room that silently ignored a break it did not
 * understand would allow substitutions the tournament forbade.
 *
 * "Not read" is not the end of it, because the fallback for an unread procedure is *no* procedure,
 * and no procedure is the permissive `any-boundary` policy. Whoever hands a procedure to this reader
 * has to notice the version first and refuse the game rather than score it unenforced. See
 * `GamePackageValidation` for the file and legacy-assignment paths and `readQbtcpExtension` for the
 * QBJ one.
 */
export const roomProcedureVersion = 3;
export const legacyRoomProcedureVersion = 1;
export const readableRoomProcedureVersions: readonly number[] = [1, 2, 3];

export type ProtestCheckpointPolicy = 'none' | 'phase-boundaries' | 'strict-overtime';
export type SubstitutionPolicy = 'any-boundary' | 'breaks-timeouts-overtime';

/**
 * One point in the round where the room stops.
 *
 * `afterTossup` is a tossup number rather than a clock time because that is the boundary a
 * scoresheet can actually be at: a break "at 4:00 remaining" is a break the room takes after
 * whichever tossup was in progress, and the scorekeeper knows that number and not the clock's.
 */
export interface IRoomBreak {
  /** The break falls after this tossup has been played. Whole, at least 1. */
  afterTossup: number;
  /**
   * What the room calls this break — "Halftime", "End of set 1".
   *
   * Optional because a break with no name is still a break, and a fabricated name would be the
   * tournament's procedure stated in words the tournament did not use.
   */
  label?: string;
}

export interface IRoomProcedure {
  version: number;
  /**
   * Play is divided into halves with a score check between them.
   *
   * Purely operational: the room gets somewhere to stop, agree the score with the moderator, and
   * substitute. Nothing about the resulting `Match` changes.
   *
   * This is the imprecise form, kept because it is what every existing procedure says: one break,
   * at a point the moderator picks. When `breaks` is configured it supersedes this — see
   * `roomBreaksAreScheduled`.
   */
  halves: boolean;
  /**
   * The tossups after which this room stops, in ascending order.
   *
   * Absent means the room's breaks are not scheduled, and `halves` decides whether it takes one at
   * all. Present means these are the breaks: the room may not stop between them, which is exactly
   * what makes the restrictive substitution policy mean something a director stated rather than an
   * approximation of it.
   */
  breaks?: IRoomBreak[];
  /**
   * Minutes in a half, when the room should show a clock.
   *
   * Undefined means the room is not running the clock — the moderator is, and the scorekeeper is
   * told when the half ends. This stays undefined unless a director deliberately sets it.
   */
  halfLengthMinutes?: number;
  /** Timeouts each team may take. Zero means the room does not track timeouts. */
  timeoutsPerTeam: number;
  /** Optional length of a timeout. Missing means the room records the timeout but does not count it down. */
  timeoutDurationSeconds?: number;
  /** When an open protest must be resolved before the room advances. */
  protestCheckpoints?: ProtestCheckpointPolicy;
  /** When the room may change the active lineup. Missing preserves the original permissive behavior. */
  substitutionPolicy?: SubstitutionPolicy;
}

/** A room with nothing configured: no halves, no clock, no timeout tracking. */
export function defaultRoomProcedure(): IRoomProcedure {
  return { version: roomProcedureVersion, halves: false, timeoutsPerTeam: 0 };
}

/** Longest half a director can configure. Four hours, i.e. "this is clearly a typo" territory. */
export const maximumHalfLengthMinutes = 240;

/**
 * The most breaks a round can be cut into, and the highest tossup one can fall after.
 *
 * Both are chosen to be absurd rather than restrictive: a round with 32 breaks in it is a typo, and
 * so is a break after tossup 400. Neither is a rule about how quiz bowl is played.
 */
export const maximumRoomBreaks = 32;
export const maximumRoomBreakTossup = 400;
export const maximumRoomBreakLabelLength = 60;

/** The most timeouts per team the room will track. Well above any real rule set. */
export const maximumTimeoutsPerTeam = 9;

/** A timeout longer than ten minutes is almost certainly a configuration error. */
export const maximumTimeoutDurationSeconds = 10 * 60;

export function protestCheckpointPolicy(procedure: IRoomProcedure | undefined): ProtestCheckpointPolicy {
  return procedure?.protestCheckpoints ?? 'none';
}

export function substitutionPolicy(procedure: IRoomProcedure | undefined): SubstitutionPolicy {
  return procedure?.substitutionPolicy ?? 'any-boundary';
}

// #region breaks

/** The configured breaks, ascending. Empty when this room's breaks are not scheduled. */
export function roomBreaks(procedure: IRoomProcedure | undefined): IRoomBreak[] {
  return procedure?.breaks ?? [];
}

/**
 * Whether this room's breaks are stated as tossup numbers.
 *
 * The distinction the rest of the room turns on: a scheduled room stops where the director said and
 * nowhere else, an unscheduled `halves` room stops once wherever the moderator says.
 */
export function roomBreaksAreScheduled(procedure: IRoomProcedure | undefined): boolean {
  return roomBreaks(procedure).length > 0;
}

/** Whether this room stops at all. */
export function roomTakesBreaks(procedure: IRoomProcedure | undefined): boolean {
  return procedure?.halves === true || roomBreaksAreScheduled(procedure);
}

/**
 * The next configured break the room has not reached yet, for telling it what is coming.
 *
 * Scheduled breaks are spent **in order, one per recorded break**, and never matched against the
 * tossup a break was physically taken at. A room told to stop after 5, 10 and 15 that plays through
 * tossup 12 before anybody remembers the first break has taken *one* break — its first — and still
 * owes the other two. Matching on the tossup number instead would let that single stop satisfy both
 * the break after 5 and the break after 10, which is a break the tournament scheduled and the room
 * never took, and — under the restrictive policy — a substitution window that quietly disappears.
 *
 * So the count is the cursor. `breaksTaken` is `IDerivedGame.halfBreaks`, whose entries are the
 * tossup each break was recorded at; only its length is read here. The tossup numbers stay in the
 * event because that is the history of what the room actually did, and it is a different question
 * from which scheduled break the event fulfilled.
 */
export function roomBreakUpcoming(
  procedure: IRoomProcedure | undefined,
  breaksTaken: readonly number[],
): IRoomBreak | undefined {
  return roomBreaks(procedure)[breaksTaken.length];
}

/**
 * The configured break the room owes right now, if any.
 *
 * The next one in the schedule, once the tossup it comes after has been played. "At or past" rather
 * than exactly, because a room that misses the break after tossup 5 and takes it after 6 has taken
 * that break; requiring the numbers to agree would leave it owed forever and the rest of the
 * schedule permanently out of reach.
 *
 * @param breaksTaken the `lastQuestion` of every break already recorded, i.e. `IDerivedGame.halfBreaks`
 * @param lastPlayedQuestion the last tossup actually played; see `lastPlayedQuestion`
 */
export function roomBreakDue(
  procedure: IRoomProcedure | undefined,
  breaksTaken: readonly number[],
  lastPlayedQuestion: number,
): IRoomBreak | undefined {
  const next = roomBreakUpcoming(procedure, breaksTaken);
  return next !== undefined && next.afterTossup <= lastPlayedQuestion ? next : undefined;
}

/**
 * Whether the room may stop right now.
 *
 * A scheduled room may stop only at a break it owes. An unscheduled `halves` room may stop whenever
 * the moderator says, which is the behavior every procedure written before version 3 has.
 */
export function roomMayBreakNow(
  procedure: IRoomProcedure | undefined,
  breaksTaken: readonly number[],
  lastPlayedQuestion: number,
): boolean {
  if (roomBreaksAreScheduled(procedure)) {
    return roomBreakDue(procedure, breaksTaken, lastPlayedQuestion) !== undefined;
  }
  return procedure?.halves === true;
}

/**
 * What this room calls a break.
 *
 * Its own label when the director gave it one, and otherwise its place in the schedule — "Break 2"
 * rather than "Break", because a room that takes three of them needs to know which one it is at.
 */
export function roomBreakLabel(
  procedure: IRoomProcedure | undefined,
  roomBreak: IRoomBreak | undefined,
): string {
  if (roomBreak === undefined) return 'Break';
  if (roomBreak.label !== undefined && roomBreak.label !== '') return roomBreak.label;
  const breaks = roomBreaks(procedure);
  const position = breaks.findIndex((candidate) => candidate.afterTossup === roomBreak.afterTossup);
  if (position < 0) return 'Break';
  return breaks.length === 1 ? 'Break' : `Break ${position + 1}`;
}

/**
 * The scheduled break the room's most recent stop fulfilled. Used to name a score check.
 *
 * By count, for the reason `roomBreakUpcoming` is: the room that played through tossup 12 before
 * taking its first break is at Break 1, whatever the schedule says is nearest to 12. Naming it from
 * the tossup would put the room on a screen headed "Break 2" immediately after it chose "End of
 * set 1", and then leave Break 2 owed — one break appearing twice, under two different names.
 *
 * @param breaksTakenCount how many breaks have been recorded, i.e. `IDerivedGame.halfBreaks.length`
 */
export function roomBreakTaken(
  procedure: IRoomProcedure | undefined,
  breaksTakenCount: number,
): IRoomBreak | undefined {
  if (breaksTakenCount < 1) return undefined;
  return roomBreaks(procedure)[breaksTakenCount - 1];
}

/** `"5, 10 or 15"` — the breaks as a phrase, for a sentence about when the room stops. */
function breakTossupPhrase(breaks: readonly IRoomBreak[]): string {
  const numbers = breaks.map((roomBreak) => String(roomBreak.afterTossup));
  if (numbers.length === 1) return numbers[0];
  return `${numbers.slice(0, -1).join(', ')} or ${numbers[numbers.length - 1]}`;
}

/**
 * When the restrictive policy lets this room change its lineup, in words.
 *
 * One phrase, read by the starting-lineup prompt, the scorer's own explanation and the event guard's
 * refusal, because a room told three different things about the same rule will believe the software
 * is broken — and under configured breaks the old wording ("at halftime") was simply wrong.
 */
export function substitutionOpportunityPhrase(procedure: IRoomProcedure | undefined): string {
  const breaks = roomBreaks(procedure);
  const when = breaks.length > 0 ? `after tossup ${breakTossupPhrase(breaks)}` : 'at a break';
  return `${when}, at a timeout, or at a phase checkpoint`;
}

// #endregion

/** Whether an open protest must stop the named checkpoint before play can continue. */
export function protestBlocksCheckpoint(
  policy: ProtestCheckpointPolicy,
  checkpoint: 'overtime' | 'sudden-death',
): boolean {
  return policy === 'phase-boundaries' || (policy === 'strict-overtime' && checkpoint === 'sudden-death');
}

/** Whether an unresolved protest blocks the next sudden-death tossup. */
export function protestBlocksSuddenDeathTossup(
  policy: ProtestCheckpointPolicy,
  suddenDeathStarted: boolean,
  hasOpenProtest: boolean,
): boolean {
  return suddenDeathStarted && hasOpenProtest && policy === 'strict-overtime';
}

/**
 * Procedure-level lineup boundary, shared by the scorer UI and event guard.
 *
 * Phase-shaped rather than tossup-shaped on purpose. A restrictive room substitutes at a break, and
 * "the room is at a break" is a phase — `score-check` — that the engine already derives. Which
 * tossups those breaks fall after is `breaks`, and the two compose: configure breaks after 5, 10 and
 * 15 and this function permits substitutions after exactly tossups 5, 10 and 15 without knowing that
 * it does. Nothing here needs a tossup number, which is why nothing here has one.
 */
export function lineupChangeAllowedAtPhase(
  policy: SubstitutionPolicy,
  phase: 'lineup' | 'tossup' | 'bonus' | 'score-check' | 'checkpoint' | 'timeout' | 'complete',
): boolean {
  return (
    phase !== 'complete' &&
    (policy === 'any-boundary' ||
      phase === 'lineup' ||
      phase === 'score-check' ||
      phase === 'checkpoint' ||
      phase === 'timeout')
  );
}

/** Whether this is a procedure shape this build knows how to interpret. */
export function isKnownRoomProcedureVersion(version: unknown): boolean {
  return typeof version === 'number' && readableRoomProcedureVersions.includes(version);
}

/** Does this procedure ask the room to do anything at all? */
export function roomProcedureIsActive(procedure: IRoomProcedure | undefined): procedure is IRoomProcedure {
  if (!procedure || !isKnownRoomProcedureVersion(procedure.version)) return false;
  return (
    procedure.halves ||
    roomBreaksAreScheduled(procedure) ||
    procedure.timeoutsPerTeam > 0 ||
    procedure.halfLengthMinutes !== undefined ||
    (procedure.protestCheckpoints !== undefined && procedure.protestCheckpoints !== 'none') ||
    (procedure.substitutionPolicy !== undefined && procedure.substitutionPolicy !== 'any-boundary')
  );
}

/**
 * Read `breaks`.
 *
 * Sorted, deduplicated by tossup and capped, because everything downstream reads them in order and
 * asking every caller to re-establish that is how one of them ends up not doing it. A break that is
 * not a whole positive tossup number is dropped rather than repaired: there is no defensible guess at
 * which tossup a director meant by `4.5`.
 */
function readRoomBreaks(value: unknown): IRoomBreak[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const byTossup = new Map<number, IRoomBreak>();

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Partial<IRoomBreak>;
    const afterTossup = raw.afterTossup;
    if (
      typeof afterTossup !== 'number' ||
      !Number.isInteger(afterTossup) ||
      afterTossup < 1 ||
      afterTossup > maximumRoomBreakTossup ||
      byTossup.has(afterTossup)
    ) {
      continue;
    }
    const label =
      typeof raw.label === 'string' && raw.label.trim() !== ''
        ? raw.label.trim().slice(0, maximumRoomBreakLabelLength)
        : undefined;
    byTossup.set(afterTossup, { afterTossup, ...(label !== undefined ? { label } : {}) });
  }

  const breaks = [...byTossup.values()]
    .sort((a, b) => a.afterTossup - b.afterTossup)
    .slice(0, maximumRoomBreaks);
  return breaks.length > 0 ? breaks : undefined;
}

/**
 * Read a procedure that came off the wire or out of a file.
 *
 * Returns the default rather than throwing for anything unrecognizable, because a malformed setting
 * must not stop a room scoring a game. The worst case is a room that doesn't offer a halftime break
 * it was supposed to, which the scorekeeper can work around; a room that won't load cannot be.
 */
export function readRoomProcedure(value: unknown): IRoomProcedure {
  if (typeof value !== 'object' || value === null) return defaultRoomProcedure();
  const raw = value as Partial<IRoomProcedure>;
  if (!isKnownRoomProcedureVersion(raw.version)) return defaultRoomProcedure();

  const timeouts =
    typeof raw.timeoutsPerTeam === 'number' && Number.isInteger(raw.timeoutsPerTeam)
      ? Math.min(maximumTimeoutsPerTeam, Math.max(0, raw.timeoutsPerTeam))
      : 0;
  const halfLength =
    typeof raw.halfLengthMinutes === 'number' &&
    Number.isFinite(raw.halfLengthMinutes) &&
    raw.halfLengthMinutes > 0 &&
    raw.halfLengthMinutes <= maximumHalfLengthMinutes
      ? raw.halfLengthMinutes
      : undefined;

  const timeoutDurationSeconds =
    typeof raw.timeoutDurationSeconds === 'number' &&
    Number.isInteger(raw.timeoutDurationSeconds) &&
    raw.timeoutDurationSeconds > 0 &&
    raw.timeoutDurationSeconds <= maximumTimeoutDurationSeconds
      ? raw.timeoutDurationSeconds
      : undefined;

  const protestCheckpoints: ProtestCheckpointPolicy | undefined =
    raw.protestCheckpoints === 'none' ||
    raw.protestCheckpoints === 'phase-boundaries' ||
    raw.protestCheckpoints === 'strict-overtime'
      ? raw.protestCheckpoints
      : undefined;

  const configuredSubstitutionPolicy: SubstitutionPolicy | undefined =
    raw.substitutionPolicy === 'any-boundary' || raw.substitutionPolicy === 'breaks-timeouts-overtime'
      ? raw.substitutionPolicy
      : undefined;

  const breaks = readRoomBreaks(raw.breaks);
  // Scheduled breaks are breaks, so a procedure that lists them is a room that stops — whether or not
  // whoever wrote it also remembered to set the older flag.
  const takesBreaks = raw.halves === true || breaks !== undefined;

  const normalized: IRoomProcedure = {
    version: roomProcedureVersion,
    halves: takesBreaks,
    // A clock length with no play segments to apply it to is not a rule anybody stated.
    halfLengthMinutes: takesBreaks ? halfLength : undefined,
    timeoutsPerTeam: timeouts,
  };

  if (breaks !== undefined) normalized.breaks = breaks;
  if (timeoutDurationSeconds !== undefined) normalized.timeoutDurationSeconds = timeoutDurationSeconds;
  if (protestCheckpoints !== undefined) normalized.protestCheckpoints = protestCheckpoints;
  if (configuredSubstitutionPolicy !== undefined)
    normalized.substitutionPolicy = configuredSubstitutionPolicy;
  return normalized;
}
