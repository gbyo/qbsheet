/**
 * The finished game as a human-readable stat sheet, for a room with nowhere to send it.
 *
 * # Why this is not the canonical spreadsheet export
 *
 * `SpreadsheetGame` serializes the whole game — every event, the rules, the procedure — so that it
 * can be read back. Every cell in it is prefixed and JSON-quoted, which is exactly right for a
 * format that has to survive a round trip and exactly wrong for the tournament official who has a
 * blank Google Sheet open and needs the player lines in it before the next round starts.
 *
 * So this is a second *presentation* of the same derived game, not a second source of truth. It
 * recalculates nothing: it reads `IDerivedGame` and `IScorekeeperFormat`, which is what the review
 * screen's tables read, so a number here that disagreed with the screen would be a bug in the
 * caller rather than a difference of opinion between two engines.
 *
 * # Columns come from the format
 *
 * One column per answer type, in the format's own order, headed by its signed value. A format with
 * no neg has no neg column, because it has no such answer type — nothing here knows what 15, 10 or
 * -5 mean.
 */
import { IScorekeeperFormat } from './ScorekeeperFormat';
import { IDerivedGame, IDerivedTeam } from './deriveGame';

/** "+15" / "-5". The same column heading the review tables use. */
export function signedAnswerValue(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * One cell of pasteable text.
 *
 * Tabs and newlines are the grid separators here, so a name carrying one would silently become two
 * cells or two rows; they collapse to spaces. A leading `=`, `+`, `-` or `@` is quoted so a team
 * called "-5 Club" arrives in a spreadsheet as text rather than as a formula.
 */
export function statsCell(value: string): string {
  const flattened = value.replace(/[\t\r\n]+/g, ' ').trim();
  return /^[=+\-@]/.test(flattened) ? `'${flattened}` : flattened;
}

function teamSummaryRow(team: IDerivedTeam, columns: readonly StatsTeamColumn[]): string[] {
  return [statsCell(team.name), ...columns.map((column) => String(column.value(team)))];
}

interface StatsTeamColumn {
  heading: string;
  value: (team: IDerivedTeam) => number;
}

/**
 * The team columns worth printing for this game.
 *
 * Points, tossups and bonuses always; bouncebacks, lightning and adjustments only when the game
 * actually has any. An empty "Bouncebacks" column in a format with no bouncebacks is a question the
 * person transcribing this has to stop and answer.
 */
function teamColumns(game: IDerivedGame): StatsTeamColumn[] {
  const columns: StatsTeamColumn[] = [
    { heading: 'Points', value: (team) => team.points },
    { heading: 'Tossups', value: (team) => team.tossupPoints },
    { heading: 'Bonuses', value: (team) => team.bonusPoints },
  ];
  const either = (read: (team: IDerivedTeam) => number) => read(game.left) !== 0 || read(game.right) !== 0;
  if (either((team) => team.bonusBouncebackPoints)) {
    columns.push({ heading: 'Bouncebacks', value: (team) => team.bonusBouncebackPoints });
  }
  if (either((team) => team.lightningPoints)) {
    columns.push({ heading: 'Lightning', value: (team) => team.lightningPoints });
  }
  if (either((team) => team.adjustmentPoints)) {
    columns.push({ heading: 'Adjustment', value: (team) => team.adjustmentPoints });
  }
  return columns;
}

function overtimeAnswerCountRow(
  format: IScorekeeperFormat,
  team: IDerivedTeam,
): string[] {
  return [
    statsCell(team.name),
    ...format.answerTypes.map((answerType) => String(team.overtimeBuzzes.get(answerType.index) ?? 0)),
  ];
}

export interface IStatsSheetOptions {
  /** What the room calls this game — "R1 · 315". Omitted entirely when there is nothing to say. */
  gameLabel?: string;
}

/**
 * The stat sheet as a grid, newest facts first: identity, result, teams, then the player lines.
 *
 * A grid rather than text so the clipboard sidecar can build its HTML table flavor from the same
 * rows the TSV is made of.
 */
export function derivedStatsGrid(
  format: IScorekeeperFormat,
  game: IDerivedGame,
  options: IStatsSheetOptions = {},
): string[][] {
  const label = options.gameLabel?.trim() ?? '';
  const columns = teamColumns(game);
  const grid: string[][] = [];

  if (label !== '') grid.push(['Game', statsCell(label)]);
  grid.push([
    'Result',
    statsCell(game.left.name),
    String(game.left.points),
    statsCell(game.right.name),
    String(game.right.points),
  ]);
  grid.push(['Tossups heard', String(game.tossupsRead)]);
  if (game.overtimeTossupsRead > 0) {
    grid.push(['Overtime tossups', String(game.overtimeTossupsRead)]);
  }
  grid.push([]);

  grid.push(['Team', ...columns.map((column) => column.heading)]);
  grid.push(teamSummaryRow(game.left, columns));
  grid.push(teamSummaryRow(game.right, columns));
  grid.push([]);

  if (game.overtimeTossupsRead > 0) {
    // Player answer counts include overtime, matching the aggregate shape used by QBJ/YellowFruit.
    // Keep the team-level overtime counts too so a no-bonus overtime conversion can be excluded from
    // bonuses heard instead of looking like an ordinary regulation conversion after transcription.
    grid.push(['Overtime answer counts']);
    grid.push(['Team', ...format.answerTypes.map((answerType) => signedAnswerValue(answerType.value))]);
    grid.push(overtimeAnswerCountRow(format, game.left));
    grid.push(overtimeAnswerCountRow(format, game.right));
    grid.push([]);
  }

  grid.push([
    'Team',
    'Player',
    'TUH',
    ...format.answerTypes.map((answerType) => signedAnswerValue(answerType.value)),
    'Pts',
  ]);
  for (const team of [game.left, game.right]) {
    for (const player of team.players) {
      // The same line the review table draws: somebody who never heard a tossup and never buzzed
      // was on the roster, not in the game, and a row of zeroes for them is noise to transcribe.
      if (player.tossupsHeard === 0 && player.answerCounts.size === 0) continue;
      grid.push([
        statsCell(team.name),
        statsCell(player.name),
        String(player.tossupsHeard),
        ...format.answerTypes.map((answerType) => String(player.answerCounts.get(answerType.index) ?? 0)),
        String(player.points),
      ]);
    }
  }

  return grid;
}

/** The grid as tab-separated text, which is what a spreadsheet paste wants. */
export function serializeDerivedStats(
  format: IScorekeeperFormat,
  game: IDerivedGame,
  options: IStatsSheetOptions = {},
): string {
  return derivedStatsGrid(format, game, options)
    .map((row) => row.join('\t'))
    .join('\n');
}
