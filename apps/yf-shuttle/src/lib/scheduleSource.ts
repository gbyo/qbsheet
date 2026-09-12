/**
 * Where a round's games come from: the file, or the printed preset.
 *
 * An "actual scheduled Match" is a real Match object sitting in a Round, with an id, two
 * resolvable teams, and (for room folders) a location. A schedule template, pool membership,
 * a round-robin count, a seed list, or a phase is none of those things and never counts.
 *
 * Verified against stock YellowFruit (`ANadig/YellowFruit`): its Schedule page describes
 * phases, pools, seeds, and round counts but creates no Match objects — `StandardSchedule`
 * contains no `new Match` — and games reach `round.matches` only through manual Add or
 * Import. A pre-tournament file therefore legitimately holds zero Matches, and the preset
 * remains the schedule. Rebracketing moves pool membership; it does not generate room games.
 *
 * Resolution is strict and automatic — no operator choice, no editor:
 * - every needed game present as a valid unplayed scheduled Match → the file is the schedule;
 * - no scheduled games at all in the needed rounds → the Wildcat preset is the schedule;
 * - anything in between (some scheduled, some played, some missing) → neither source is safe,
 *   and setup stops with an explanation instead of printing half a tournament.
 */

import type { JsonObject } from '@qbsheet/tournament-formats';
import type { ShuttleTournament } from './tournament';

export interface YftScheduledGame {
  matchId: string;
  roundNumber: number;
  leftTeamId: string;
  rightTeamId: string;
  location?: string;
  /** Decided by the same rule the standings use: both sides scored, or a forfeit. */
  played: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function refId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    if (typeof value.$ref === 'string') return value.$ref;
    if (typeof value.id === 'string') return value.id;
  }
  return undefined;
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value;
}

function roundNumberOf(round: Record<string, unknown>): number | undefined {
  const data = isRecord(round.YfData) ? round.YfData : null;
  const fromData = data ? finiteNumber((data as JsonObject).number) : undefined;
  if (fromData !== undefined && Number.isSafeInteger(fromData)) return fromData;
  if (typeof round.number === 'number' && Number.isSafeInteger(round.number)) return round.number;
  if (typeof round.name === 'string') {
    const parsed = Number.parseInt(round.name, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function rawList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Every Match object in a phase's numbered rounds, with teams resolved against the roster. */
export function readScheduledGames(
  tournament: ShuttleTournament,
  phaseId: string,
  roundNumbers: readonly number[],
): YftScheduledGame[] {
  const raw = tournament.rawTournament;
  const phases = rawList(raw.phases);
  const phase = phases.find((entry) => entry.id === phaseId);
  if (!phase || !Array.isArray(phase.rounds)) return [];
  const teamIds = new Set(tournament.teams.map((team) => team.id));
  const games: YftScheduledGame[] = [];
  for (const round of phase.rounds.filter(isRecord)) {
    const number = roundNumberOf(round);
    if (number === undefined || !roundNumbers.includes(number)) continue;
    if (!Array.isArray(round.matches)) continue;
    for (const match of round.matches.filter(isRecord)) {
      const matchId = nonBlank(match.id);
      const sides = Array.isArray(match.match_teams) ? (match.match_teams as unknown[]).filter(isRecord) : [];
      if (!matchId || sides.length !== 2) continue;
      const ids = sides.map((side) => refId(side.team));
      if (ids.some((id) => !id || !teamIds.has(id!))) continue;
      const forfeit = sides.some((side) => side.forfeit_loss === true);
      const played = forfeit ? true : sides.every((side) => finiteNumber(side.points) !== undefined);
      const location = nonBlank(match.location);
      games.push({
        matchId,
        roundNumber: number,
        leftTeamId: ids[0]!,
        rightTeamId: ids[1]!,
        ...(location ? { location } : {}),
        played,
      });
    }
  }
  return games;
}

export type ScheduleSource =
  | { kind: 'yft'; games: YftScheduledGame[] }
  | { kind: 'preset' }
  | { kind: 'mixed'; scheduled: number; played: number; expected: number; detail: string };

/**
 * Decide which source provides the needed rounds.
 *
 * `expectedCount` is the full set (30 prelims, 18 playoffs): the file source is used only
 * when every needed game is there and unplayed. Zero scheduled games means the preset. A
 * partial state — imports already started, manual adds, a half-built schedule — is an
 * explicit error, because neither source could print the tournament safely.
 */
export function resolveScheduleSource(
  tournament: ShuttleTournament,
  phaseId: string,
  roundNumbers: readonly number[],
  expectedCount: number,
): ScheduleSource {
  const games = readScheduledGames(tournament, phaseId, roundNumbers);
  if (games.length === 0) return { kind: 'preset' };
  const unplayed = games.filter((game) => !game.played);
  const played = games.length - unplayed.length;
  if (unplayed.length === expectedCount && played === 0) {
    return { kind: 'yft', games: unplayed };
  }
  const roundsCovered = new Set(games.map((game) => game.roundNumber)).size;
  return {
    kind: 'mixed',
    scheduled: games.length,
    played,
    expected: expectedCount,
    detail:
      `Rounds ${roundNumbers.join(', ')} hold ${games.length} scheduled games ` +
      `(${played} already played) across ${roundsCovered} rounds, not the ${expectedCount} ` +
      `unplayed games a full schedule needs. Finish or clear the schedule in YellowFruit first — ` +
      `YF Shuttle cannot safely print half a tournament.`,
  };
}

/**
 * Room folders for file-sourced games: the distinct locations, one folder each.
 *
 * Every game must name a room, and each round must spread its games across distinct rooms —
 * otherwise there is no folder a result could come home to.
 */
export function roomsForScheduledGames(
  games: readonly YftScheduledGame[],
): { ok: true; rooms: string[] } | { ok: false; error: string } {
  const locations = games.map((game) => game.location).filter((location) => location !== undefined);
  if (locations.length !== games.length) {
    return {
      ok: false,
      error: 'Some scheduled games name no room, so room folders cannot be built from them.',
    };
  }
  const byRound = new Map<number, string[]>();
  for (const game of games) {
    const list = byRound.get(game.roundNumber) ?? [];
    list.push(game.location!);
    byRound.set(game.roundNumber, list);
  }
  for (const [round, rooms] of byRound) {
    if (new Set(rooms).size !== rooms.length) {
      return {
        ok: false,
        error: `Round ${round} schedules two games in one room; the file's rooms are ambiguous.`,
      };
    }
  }
  return { ok: true, rooms: [...new Set(locations as string[])].sort() };
}
