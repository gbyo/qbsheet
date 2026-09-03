/**
 * The spreadsheet form of what `Standings & stats` draws.
 *
 * # Why this is one module rather than one per screen
 *
 * Publish and Standings both offer "standings CSV", and for a while they meant two different
 * things: Standings wrote a nine-column record table, and Publish wrote the *roster* importer's
 * team/player CSV under a `-standings.csv` filename. A director who exported from one page and
 * opened it expecting the other got columns that did not exist. Naming a file after data it does
 * not contain is the kind of mistake that is only found at the point somebody needs it.
 *
 * So the serialization lives here, once, and both pages call it. "Team standings CSV" means the
 * same columns wherever it is offered, and adding a column adds it in both places or neither.
 *
 * # Why it is not `@qbsheet/tournament-formats`'s stats CSV
 *
 * That package derives its own snapshot from the interchange document. Director's tables come from
 * `deriveTeamStandings`/`derivePlayerStandings`, which apply the tournament's configured tiebreak
 * order and its own power/tossup/neg values. Exporting a differently-derived table beside the one
 * on screen would be the same class of bug this module exists to remove, so the rows here are the
 * rows the screen is drawing; only the escaping is borrowed.
 */
import { serializeCsv } from '@qbsheet/tournament-formats';
import { derivePlayerStandings, deriveTeamStandings, type DirectorState } from '../domain';

export const teamStandingsCsvHeaders = [
  'rank',
  'team_id',
  'team',
  'games_played',
  'wins',
  'losses',
  'ties',
  'win_percentage',
  'points_for',
  'points_against',
  'margin',
  'powers',
  'gets',
  'negs',
  'bonuses_heard',
  'bonus_points',
  'ppb',
] as const;

export const playerStatsCsvHeaders = [
  'rank',
  'player_id',
  'player',
  'team_id',
  'team',
  'games_played',
  'tossups_heard',
  'powers',
  'gets',
  'negs',
  'bonus_points',
  'ppg',
] as const;

function teamName(state: DirectorState, teamId: string): string {
  return state.teams.find((team) => team.id === teamId)?.displayName ?? 'Unknown';
}

function ratio(numerator: number, denominator: number): string {
  return denominator === 0 ? '' : (numerator / denominator).toFixed(2);
}

/** The team table on `Standings & stats`, in the order the screen ranks it. */
export function teamStandingsCsv(state: DirectorState): string {
  return serializeCsv(
    teamStandingsCsvHeaders,
    deriveTeamStandings(state).map((standing, index) => [
      index + 1,
      standing.teamId,
      teamName(state, standing.teamId),
      standing.gamesPlayed,
      standing.wins,
      standing.losses,
      standing.ties,
      `${(standing.winPercentage * 100).toFixed(1)}%`,
      standing.pointsFor,
      standing.pointsAgainst,
      standing.margin,
      standing.powers,
      standing.gets,
      standing.negs,
      standing.bonuses,
      standing.bonusPoints,
      ratio(standing.bonusPoints, standing.bonuses),
    ]),
  );
}

/**
 * The player table on the same page.
 *
 * Players who have not played are left out for the same reason the screen leaves them out: a row of
 * zeroes ranked below everybody is not a statistic, and a roster export already exists for the
 * question "who is entered".
 *
 * `tossups_heard` is blank rather than a number when a contributing scoresheet did not report TUH.
 * A total that silently counted the games that did report it would read as a real figure.
 */
export function playerStatsCsv(state: DirectorState): string {
  const players = derivePlayerStandings(state).filter((standing) => standing.gamesPlayed > 0);
  return serializeCsv(
    playerStatsCsvHeaders,
    players.map((standing, index) => [
      index + 1,
      standing.playerId,
      state.players.find((player) => player.id === standing.playerId)?.name ?? 'Unknown',
      standing.teamId,
      teamName(state, standing.teamId),
      standing.gamesPlayed,
      standing.tossupsHeardKnown === false ? '' : standing.tossupsHeard,
      standing.powers,
      standing.gets,
      standing.negs,
      standing.bonusPoints,
      standing.ppg.toFixed(1),
    ]),
  );
}

/** `ninety-six-invitational`, or `tournament` when there is nothing to name it after. */
export function standingsFileStem(state: DirectorState): string {
  return (
    (state.tournament?.name ?? '')
      .trim()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '') || 'tournament'
  );
}
