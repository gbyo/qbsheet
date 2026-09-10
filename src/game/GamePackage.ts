/**
 * Everything needed to score one game, and nothing else.
 *
 * # Why a game file rather than a tournament file
 *
 * A room scores one game at a time. It does not need the standings, the other rooms, the future
 * pairings, or the match history, and every one of those is something that would be wrong by the
 * time the round ended. Worse, a tournament file handed to sixteen Chromebooks is sixteen copies of
 * information a director may need to correct, and there is no mechanism to correct them.
 *
 * So the unit of transfer is one game: small enough to email, to put on a USB stick, or to drop in
 * a shared folder, and self-contained enough that a room with no network at all can score it.
 *
 * # What is deliberately absent
 *
 * No room access token, no session token, no device secret, no server address, no credentials of
 * any kind. A game file is the least controlled object a tournament produces — it travels by USB
 * stick, by email, by whatever folder somebody shared — and a capability that travels with it is a
 * capability that ends up somewhere nobody intended. A connected room's credentials live in that
 * browser's own storage and stay there; see `ConnectedSession`.
 *
 * Also absent: standings, other rooms' games, unreleased pairings, and anything else that would
 * make this a projection of the tournament rather than a description of a game.
 *
 * # Identity, and why the filename is not it
 *
 * Rebracketing means a game file can be superseded before it is ever opened. A package therefore
 * carries the identity of the assignment that produced it — the scheduled match where the source
 * knows one, and always a round revision — so a result can say which assignment it was scored from
 * and tournament control can tell a current result from one scored against a pairing that has since
 * been redrawn. Filenames are advisory; two rooms will rename them, and one will not.
 */
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IRoomProcedure } from '../scoring/RoomProcedure';
import { ITeamRoster } from './Roster';

/** The discriminator every game file starts with, so a wrong file is refused rather than parsed. */
export const gamePackageFormat = 'quizbowl-game';

/** The canonical application that owns the portable room scorer contract. */
export const gamePackageProducer = 'QBSheet' as const;

/** Bumped when the shape changes incompatibly. An unrecognized version is refused, never guessed. */
export const gamePackageVersion = 1;

/**
 * Provisional file extension, short for Quiz Bowl Game.
 *
 * Provisional in the sense that it is not registered with anybody and is not branding. It exists so
 * a folder of sixteen of these is distinguishable at a glance from the QBJs coming back the other
 * way.
 */
export const gamePackageFileExtension = '.qbg';

export interface IGamePackageTournament {
  /**
   * Stable identity of the tournament, independent of its display name.
   *
   * Optional because a file written by hand or by another tool may not have one. When it is present
   * it is what a result is matched on; when it is absent the display name is all there is.
   */
  key?: string;
  name: string;
}

export interface IGamePackageRound {
  number: number;
  /** What the round is called on the schedule — "Round 7", "Playoff 2", "Finals". */
  name: string;
  /**
   * Which issue of this round's assignments this package came from.
   *
   * Incremented by the source whenever the pairing for a round is redrawn. A result carries the
   * revision it was scored under, so a correction that causes a rebracket cannot be silently
   * overwritten by a package that was downloaded before the redraw. Starts at 1.
   */
  revision: number;
  /** Which issue of this room's assignment was delivered, separate from the round pairing revision. */
  assignmentRevision?: number;
  /** The packet this round uses, when the tournament named one. Identity only; no content. */
  packetName?: string;
}

export interface IGamePackageRoom {
  id?: string;
  name?: string;
}

/**
 * The identity of the issued competitive definition a package was cut from (#670).
 *
 * The revision is convenient and auditable; the digest proves equality. Both travel so a
 * result can say exactly which truth it was scored under, not merely which pairing.
 */
export interface GameDefinitionIdentity {
  /** 1-based revision within the scheduled game. */
  revision: number;
  /** Deterministic digest over the canonical competitive semantics. */
  digest: string;
}

export interface IGamePackageTeam extends ITeamRoster {
  /**
   * Who starts, when the source already knows.
   *
   * Optional, and normally absent: which four players start is a decision made in the room a minute
   * before the game, not something a schedule can predict. A package that does carry one skips the
   * starting-lineup prompt, which is why it is validated as strictly as a lineup the scorekeeper
   * would have chosen — a subset of the roster, no repeats, within the format's active limit.
   */
  startingLineup?: string[];
}

export interface IGamePackage {
  format: typeof gamePackageFormat;
  version: number;
  /** Optional on legacy files; new Fruity exports identify the canonical QBSheet producer. */
  producer?: typeof gamePackageProducer;
  tournament: IGamePackageTournament;
  /**
   * The scheduled match this package was cut from, where the source has one.
   *
   * The strongest identity a result can carry, and the first thing an import matches on. Absent for
   * a package describing a game that is not on anybody's schedule.
   */
  scheduledMatchId?: string;
  round: IGamePackageRound;
  room?: IGamePackageRoom;
  /** The team in the left column of the scoresheet. */
  left: IGamePackageTeam;
  /** The team in the right column. */
  right: IGamePackageTeam;
  /** The tournament's scoring rules, as structural data. See `IScorekeeperFormat`. */
  scorekeeperFormat: IScorekeeperFormat;
  /**
   * The issued competitive-definition identity this package was cut from (#670).
   *
   * Present exactly when Director issued the game from a pinned snapshot. The room echoes it
   * in its result so ingest can prove the game was scored under the expected truth rather than
   * merely under the same pairing. Absent on legacy/hand-made packages, which ingest treats as
   * weaker provenance, never as equivalence.
   */
  definition?: GameDefinitionIdentity;
  /** How the room runs the game — halves, clock, timeouts. Absent means it runs none of it. */
  procedure?: IRoomProcedure;
  /**
   * What the room should do with the finished QBJ, in the tournament's own words.
   *
   * Free text, shown verbatim on the completion screen. This is where "upload to the Round 7 folder
   * in the shared drive" lives, so the application never has to know what a shared drive is.
   */
  handoffInstruction?: string;
}

/**
 * A stable local identity for the game this package describes.
 *
 * Used to recognize that a file being opened is a game this device already has, so a second copy of
 * the file resumes the game rather than starting a duplicate. The scheduled match is the identity
 * when there is one; otherwise the tournament, round and the two teams are, because that is the
 * combination a schedule guarantees is unique and a human would use to name the same game.
 *
 * The revision is deliberately *not* part of it: a re-issued package for the same game is the same
 * game, and the point of noticing that is to be able to warn about the revision rather than to file
 * the two separately.
 */
export function gamePackageIdentity(packageValue: IGamePackage): string {
  if (packageValue.scheduledMatchId) return `match:${packageValue.scheduledMatchId}`;
  const tournament = packageValue.tournament.key ?? packageValue.tournament.name;
  const teams = [packageValue.left.name, packageValue.right.name].sort().join('\u0000');
  return `game:${tournament}\u0000${packageValue.round.number}\u0000${teams}`;
}

/** How a game reads in a list: "Round 7 · Room 204". */
export function gamePackageLabel(packageValue: IGamePackage): string {
  const room = packageValue.room?.name;
  return room ? `${packageValue.round.name} · ${room}` : packageValue.round.name;
}

/** "Ninety Six A vs Greenwood". */
export function gamePackageMatchup(packageValue: IGamePackage): string {
  return `${packageValue.left.name} vs ${packageValue.right.name}`;
}
