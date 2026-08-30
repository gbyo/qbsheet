/**
 * Reading a game that was saved by a different build of QBSheet.
 *
 * # The failure this exists to prevent
 *
 * `GameStore` used to read records with `version === gameRecordVersion` and ignore everything else.
 * That is correct for exactly as long as nobody ever changes the schema. The first commit that bumps
 * the constant — which is the intended way to change the shape of a record — would, on the Saturday
 * it is deployed, make every game saved by yesterday's build disappear from the welcome screen. Not
 * fail: *disappear*. The unfinished round included, with the events still sitting in the journal in
 * `localStorage` and nothing left on screen willing to admit the game existed.
 *
 * A version number whose only behaviour is to discard data is worse than no version number, because
 * it looks like a migration mechanism in code review.
 *
 * # What replaces it
 *
 * A record is read forward, one version at a time, by a table of steps. Three outcomes:
 *
 *   - **current** — the shape this build writes. Nothing to do.
 *   - **upgraded** — an older shape this build knows how to read. It is migrated, and written back so
 *     the migration happens once rather than on every load.
 *   - **too new / unreadable** — a record from a build that came *after* this one (a rollback, or a
 *     device that synced from a newer deploy), or one whose shape is not a game at all.
 *
 * The last case is the one to be careful about, and the rule is: never delete it, never claim to be
 * able to score it, and never pretend it is not there. It is left in storage untouched — a later
 * build, or a re-deploy of the newer one, will read it perfectly well — it is kept out of the lists
 * that feed the scoresheet, and it is counted so the front door can say so out loud. Silence is the
 * one behaviour that is not available, because "my game vanished" is the report this whole file is
 * here to make impossible.
 *
 * # Adding a step
 *
 * Bump `gameRecordVersion`, then add the step keyed by the version it upgrades *from*. A step receives
 * the raw stored object and returns the shape of the next version; it must not throw, and it may
 * assume only what its own version guaranteed. Purely additive optional fields need no step at all —
 * that is why the table is empty today despite the record having grown several times.
 */
// Type-only, so the pairing with `GameStore` — which imports the reader from here — is erased at
// runtime and there is no module cycle to reason about.
import type { IStoredGameRecord } from './GameStore';
import { scorekeeperFormatProblems, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';

/**
 * The shape of a record this build writes.
 *
 * Lives here rather than in `GameStore` because the number is meaningless without the table of steps
 * below it: bumping it is a claim that there is a route from the previous shape to this one, and the
 * two belong in the same file so that claim is checkable in one place.
 */
export const gameRecordVersion = 1;

/** A stored object before this file has decided it is a game record. */
export type RawRecord = Record<string, unknown>;

/** One version forward. Keyed in `upgradeSteps` by the version it upgrades *from*. */
export type UpgradeStep = (record: RawRecord) => RawRecord;

/**
 * Every schema change that has shipped.
 *
 * Empty, and legitimately so: every field added to `IStoredGameRecord` so far has been optional, and
 * an optional field needs no migration — a record without it reads as `undefined`, which is what it
 * would have been anyway. The table exists so that the first change which *is* breaking has somewhere
 * to go other than a filter that deletes the tournament.
 */
export const upgradeSteps: Readonly<Record<number, UpgradeStep>> = {};

export type RecordReadability =
  /** Written by this build. */
  | 'current'
  /** Written by an older build and migrated forward. Should be written back. */
  | 'upgraded'
  /** Written by a newer build. Left alone, in the expectation that build will be back. */
  | 'too-new'
  /** Not a game record, or an old version with no route forward. Left alone. */
  | 'unreadable';

export interface IReadRecord {
  readability: RecordReadability;
  /** The migrated record, or null when this build cannot read it. */
  record: IStoredGameRecord | null;
  /** What the stored object claimed to be, for a diagnostics file. Null when it did not say. */
  storedVersion: number | null;
}

function isObject(value: unknown): value is RawRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0;
}

function isTeamSetup(value: unknown): boolean {
  if (!isObject(value) || typeof value.name !== 'string' || !isStringArray(value.players)) return false;
  return value.startingLineup === undefined || isNonEmptyStringArray(value.startingLineup);
}

function isSetup(value: unknown): boolean {
  return isObject(value) && isTeamSetup(value.left) && isTeamSetup(value.right);
}

function isRosterTeam(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.name === 'string' &&
    Array.isArray(value.players) &&
    value.players.every(
      (player) => isObject(player) && typeof player.name === 'string' && player.name.trim() !== '',
    ) &&
    (value.startingLineup === undefined || isNonEmptyStringArray(value.startingLineup))
  );
}

