/**
 * Full SQBS tournament data-file interchange.
 *
 * This is the complete tournament statistics file SQBS itself reads (teams,
 * players, games, scores, detail stats, divisions, packets, settings) — not
 * the roster-only report in `csv.ts`. The layout follows the public SQBS
 * data-file documentation (one value per line): unknown statistics cannot be
 * represented, so callers pass `null` for unknown TUH/bonus fields and the
 * serializer writes an honest `0` plus an aggregated warning. Anything SQBS
 * cannot represent at all (more than four tossup point values, more than
 * eight players on one team in a game) fails with an explicit error instead
 * of producing a misleading file.
 */

import type { FormatError, FormatReport, FormatWarning } from './types';
import { error, fail, ok, warning } from './util';

export interface SqbsTournamentTeam {
  name: string;
  /** Full roster in file order. Only players who hear tossups in a game consume one of the 8 per-game slots. */
  players: string[];
  /** 0-based division index, or -1 for no division. */
  divisionIndex: number;
  exhibition?: boolean;
}

export interface SqbsPlayerGame {
  /** 0-based index into the team's roster. */
  playerIndex: number;
  /** Fraction of the game played, 0 to 1. Serialized with two decimals. */
  gamesPlayed: number;
  /** Tossup counts aligned with the file's four point-value slots. */
  counts: [number, number, number, number];
  points: number;
}

export interface SqbsSideGame {
  teamIndex: number;
  score: number;
  bonusesHeard: number | null;
  bonusPoints: number | null;
  /** Count of heard bouncebacks, when the format tracks them. */
  bouncebacksHeard?: number | null;
  bouncebackPoints?: number | null;
  tossupsWithoutBonus?: number;
  lightningPoints?: number;
  /** Players who heard tossups, at most 8. */
  players: SqbsPlayerGame[];
}

export interface SqbsTournamentGame {
  /** Match id. SQBS treats it as an opaque number; it need not be sequential. */
  id: number;
  round: number;
  left: SqbsSideGame;
  right: SqbsSideGame;
  tossupsHeard: number | null;
  overtime?: boolean;
  /**
   * Which side won by forfeit. The serializer always writes the winner on
   * the left, as SQBS requires. `'double'` games are skipped with a warning:
   * SQBS cannot represent them.
   */
  forfeitWinner?: 'left' | 'right' | 'double' | null;
}

export interface SqbsTournamentInput {
  tournamentName: string;
  /** Nonzero tossup point values in slot order. At most four; more is an error. */
  pointValues: number[];
  useBonuses: boolean;
  bouncebacks?: boolean;
  trackPowers?: boolean;
  trackLightning?: boolean;
  /** Empty means no divisions. */
  divisions: string[];
  teams: SqbsTournamentTeam[];
  games: SqbsTournamentGame[];
  /** Packet name per exported round, in round order. */
  packetNames: string[];
}

export interface SqbsParsedPlayer {
  name: string;
}

export interface SqbsParsedTeam {
  name: string;
  players: SqbsParsedPlayer[];
  divisionIndex: number;
  exhibition: boolean;
}

export interface SqbsParsedPlayerGame {
  playerIndex: number;
  gamesPlayed: number;
  counts: [number, number, number, number];
  points: number;
}

export interface SqbsParsedSideGame {
  teamIndex: number;
  score: number;
  bonusesHeard: number;
  bonusPoints: number;
  bouncebacksHeard: number;
  bouncebackPoints: number;
  tossupsWithoutBonus: number;
  lightningPoints: number;
  players: SqbsParsedPlayerGame[];
}

export interface SqbsParsedGame {
  id: number;
  round: number;
  left: SqbsParsedSideGame;
  right: SqbsParsedSideGame;
  tossupsHeard: number;
  overtime: boolean;
  forfeit: boolean;
}

export interface SqbsParsedTournament {
  tournamentName: string;
  pointValues: [number, number, number, number];
  useBonuses: boolean;
  bouncebacks: boolean;
  trackPowers: boolean;
  trackLightning: boolean;
  divisions: string[];
  teams: SqbsParsedTeam[];
  games: SqbsParsedGame[];
  packetNames: string[];
}

