/**
 * A team and the people on it, as the scorer needs them.
 *
 * Deliberately the smallest thing that works: a name, and a list of names. No identifiers, no
 * affiliations, no registration record. The scoring engine refers to players by name within a game
 * (see `ScoreEvents`), so anything else carried here would be decoration that has to be kept
 * consistent for no benefit.
 *
 * Extracted from `IRoomTeam` in YellowFruit's tournament-server types, which travels over the same
 * wire and has the same shape.
 */

export interface IRosterPlayer {
  name: string;
}

export interface ITeamRoster {
  name: string;
  players: IRosterPlayer[];
}

/**
 * Longest player name accepted from a file or typed into the roster.
 *
 * Matches the tournament server's own limit, so a name added on a Chromebook is a name the desktop
 * will accept rather than one it silently truncates.
 */
export const playerNameMaxLength = 200;
