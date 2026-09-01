/**
 * What the scorer is built against, and the reason there is only one of it.
 *
 * # Internal, and that is the point
 *
 * `IGamePackage` was a public file specification: a room downloaded one, a producer wrote one, and
 * its version number was a contract between two applications. `GameDefinition` inherits its shape
 * and none of that. It is never written to disk, never sent over the network, and carries no public
 * version. Nothing outside this repository is expected to produce or consume it.
 *
 * That demotion is the substantive change, not the name. A public assignment format meant the file
 * path and the network path each had a schema, and two schemas for the same idea drift — one gains
 * a field, the other gains it later and spells it differently, and a bug appears that only shows up
 * over the network or only shows up offline. Now both paths parse QBJ and both produce this, so
 * "the connected assignment and the file assignment agree" is a property of the type system rather
 * than of somebody remembering.
 *
 * # Why it keeps the package's shape
 *
 * The scorer, the recovery journal, the derived-game engine, and every dialog already speak
 * `IGamePackage`. Rewriting all of them to a differently-shaped type would be a large diff whose
 * only product is a different set of field names, and the migration is already large. So this
 * extends the existing shape with the two things QBJ import needs and leaves the rest alone.
 *
 * # What it adds
 *
 * Standard QBJ identities, so that a result can be the assignment filled in rather than a new
 * document that resembles it, and the provenance of the definition, so the application can say
 * honestly where a game came from and what it had to assume.
 */
import { IGamePackage } from './GamePackage';

/**
 * The standard QBJ identities carried through from an assignment to its result.
 *
 * All optional, because a Match-only import or a legacy `.qbg` will not have them. When they are
 * present the result reuses them exactly, which is what makes reconciliation on the
 * tournament-control side a lookup instead of a fuzzy filename match.
 */
export interface IQbjIdentity {
  tournamentId?: string;
  /** The scheduled match. The strongest identity a result can carry. */
  matchId?: string;
  phaseId?: string;
  roundId?: string;
  /**
   * `Round.name` exactly as the document spelled it.
   *
   * Kept separately from the definition's display name because the two are not the same string and
   * the difference is load-bearing. The reference importer resolves a round by running `parseInt`
   * over this field, and writes it as a bare number ("4") for a numeric round while showing
   * "Round 4" to a human. Round-tripping the display name into it would produce a document whose
   * round cannot be resolved by the software most likely to import it.
   */
  roundQbjName?: string;
  phaseName?: string;
  scoringRulesId?: string;
  teamIds?: { left?: string; right?: string };
  /**
   * Player ids, keyed by `${teamName}\u001f${playerName}`.
   *
   * Keyed by name because that is how the scoring engine refers to a player within a game; see
   * `ScoreEvents`. The separator is an explicit `\u001f` escape rather than a literal control
   * character, which is invisible in a diff and easy to retype as a space -- and a key built with a
   * space would collide the moment a team name ended with one.
   */
  playerIds?: Record<string, string>;
  /** Registrations, so an exported result can rebuild the objects the assignment came with. */
  registrationIds?: { left?: string; right?: string };
}

/** Where a definition came from. For honest display and for logs; never a branch in scoring. */
export type GameDefinitionOrigin =
  /** Official serialized QBJ, `{version, objects}` — from a file or from QBTCP. */
  | 'qbj'
  /** A bare Match object, as MODAQ and legacy workflows produce. */
  | 'qbj-match-only'
  /** A legacy `.qbg` package, converted through the compatibility path. */
  | 'qbg'
  /**
   * The pre-QBTCP `/api/v1` assignment response, which is JSON of its own shape rather than QBJ.
   *
   * Retained so a room can still be assigned a game by a tournament-control build that predates
   * QBJ assignment delivery. Distinguished from `qbj` because it did not come through the QBJ
   * parser and carries no standard QBJ identities to preserve into its result.
   */
  | 'legacy-assignment'
  /**
   * Typed in on this device: a practice, a scrimmage, a pickup game, anything unscheduled.
   *
   * Carries no assignment identity of any kind, because there was no assignment. The scoring engine
   * never sees this — a manual game is an ordinary game the moment it starts — but two things
   * outside the engine do read it: the record identity a manual game is filed under, and whether
   * anybody is owed the finished file. See `newManualRecordIdentity` and `gameRequiresHandoff`.
   */
  | 'manual';

/** A deliberate human decision to continue when automatic procedure enforcement is unavailable. */
export interface IProcedureEnforcementOverride {
  kind: 'moderator-instructions';
  unsupportedVersion: number;
}

export interface IGameDefinition extends IGamePackage {
  /** Standard QBJ identities, where the source had them. */
  qbjIdentity?: IQbjIdentity;
  origin: GameDefinitionOrigin;
  /**
   * Values the source did not state that were filled in, in words a scorekeeper can act on.
   *
   * Shown, never hidden. A definition that had to assume something is still scoreable; a
   * scorekeeper who does not know what was assumed is the failure this prevents.
   */
  assumptions?: string[];
  /** Present only after an explicit moderator decision; never inferred from an unreadable procedure. */
  procedureOverride?: IProcedureEnforcementOverride;
}

/**
 * Whether this game was created by hand on this device.
 *
 * Takes an `IGamePackage` because that is what a stored record holds, and a record written before
 * definitions carried provenance has no `origin` at all — which reads as "not manual", correctly.
 */
export function isManualGame(packageValue: IGamePackage): boolean {
  return (packageValue as Partial<IGameDefinition>).origin === 'manual';
}

/** Build the player-id key. One place, so the read and the write cannot disagree. */
export function playerIdentityKey(teamName: string, playerName: string): string {
  return `${teamName}\u001f${playerName}`;
}

/** Look up a player's QBJ id, when the source carried one. */
export function playerQbjId(
  definition: IGameDefinition,
  teamName: string,
  playerName: string,
): string | undefined {
  return definition.qbjIdentity?.playerIds?.[playerIdentityKey(teamName, playerName)];
}