const MAX_PLAYERS_PER_GAME_SIDE = 8;
const MAX_POINT_VALUES = 4;

/**
 * Serialize a tournament to SQBS data-file text (LF line endings).
 * Unknown TUH/bonus fields are written as 0 and reported in warnings;
 * unrepresentable input (too many point values or players) fails.
 */
export function exportSqbsTournamentFile(input: SqbsTournamentInput): FormatReport<{ text: string }> {
  const warnings: FormatWarning[] = [];
  const errors: FormatError[] = [];
  const nonzeroValues = input.pointValues.filter((value) => value !== 0);
  if (nonzeroValues.length > MAX_POINT_VALUES) {
    return fail([
      error(
        'too-many-point-values',
        'pointValues',
        `SQBS supports at most ${MAX_POINT_VALUES} tossup point values, but this tournament uses ${nonzeroValues.length} (${nonzeroValues.join(', ')}).`,
      ),
    ]);
  }
  const slots: [number, number, number, number] = [
    nonzeroValues[0] ?? 0,
    nonzeroValues[1] ?? 0,
    nonzeroValues[2] ?? 0,
    nonzeroValues[3] ?? 0,
  ];

  // Double forfeits have no SQBS representation; everything else exports.
  const skippedDoubleForfeits = input.games.filter((game) => game.forfeitWinner === 'double');
  if (skippedDoubleForfeits.length > 0) {
    warnings.push(
      warning(
        'double-forfeit-skipped',
        'games',
        `${skippedDoubleForfeits.length} double-forfeit game(s) were omitted: SQBS cannot represent a game forfeited by both sides.`,
      ),
    );
  }
  const games = input.games.filter((game) => game.forfeitWinner !== 'double');

  for (const game of games) {
    for (const [label, side] of [
      ['left', game.left],
      ['right', game.right],
    ] as const) {
      if (side.players.length > MAX_PLAYERS_PER_GAME_SIDE) {
        return fail([
          error(
            'too-many-players',
            `games[${game.id}]`,
            `SQBS supports at most ${MAX_PLAYERS_PER_GAME_SIDE} players on one team in a game, but the ${label} side lists ${side.players.length}.`,
          ),
        ]);
      }
      for (const player of side.players) {
        if (player.playerIndex < 0 || player.playerIndex >= input.teams[side.teamIndex]?.players.length) {
          errors.push(
            error(
              'unknown-player',
              `games[${game.id}]`,
              `Player index ${player.playerIndex} is outside the ${input.teams[side.teamIndex]?.name ?? 'unknown'} roster and cannot be exported.`,
            ),
          );
        }
      }
    }
    if (game.left.teamIndex === game.right.teamIndex) {
      errors.push(
        error('same-team-game', `games[${game.id}]`, 'A game cannot pit a team against itself.'),
      );
    }
  }
  if (errors.length > 0) return fail(errors, warnings);

  const unknownTuh = games.filter((game) => !game.forfeitWinner && game.tossupsHeard === null).length;
  if (unknownTuh > 0) {
    warnings.push(
      warning(
        'unknown-tossups-heard',
        'games',
        `${unknownTuh} game(s) have unknown tossups-heard, exported as 0 because SQBS cannot represent unknown. Per-tossup rates for those games are meaningless.`,
      ),
    );
  }
  const unknownBonuses = games.filter(
    (game) =>
      input.useBonuses &&
      !game.forfeitWinner &&
      (game.left.bonusesHeard === null ||
        game.left.bonusPoints === null ||
        game.right.bonusesHeard === null ||
        game.right.bonusPoints === null),
  ).length;
  if (unknownBonuses > 0) {
    warnings.push(
      warning(
        'unknown-bonuses',
        'games',
        `${unknownBonuses} game(s) have unknown bonus counts or points, exported as 0 because SQBS cannot represent unknown.`,
      ),
    );
  }
  if (input.bouncebacks) {
    const incompleteBouncebacks = games.filter((game) => {
      const sides = [game.left, game.right];
      return sides.some(
        (side) =>
          (side.bouncebackPoints ?? 0) > 0 &&
          (side.bouncebacksHeard === null || side.bouncebacksHeard === undefined),
      );
    }).length;
    if (incompleteBouncebacks > 0) {
      warnings.push(
        warning(
          'incomplete-bouncebacks',
          'games',
          `${incompleteBouncebacks} game(s) have bounceback points but no heard count; the bounceback split is exported as 0 heard.`,
        ),
      );
    }
  }

  const lines: string[] = [];
  const add = (value: string | number) => lines.push(String(value));

  // Team and roster section.
  add(input.teams.length);
  for (const team of input.teams) {
    add(team.players.length + 1);
    add(team.name);
    for (const player of team.players) add(player);
  }

  // Games section.
  add(games.length);
  for (const game of games) {
    // SQBS requires the forfeit winner on the left.
    const swapForfeit = game.forfeitWinner === 'right';
    const left = swapForfeit ? game.right : game.left;
    const right = swapForfeit ? game.left : game.right;
    const isForfeit = game.forfeitWinner === 'left' || game.forfeitWinner === 'right';
    add(game.id);
    add(left.teamIndex);
    add(right.teamIndex);
    add(isForfeit ? -1 : left.score);
    add(isForfeit ? -1 : right.score);
    add(isForfeit ? 0 : (game.tossupsHeard ?? 0));
    add(game.round);
    if (input.useBonuses && !input.bouncebacks) {
      add(left.bonusesHeard ?? 0);
      add(left.bonusPoints ?? 0);
      add(right.bonusesHeard ?? 0);
      add(right.bonusPoints ?? 0);
    } else if (input.bouncebacks) {
      add(10_000 * (left.bouncebacksHeard ?? 0) + (left.bonusesHeard ?? 0));
      add(10_000 * (left.bouncebackPoints ?? 0) + (left.bonusPoints ?? 0));
      add(10_000 * (right.bouncebacksHeard ?? 0) + (right.bonusesHeard ?? 0));
      add(10_000 * (right.bouncebackPoints ?? 0) + (right.bonusPoints ?? 0));
    } else {
      add(0);
      add(0);
      add(0);
      add(0);
    }
    add(game.overtime === true ? 1 : 0);
    add(left.tossupsWithoutBonus ?? 0);
    add(right.tossupsWithoutBonus ?? 0);
    add(isForfeit ? 1 : 0);
    add(left.lightningPoints ?? 0);
    add(right.lightningPoints ?? 0);
    for (const side of [left, right]) {
      const padded = [...side.players];
      while (padded.length < MAX_PLAYERS_PER_GAME_SIDE) {
        padded.push({ playerIndex: -1, gamesPlayed: 0, counts: [0, 0, 0, 0], points: 0 });
      }
      for (const player of padded.slice(0, MAX_PLAYERS_PER_GAME_SIDE)) {
        add(player.playerIndex);
        add(Number(player.gamesPlayed).toFixed(2));
        add(player.counts[0]);
        add(player.counts[1]);
        add(player.counts[2]);
        add(player.counts[3]);
        add(player.points);
      }
    }
  }

  // Settings section. Values mirror what SQBS itself writes: full reports,
  // all validation warnings, record-then-PPG sort, blank FTP configuration.
  add(input.useBonuses ? 1 : 0);
  add(input.bouncebacks ? 3 : 1);
  add(input.trackPowers ? 3 : 2);
  add(input.trackLightning ? 1 : 0);
  add(1);
  add(3);
  add(254);
  add(1);
  add(1);
  add(1);
  add(1);
  add(1);
  add(1);
  add(1);
  add(0);
  add(input.divisions.length > 0 ? 1 : 0);
  add(1);
  add(input.tournamentName);
  add('');
  add('');
  add('');
  add('');
  add(1);
  add('_rounds.html');
  add('_standings.html');
  add('_individuals.html');
  add('_games.html');
  add('_teamdetail.html');
  add('_playerdetail.html');
  add('_statkey.html');
  add('');

  // Divisions section. Without divisions every team still gets an explicit -1.
  if (input.divisions.length === 0) {
    add(0);
    add(input.teams.length);
    for (let index = 0; index < input.teams.length; index += 1) add(-1);
  } else {
    add(input.divisions.length);
    for (const division of input.divisions) add(division);
    add(input.teams.length);
    for (const team of input.teams) add(team.divisionIndex);
  }

  // Point values, packets, exhibition flags.
  add(slots[0]);
  add(slots[1]);
  add(slots[2]);
  add(slots[3]);
  add(input.packetNames.length);
  for (const packet of input.packetNames) add(packet);
  add(input.teams.length);
  for (const team of input.teams) add(team.exhibition === true ? 1 : 0);

  return ok({ text: `${lines.join('\n')}\n` }, warnings);
}

