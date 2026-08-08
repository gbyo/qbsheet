/**
 * The small cache that makes emergency scoring possible.
 *
 * A room that cannot reach YellowFruit cannot be told what to play, and must not guess. But a room
 * that reached YellowFruit an hour ago already knows the things that do not change during a
 * tournament: what the scoring rules are, who the teams are, who is on them, and what the rounds
 * are called. Keeping that much means a director standing in a corridor with a dead server can say
 * "score it manually, we'll import it" and the scorekeeper can actually do it.
 *
 * What is cached is an allowlist, not a snapshot with a few things removed. The distinction matters
 * because the assignment response grows: a field added upstream for the control room must not
 * silently start living on every Chromebook. So this file names the seven things it keeps, and
 * anything else in the response — other rooms' credentials, server sessions, the unreleased Match
 * Plan, director controls, private room configuration — is not copied because there is nowhere for
 * it to go.
 */
import { IModaqGameFormat } from '../renderer/Services/YellowFruitScoringRulesToModaq';
import { IScorekeeperFormat, scorekeeperFormatProblems } from '../renderer/Services/ScorekeeperFormat';
import { IRoomProcedure, readRoomProcedure } from '../renderer/Services/RoomProcedure';
import { IRoomRound, IRoomTeam, RoomScorerKind } from '../main/server/ServerTypes';

/**
 * Bumped when the kit's shape changes. An unrecognized version is treated as no kit at all.
 *
 * Deliberately not bumped for `scoringFormat`. Bumping discards every kit already sitting in a
 * Chromebook's localStorage, which is the opposite of what this cache is for: the devices that would
 * lose emergency scoring are exactly the ones that cannot reach YellowFruit to re-sync. A kit
 * written before that field existed reads back with it null, which is indistinguishable from a
 * tournament whose rules could not be described, and both are already handled.
 */
export const scoringKitVersion = 1;

const scoringKitStorageKey = 'yellowfruit.room.scoring-kit.v1';

/**
 * How stale a kit may be and still be trusted.
 *
 * A tournament is a day. A kit older than that is far more likely to be left over from last
 * weekend's event than to be the one this room needs, and scoring a game against last weekend's
 * rosters is worse than not scoring it.
 */
export const scoringKitMaxAgeMs = 36 * 60 * 60 * 1000;

/** Everything an emergency game needs and nothing else. */
export interface IScoringKit {
  version: number;
  /** Tournament identity, so a kit cannot be used for a different tournament. */
  tournamentKey?: string;
  tournamentName: string;
  /** The scoring rules, in the form MODAQ needs. Null means emergency scoring is not possible. */
  gameFormat: IModaqGameFormat | null;
  /**
   * The scoring rules as structural data, for the first-party scorer.
   *
   * Null both for a kit written before this field existed and for one cached with no tournament
   * loaded. `ManualRoomApp` reads it for emergency first-party scoring, and
   * `isScoringKitUsable` validates it when the first-party scorer is selected; `gameFormat` remains
   * the corresponding requirement for the legacy scorer.
   */
  scoringFormat: IScorekeeperFormat | null;
  /** Timed rounds can end before every regulation tossup is read. */
  timedRounds: boolean;
  /** How the room runs a game: halves, clock, timeouts. Inert when absent. */
  roomProcedure?: IRoomProcedure;
  teams: IRoomTeam[];
  rounds: IRoomRound[];
  /** Which room cached this. Used for labelling and filenames, never as a credential. */
  roomId?: string;
  roomName?: string;
  /** ISO 8601 */
  updatedAt: string;
}

/** The fields a caller supplies; the version and timestamp are this module's business. */
export interface IScoringKitSource {
  tournamentKey?: string;
  tournamentName: string;
  gameFormat: IModaqGameFormat | null;
  scoringFormat: IScorekeeperFormat | null;
  timedRounds: boolean;
  roomProcedure?: IRoomProcedure;
  teams: IRoomTeam[];
  rounds: IRoomRound[];
  roomId?: string;
  roomName?: string;
}

interface IStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): IStorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Copy only the roster fields. A team object from the wire may carry more than a name and players. */
function copyTeams(teams: unknown): IRoomTeam[] {
  if (!Array.isArray(teams)) return [];
  return teams.flatMap((team) => {
    const name = (team as IRoomTeam)?.name;
    if (typeof name !== 'string' || name === '') return [];
    const players = Array.isArray((team as IRoomTeam)?.players) ? (team as IRoomTeam).players : [];
    return [
      {
        name,
        players: players.flatMap((player) =>
          typeof player?.name === 'string' && player.name !== '' ? [{ name: player.name }] : [],
        ),
      },
    ];
  });
}

function copyRounds(rounds: unknown): IRoomRound[] {
  if (!Array.isArray(rounds)) return [];
  return rounds.flatMap((round) => {
    const number = (round as IRoomRound)?.number;
    if (typeof number !== 'number' || !Number.isFinite(number)) return [];
    const name = typeof (round as IRoomRound)?.name === 'string' ? (round as IRoomRound).name : String(number);
    return [{ number, name }];
  });
}

