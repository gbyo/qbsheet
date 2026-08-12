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

/**
 * Split a roster typed one name per line into candidate names.
 *
 * Not the authority on what a roster is — `defineGame`'s `overrides.rosters` is, and a file's roster
 * goes through the same rules there. This is the same judgement shown early, so somebody sees the
 * problem while looking at the box rather than after submitting.
 *
 * Here rather than beside a form because two forms now read a textarea this way: the one that fills
 * in a roster a QBJ left out, and the one that creates a game from nothing. Blank lines dropped by
 * one and kept by the other is the kind of difference nobody notices until two rosters disagree
 * about how many players a team has.
 */
export function readRosterLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** What is wrong with what has been typed so far, in words a scorekeeper can act on. */
export function rosterLineProblems(names: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (name.length > playerNameMaxLength) {
      problems.push(`"${name.slice(0, 20)}…" is too long to be a name.`);
      continue;
    }
    if (seen.has(name)) problems.push(`"${name}" is listed more than once.`);
    seen.add(name);
  }
  return problems;
}

export interface IPlayerNameValidation {
  /** The value that may be written to the roster. */
  name: string;
  /** A short, user-facing reason the value cannot be written. */
  problem?: string;
}

/**
 * Validate a player name typed anywhere in the scorer.
 *
 * Roster additions are available both before question one and during the game. Keeping the trim,
 * length and duplicate rules here prevents those two screens from developing subtly different
 * definitions of the same roster name.
 */
export function validatePlayerName(value: string, existingNames: readonly string[]): IPlayerNameValidation {
  const name = value.trim();
  if (name === '') return { name, problem: 'Enter a player name.' };
  if (name.length > playerNameMaxLength) {
    return { name, problem: `Player names can be at most ${playerNameMaxLength} characters.` };
  }
  if (existingNames.some((existing) => existing.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return { name, problem: `${name} is already on this roster.` };
  }
  return { name };
}