function isScorekeeperFormat(value: unknown): boolean {
  if (!isObject(value)) return false;
  const regulation = value.regulation;
  const bonus = value.bonus;
  const overtime = value.overtime;
  const lightning = value.lightning;
  const players = value.players;
  const structurallyValid =
    isInteger(value.version) &&
    typeof value.name === 'string' &&
    Array.isArray(value.answerTypes) &&
    value.answerTypes.every(
      (answerType) =>
        isObject(answerType) &&
        isInteger(answerType.index) &&
        isFiniteNumber(answerType.value) &&
        typeof answerType.label === 'string' &&
        typeof answerType.shortLabel === 'string' &&
        typeof answerType.isPower === 'boolean' &&
        typeof answerType.isNeg === 'boolean' &&
        typeof answerType.awardsBonus === 'boolean' &&
        typeof answerType.qbjId === 'string',
    ) &&
    isObject(regulation) &&
    typeof regulation.timed === 'boolean' &&
    isInteger(regulation.tossupCount) &&
    isInteger(regulation.maximumTossupCount) &&
    isObject(bonus) &&
    typeof bonus.enabled === 'boolean' &&
    typeof bonus.bounceBack === 'boolean' &&
    typeof bonus.regular === 'boolean' &&
    isFiniteNumber(bonus.divisor) &&
    isInteger(bonus.minimumParts) &&
    isInteger(bonus.maximumParts) &&
    (bonus.pointsPerPart === undefined || isFiniteNumber(bonus.pointsPerPart)) &&
    isFiniteNumber(bonus.maximumScore) &&
    isObject(overtime) &&
    isInteger(overtime.minimumQuestionCount) &&
    typeof overtime.suddenDeath === 'boolean' &&
    typeof overtime.includesBonuses === 'boolean' &&
    isObject(lightning) &&
    typeof lightning.enabled === 'boolean' &&
    isInteger(lightning.countPerTeam) &&
    isFiniteNumber(lightning.divisor) &&
    isObject(players) &&
    isInteger(players.maximumActive) &&
    isFiniteNumber(value.totalDivisor);
  return structurallyValid && scorekeeperFormatProblems(value as unknown as IScorekeeperFormat).length === 0;
}

function isPackage(value: unknown): boolean {
  if (!isObject(value)) return false;
  const tournament = value.tournament;
  const round = value.round;
  return (
    typeof value.format === 'string' &&
    isInteger(value.version) &&
    isObject(tournament) &&
    typeof tournament.name === 'string' &&
    isObject(round) &&
    isInteger(round.number) &&
    typeof round.name === 'string' &&
    isInteger(round.revision) &&
    isRosterTeam(value.left) &&
    isRosterTeam(value.right) &&
    isScorekeeperFormat(value.scorekeeperFormat)
  );
}

/**
 * Whether a migrated object has the parts a scoresheet cannot do without.
 *
 * Checked after the steps run rather than trusted, because a step is code somebody wrote in a hurry
 * before a tournament and the cost of it being wrong is a crash on the welcome screen — which is the
 * screen a room reaches by reloading mid-round.
 */
function isGameRecord(value: RawRecord): value is RawRecord & IStoredGameRecord {
  return (
    isInteger(value.version) &&
    typeof value.id === 'string' &&
    typeof value.identity === 'string' &&
    isInteger(value.attempt) &&
    value.attempt >= 1 &&
    typeof value.gameKey === 'string' &&
    isPackage(value.package) &&
    isSetup(value.setup) &&
    Array.isArray(value.events) &&
    typeof value.connected === 'boolean' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.serverDelivery === 'none' ||
      value.serverDelivery === 'pending' ||
      value.serverDelivery === 'sent' ||
      value.serverDelivery === 'rejected')
  );
}

export function readStoredRecord(
  raw: unknown,
  options: { target?: number; steps?: Readonly<Record<number, UpgradeStep>> } = {},
): IReadRecord {
  const target = options.target ?? gameRecordVersion;
  const steps = options.steps ?? upgradeSteps;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { readability: 'unreadable', record: null, storedVersion: null };
  }
  const stored = raw as RawRecord;
  const version = stored.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { readability: 'unreadable', record: null, storedVersion: null };
  }
  if (version > target) {
    return { readability: 'too-new', record: null, storedVersion: version };
  }

  let working = stored;
  for (let from = version; from < target; from += 1) {
    const step = steps[from];
    // A gap in the table is a build that changed the schema and did not say how to read the old one.
    // Refusing is the only honest answer; guessing would corrupt a game rather than fail to open it.
    if (!step) return { readability: 'unreadable', record: null, storedVersion: version };
    try {
      working = { ...step(working), version: from + 1 };
    } catch {
      return { readability: 'unreadable', record: null, storedVersion: version };
    }
  }

  if (!isGameRecord(working)) {
    return { readability: 'unreadable', record: null, storedVersion: version };
  }
  return {
    readability: version === target ? 'current' : 'upgraded',
    // `version` is set from the target rather than carried, so a record that needed no steps because
    // every change was additive still reports the version whose shape it now satisfies.
    record: { ...(working as unknown as IStoredGameRecord), version: target },
    storedVersion: version,
  };
}

/** What a build could not read, for the front door and for a diagnostics file. */
export interface IUnreadableRecord {
  id: string;
  readability: Exclude<RecordReadability, 'current' | 'upgraded'>;
  storedVersion: number | null;
}