/**
 * Parse an SQBS tournament data file back into structured data. This is the
 * compatibility reader behind the export round-trip test: it verifies that
 * what QBSheet writes is genuinely readable as SQBS — teams, players, games,
 * scores, and detail stats. Strict about structure (counts must reconcile),
 * lenient about line endings and trailing blank lines.
 */
export function parseSqbsTournamentFile(text: string): FormatReport<SqbsParsedTournament> {
  const warnings: FormatWarning[] = [];
  const errors: FormatError[] = [];
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  let cursor = 0;

  const next = (path: string): string | undefined => {
    if (cursor >= lines.length) {
      errors.push(error('unexpected-end', path, 'The file ends before all required sections are present.'));
      return undefined;
    }
    const line = lines[cursor];
    cursor += 1;
    return line;
  };
  const nextInt = (path: string): number | undefined => {
    const line = next(path);
    if (line === undefined) return undefined;
    if (!/^-?\d+$/.test(line.trim())) {
      errors.push(error('expected-integer', path, `Expected an integer but found ${JSON.stringify(line)}.`));
      return undefined;
    }
    return Number.parseInt(line.trim(), 10);
  };
  const nextNumber = (path: string): number | undefined => {
    const line = next(path);
    if (line === undefined) return undefined;
    const value = Number(line.trim());
    if (!Number.isFinite(value)) {
      errors.push(error('expected-number', path, `Expected a number but found ${JSON.stringify(line)}.`));
      return undefined;
    }
    return value;
  };

  const teamCount = nextInt('teams.count');
  const teams: SqbsParsedTeam[] = [];
  if (teamCount !== undefined) {
    for (let teamIndex = 0; teamIndex < teamCount; teamIndex += 1) {
      const size = nextInt(`teams[${teamIndex}].size`);
      const name = next(`teams[${teamIndex}].name`);
      if (size === undefined || name === undefined) break;
      const players: SqbsParsedPlayer[] = [];
      for (let playerIndex = 1; playerIndex < size; playerIndex += 1) {
        const playerName = next(`teams[${teamIndex}].players[${playerIndex - 1}]`);
        if (playerName === undefined) break;
        players.push({ name: playerName });
      }
      teams.push({ name, players, divisionIndex: -1, exhibition: false });
    }
  }

  const gameCount = nextInt('games.count');
  const games: SqbsParsedGame[] = [];
  if (gameCount !== undefined) {
    for (let gameIndex = 0; gameIndex < gameCount; gameIndex += 1) {
      const path = `games[${gameIndex}]`;
      const id = nextInt(`${path}.id`);
      const leftTeam = nextInt(`${path}.leftTeam`);
      const rightTeam = nextInt(`${path}.rightTeam`);
      const leftScore = nextInt(`${path}.leftScore`);
      const rightScore = nextInt(`${path}.rightScore`);
      const tossupsHeard = nextInt(`${path}.tossupsHeard`);
      const round = nextInt(`${path}.round`);
      const bonusA = nextInt(`${path}.bonuses[0]`);
      const bonusB = nextInt(`${path}.bonuses[1]`);
      const bonusC = nextInt(`${path}.bonuses[2]`);
      const bonusD = nextInt(`${path}.bonuses[3]`);
      if (
        id === undefined || leftTeam === undefined || rightTeam === undefined ||
        leftScore === undefined || rightScore === undefined || tossupsHeard === undefined ||
        round === undefined || bonusA === undefined || bonusB === undefined ||
        bonusC === undefined || bonusD === undefined
      ) {
        break;
      }
      // The four lines are left-heard, left-points, right-heard,
      // right-points. Bounceback layouts pack count+10000*heard-count into
      // those same four lines; the split is detected per game.
      const heard = [bonusA, bonusC];
      const points = [bonusB, bonusD];
      const bouncebacksHeard = [Math.floor(bonusA / 10_000), Math.floor(bonusC / 10_000)];
      const bouncebackPoints = [Math.floor(bonusB / 10_000), Math.floor(bonusD / 10_000)];
      heard[0] = heard[0]! % 10_000;
      heard[1] = heard[1]! % 10_000;
      points[0] = points[0]! % 10_000;
      points[1] = points[1]! % 10_000;
      const overtime = nextInt(`${path}.overtime`);
      const leftNoBonus = nextInt(`${path}.leftTossupsWithoutBonus`);
      const rightNoBonus = nextInt(`${path}.rightTossupsWithoutBonus`);
      const forfeitFlag = nextInt(`${path}.forfeit`);
      const leftLightning = nextInt(`${path}.leftLightning`);
      const rightLightning = nextInt(`${path}.rightLightning`);
      if (
        overtime === undefined || leftNoBonus === undefined || rightNoBonus === undefined ||
        forfeitFlag === undefined || leftLightning === undefined || rightLightning === undefined
      ) {
        break;
      }
      const readSide = (label: string): SqbsParsedSideGame | undefined => {
        const teamIndex = label === 'left' ? leftTeam : rightTeam;
        const players: SqbsParsedPlayerGame[] = [];
        for (let slot = 0; slot < MAX_PLAYERS_PER_GAME_SIDE; slot += 1) {
          const playerIndex = nextInt(`${path}.${label}[${slot}].player`);
          const gamesPlayed = nextNumber(`${path}.${label}[${slot}].gamesPlayed`);
          const c0 = nextInt(`${path}.${label}[${slot}].counts[0]`);
          const c1 = nextInt(`${path}.${label}[${slot}].counts[1]`);
          const c2 = nextInt(`${path}.${label}[${slot}].counts[2]`);
          const c3 = nextInt(`${path}.${label}[${slot}].counts[3]`);
          const slotPoints = nextInt(`${path}.${label}[${slot}].points`);
          if (
            playerIndex === undefined || gamesPlayed === undefined || c0 === undefined ||
            c1 === undefined || c2 === undefined || c3 === undefined || slotPoints === undefined
          ) {
            return undefined;
          }
          if (playerIndex >= 0) players.push({ playerIndex, gamesPlayed, counts: [c0, c1, c2, c3], points: slotPoints });
        }
        return {
          teamIndex,
          score: label === 'left' ? leftScore : rightScore,
          bonusesHeard: label === 'left' ? heard[0]! : heard[1]!,
          bonusPoints: label === 'left' ? points[0]! : points[1]!,
          bouncebacksHeard: label === 'left' ? bouncebacksHeard[0]! : bouncebacksHeard[1]!,
          bouncebackPoints: label === 'left' ? bouncebackPoints[0]! : bouncebackPoints[1]!,
          tossupsWithoutBonus: label === 'left' ? leftNoBonus : rightNoBonus,
          lightningPoints: label === 'left' ? leftLightning : rightLightning,
          players,
        };
      };
      const leftSide = readSide('left');
      const rightSide = readSide('right');
      if (!leftSide || !rightSide) break;
      games.push({
        id,
        round,
        left: leftSide,
        right: rightSide,
        tossupsHeard,
        overtime: overtime === 1,
        forfeit: forfeitFlag === 1,
      });
    }
  }

  const bonusTracking = nextInt('settings.bonusTracking');
  const bonusMode = nextInt('settings.bonusMode');
  const powerStats = nextInt('settings.powerStats');
  const lightning = nextInt('settings.lightning');
  nextInt('settings.trackTuh');
  nextInt('settings.packetFlag');
  nextInt('settings.warnings');
  const reportFlags: Array<number | undefined> = [];
  for (let index = 0; index < 8; index += 1) reportFlags.push(nextInt(`settings.reports[${index}]`));
  const useDivisions = nextInt('settings.useDivisions');
  nextInt('settings.sortMethod');
  const tournamentName = next('settings.tournamentName');
  for (let index = 0; index < 4; index += 1) next(`settings.ftp[${index}]`);
  nextInt('settings.pathStyle');
  for (let index = 0; index < 7; index += 1) next(`settings.suffix[${index}]`);
  next('settings.stylesheet');
  if (
    bonusTracking === undefined || bonusMode === undefined || powerStats === undefined ||
    lightning === undefined || useDivisions === undefined || tournamentName === undefined ||
    reportFlags.some((flag) => flag === undefined)
  ) {
    return fail(errors, warnings);
  }

  const divisions: string[] = [];
  const divisionCount = nextInt('divisions.count');
  if (divisionCount === undefined) return fail(errors, warnings);
  for (let index = 0; index < divisionCount; index += 1) {
    const name = next(`divisions[${index}]`);
    if (name === undefined) return fail(errors, warnings);
    divisions.push(name);
  }
  const divisionTeamCount = nextInt('divisions.teams');
  if (divisionTeamCount === undefined) return fail(errors, warnings);
  if (divisionTeamCount !== teams.length) {
    errors.push(
      error(
        'division-team-mismatch',
        'divisions.teams',
        `The divisions section lists ${divisionTeamCount} teams but the roster section lists ${teams.length}.`,
      ),
    );
    return fail(errors, warnings);
  }
  for (let teamIndex = 0; teamIndex < divisionTeamCount; teamIndex += 1) {
    const divisionIndex = nextInt(`divisions.assignment[${teamIndex}]`);
    if (divisionIndex === undefined) return fail(errors, warnings);
    teams[teamIndex]!.divisionIndex = divisionIndex;
  }

  const pointValues: [number, number, number, number] = [0, 0, 0, 0];
  for (let slot = 0; slot < 4; slot += 1) {
    const value = nextInt(`points[${slot}]`);
    if (value === undefined) return fail(errors, warnings);
    pointValues[slot] = value;
  }
  const packetCount = nextInt('packets.count');
  if (packetCount === undefined) return fail(errors, warnings);
  const packetNames: string[] = [];
  for (let index = 0; index < packetCount; index += 1) {
    const name = next(`packets[${index}]`);
    if (name === undefined) return fail(errors, warnings);
    packetNames.push(name);
  }
  const exhibitionCount = nextInt('exhibition.count');
  if (exhibitionCount === undefined) return fail(errors, warnings);
  if (exhibitionCount !== teams.length) {
    errors.push(
      error(
        'exhibition-team-mismatch',
        'exhibition.count',
        `The exhibition section lists ${exhibitionCount} teams but the roster section lists ${teams.length}.`,
      ),
    );
    return fail(errors, warnings);
  }
  for (let teamIndex = 0; teamIndex < exhibitionCount; teamIndex += 1) {
    const flag = nextInt(`exhibition[${teamIndex}]`);
    if (flag === undefined) return fail(errors, warnings);
    teams[teamIndex]!.exhibition = flag === 1;
  }

  const trailing = lines.slice(cursor).filter((line) => line.trim() !== '');
  if (trailing.length > 0) {
    warnings.push(
      warning(
        'trailing-content',
        'end',
        `${trailing.length} non-blank trailing line(s) after the exhibition section were ignored.`,
      ),
    );
  }

  // Index sanity: games must reference real teams, players must reference real roster slots.
  for (const game of games) {
    for (const [label, side] of [['left', game.left], ['right', game.right]] as const) {
      if (side.teamIndex < 0 || side.teamIndex >= teams.length) {
        errors.push(
          error('unknown-team', `games[${game.id}]`, `The ${label} side references team index ${side.teamIndex}, but the file lists ${teams.length} teams.`),
        );
      } else {
        const rosterSize = teams[side.teamIndex]!.players.length;
        for (const player of side.players) {
          if (player.playerIndex < 0 || player.playerIndex >= rosterSize) {
            errors.push(
              error('unknown-player', `games[${game.id}]`, `Player index ${player.playerIndex} is outside the ${teams[side.teamIndex]!.name} roster (${rosterSize} players).`),
            );
          }
        }
      }
    }
  }
  if (errors.length > 0) return fail(errors, warnings);

  return ok(
    {
      tournamentName,
      pointValues,
      useBonuses: bonusTracking === 1,
      bouncebacks: bonusMode === 3,
      trackPowers: powerStats === 3,
      trackLightning: lightning === 1,
      divisions,
      teams,
      games,
      packetNames,
    },
    warnings,
  );
}