/** Build a kit from whatever the room last successfully loaded. */
export function buildScoringKit(source: IScoringKitSource, now: Date = new Date()): IScoringKit {
  return {
    version: scoringKitVersion,
    tournamentKey: source.tournamentKey,
    tournamentName: source.tournamentName,
    gameFormat: source.gameFormat,
    scoringFormat: source.scoringFormat,
    timedRounds: source.timedRounds === true,
    roomProcedure: source.roomProcedure,
    teams: copyTeams(source.teams),
    rounds: copyRounds(source.rounds),
    roomId: source.roomId,
    roomName: source.roomName,
    updatedAt: now.toISOString(),
  };
}

/**
 * Is this kit good enough to score a real game against?
 *
 * All four conditions are about not producing a result nobody can use: without rules there is no
 * MODAQ, without teams there is nothing to pick, and a kit from a different day is a kit from a
 * different tournament.
 */
export function isScoringKitUsable(kit: IScoringKit | null, now?: Date, scorer?: RoomScorerKind): kit is IScoringKit {
  if (!kit) return false;
  const checkedAt = now ?? new Date();
  // Kits written before the selector existed may contain only MODAQ rules. If no choice was
  // supplied, use whichever rules this kit actually carries; active room pages pass explicitly.
  const selectedScorer = scorer ?? (kit.scoringFormat !== null ? 'first-party' : 'legacy');
  if (kit.version !== scoringKitVersion) return false;
  if (selectedScorer === 'legacy' && kit.gameFormat === null) return false;
  if (
    selectedScorer === 'first-party' &&
    (kit.scoringFormat === null || scorekeeperFormatProblems(kit.scoringFormat).length > 0)
  )
    return false;
  if (kit.teams.length < 2) return false;
  if (kit.rounds.length === 0) return false;
  const updated = new Date(kit.updatedAt).getTime();
  if (!Number.isFinite(updated)) return false;
  const ageMs = checkedAt.getTime() - updated;
  return ageMs >= 0 && ageMs <= scoringKitMaxAgeMs;
}

/** Why emergency scoring is unavailable, in words a scorekeeper can act on. */
export function describeUnusableKit(kit: IScoringKit | null, now?: Date, scorer?: RoomScorerKind): string {
  if (!kit) return 'This device has not loaded tournament information yet, so it cannot score a game on its own.';
  const checkedAt = now ?? new Date();
  const selectedScorer = scorer ?? (kit.scoringFormat !== null ? 'first-party' : 'legacy');
  if (kit.version !== scoringKitVersion) {
    return 'The tournament information saved on this device is from an older version and cannot be used.';
  }
  if (selectedScorer === 'legacy' && kit.gameFormat === null)
    return "This tournament's scoring rules cannot be used by the legacy scorer.";
  if (selectedScorer === 'first-party' && kit.scoringFormat === null)
    return "This tournament's scoring rules cannot be used by the room scorer.";
  if (selectedScorer === 'first-party' && scorekeeperFormatProblems(kit.scoringFormat!).length > 0)
    return "This tournament's scoring rules cannot be used by the room scorer.";
  if (kit.teams.length < 2 || kit.rounds.length === 0) {
    return 'The tournament information saved on this device is incomplete.';
  }
  const updated = new Date(kit.updatedAt).getTime();
  if (
    !Number.isFinite(updated) ||
    updated > checkedAt.getTime() ||
    checkedAt.getTime() - updated > scoringKitMaxAgeMs
  ) {
    return 'The tournament information saved on this device is too old to be trusted.';
  }
  return 'The tournament information saved on this device cannot be used.';
}

export function readScoringKit(storage: IStorageLike | null = browserStorage()): IScoringKit | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(scoringKitStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IScoringKit>;
    if (typeof parsed?.version !== 'number' || typeof parsed?.updatedAt !== 'string') return null;
    if (typeof parsed.tournamentName !== 'string') return null;
    return {
      version: parsed.version,
      tournamentKey: typeof parsed.tournamentKey === 'string' ? parsed.tournamentKey : undefined,
      tournamentName: parsed.tournamentName,
      gameFormat: (parsed.gameFormat as IModaqGameFormat | null) ?? null,
      scoringFormat: (parsed.scoringFormat as IScorekeeperFormat | null) ?? null,
      timedRounds: parsed.timedRounds === true,
      roomProcedure: readRoomProcedure(parsed.roomProcedure),
      teams: copyTeams(parsed.teams),
      rounds: copyRounds(parsed.rounds),
      roomId: typeof parsed.roomId === 'string' ? parsed.roomId : undefined,
      roomName: typeof parsed.roomName === 'string' ? parsed.roomName : undefined,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    // A corrupt kit is the same as no kit: emergency scoring is refused and says why.
    return null;
  }
}

/** @returns false when this browser refused the write, so nothing claims a cache that isn't there. */
export function writeScoringKit(kit: IScoringKit, storage: IStorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(scoringKitStorageKey, JSON.stringify(kit));
    return true;
  } catch {
    return false;
  }
}

export function clearScoringKit(storage: IStorageLike | null = browserStorage()): void {
  try {
    storage?.removeItem(scoringKitStorageKey);
  } catch {
    // Nothing useful to do; the kit's own age check remains the backstop.
  }
}
