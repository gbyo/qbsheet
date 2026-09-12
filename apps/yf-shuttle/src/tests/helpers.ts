/**
 * Shared test fixtures: the real sample `.yft` and a small synthetic Wildcat builder.
 *
 * The real fixture (`packages/tournament-formats/tests/fixtures/yft-sample.yft.json`) is an
 * observed 12-team file whose prelim pools already match the Wildcat A/B seed split, which
 * makes it the right compatibility and prelim-planning fixture. The synthetic builder covers
 * what no observed file can: controlled prelim results (forced orders, ties, overtime,
 * forfeits) and controlled playoff-pool membership for the rebracket checks.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import deriveGame from '../../../../src/scoring/deriveGame';
import type { IGameSetup } from '../../../../src/scoring/deriveGame';
import type { ScoreEvent } from '../../../../src/scoring/ScoreEvents';
import type { IScorekeeperFormat } from '../../../../src/scoring/ScorekeeperFormat';
import { defineGame, readQbjSource } from '../../../../src/qbj/ParseQbjAssignment';
import { buildResultDocument } from '../../../../src/qbj/QbjResult';
import { buildAssignment } from '../lib/assignment';
import { loadShuttleTournament, type ShuttleTournament } from '../lib/tournament';
import { planPrelims, validateWildcatCompatibility } from '../lib/schedule';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../../../..');

export const yftFixturePath = resolve(
  repositoryRoot,
  'packages/tournament-formats/tests/fixtures/yft-sample.yft.json',
);

export function yftFixtureText(): string {
  return readFileSync(yftFixturePath, 'utf8');
}

export function loadedFixture(): ShuttleTournament {
  const report = loadShuttleTournament(yftFixtureText());
  if (!report.ok) throw new Error(`fixture failed to load: ${report.errors.join(' ')}`);
  return report.tournament;
}

export function teamNamed(tournament: ShuttleTournament, name: string) {
  const team = tournament.teams.find((entry) => entry.name === name);
  if (!team) throw new Error(`no team named ${name}`);
  return team;
}

// --------------------------------------------------------------------------- synthetic Wildcat

export interface SyntheticTeam {
  seed: number;
  id: string;
  name: string;
  registrationId: string;
  registrationName: string;
  players: { id: string; name: string }[];
}

/** Twelve seeded teams, `Seed 1` … `Seed 12`, each with two players. */
export function syntheticTeams(): SyntheticTeam[] {
  return Array.from({ length: 12 }, (_, index) => {
    const seed = index + 1;
    return {
      seed,
      id: `Team_Seed${seed}`,
      name: `Seed ${seed}`,
      registrationId: `Registration_Seed${seed}`,
      registrationName: `Seed ${seed}`,
      players: [
        { id: `Player_Seed${seed}A`, name: `Seed${seed} Alpha` },
        { id: `Player_Seed${seed}B`, name: `Seed${seed} Beta` },
      ],
    };
  });
}

export interface SyntheticResult {
  round: number;
  leftSeed: number;
  rightSeed: number;
  leftPoints: number;
  rightPoints: number;
  forfeit?: 'left' | 'right';
  overtimeTossups?: number;
}

interface SyntheticOptions {
  prelimResults?: SyntheticResult[];
  /** Playoff pool membership as team ids; defaults to empty pools. */
  playoffPools?: { name: string; position: number; teamIds: string[] }[];
  timed?: boolean;
  /**
   * Real scheduled-but-unplayed Match objects in prelim rounds, as a director-added schedule
   * would hold them: id, teams, room, no score.
   */
  scheduledBlanks?: { round: number; leftSeed: number; rightSeed: number; location: string; id: string }[];
}

/**
 * A minimal but genuine YellowFruit document: tournament seed order, per-team registrations,
 * two prelim pools on the A/B seed split, rounds 1–8 with number sidecars, and whatever
 * prelim results and playoff pools the test needs.
 */

/** One Match in the synthetic document: scored results and unplayed blanks share it. */
interface SyntheticMatchSide {
  team: { $ref: string };
  points?: number;
  forfeit_loss?: boolean;
}

interface SyntheticMatch {
  id: string;
  location?: string;
  tossups_read: number;
  overtime_tossups_read?: number;
  match_teams: SyntheticMatchSide[];
}
export function syntheticYftText(options: SyntheticOptions = {}): string {
  const teams = syntheticTeams();
  const bySeed = new Map(teams.map((team) => [team.seed, team]));
  const seedsA = [1, 4, 5, 8, 9, 12];
  const seedsB = [2, 3, 6, 7, 10, 11];

  const poolTeams = (seeds: number[]) =>
    seeds.map((seed) => ({ YfData: {}, team: { $ref: bySeed.get(seed)!.id } }));

  const resultsByRound = new Map<number, SyntheticResult[]>();
  for (const result of options.prelimResults ?? []) {
    const list = resultsByRound.get(result.round) ?? [];
    list.push(result);
    resultsByRound.set(result.round, list);
  }

  const blanksByRound = new Map<
    number,
    { round: number; leftSeed: number; rightSeed: number; location: string; id: string }[]
  >();
  for (const blank of options.scheduledBlanks ?? []) {
    const list = blanksByRound.get(blank.round) ?? [];
    list.push(blank);
    blanksByRound.set(blank.round, list);
  }

  const rounds = (numbers: number[]) =>
    numbers.map((number) => ({
      name: String(number),
      YfData: { number },
      matches: (resultsByRound.get(number) ?? [])
        .map((result, index): SyntheticMatch => {
          const left = bySeed.get(result.leftSeed)!;
          const right = bySeed.get(result.rightSeed)!;
          return {
            id: `Match_R${number}_${index}`,
            tossups_read: 20,
            ...(result.overtimeTossups ? { overtime_tossups_read: result.overtimeTossups } : {}),
            match_teams: [
              {
                team: { $ref: left.id },
                points: result.leftPoints,
                ...(result.forfeit === 'left' ? { forfeit_loss: true } : {}),
              },
              {
                team: { $ref: right.id },
                points: result.rightPoints,
                ...(result.forfeit === 'right' ? { forfeit_loss: true } : {}),
              },
            ],
          };
        })
        .concat(
          (blanksByRound.get(number) ?? []).map((blank) => {
            const left = bySeed.get(blank.leftSeed)!;
            const right = bySeed.get(blank.rightSeed)!;
            return {
              id: blank.id,
              location: blank.location,
              tossups_read: 0,
              match_teams: [{ team: { $ref: left.id } }, { team: { $ref: right.id } }],
            };
          }),
        ),
    }));

  // A fresh file carries both playoff pools (empty of teams until the rebracket).
  const playoffPools = (
    options.playoffPools ?? [
      { name: 'Gold', position: 1, teamIds: [] },
      { name: 'Maroon', position: 2, teamIds: [] },
    ]
  ).map((pool) => ({
    name: pool.name,
    position: pool.position,
    pool_teams: pool.teamIds.map((id) => ({ YfData: {}, team: { $ref: id } })),
  }));

  const document = {
    version: '2.1.1',
    objects: [
      {
        type: 'Tournament',
        id: 'Tournament_Synthetic',
        name: 'Synthetic Wildcat',
        YfData: {
          standardRuleSet: 'Synthetic',
          seeds: teams.map((team) => ({ $ref: team.id })),
        },
        scoring_rules: {
          id: 'ScoringRules_Synthetic',
          name: 'Synthetic rules',
          YfData: { timed: options.timed ?? false },
          maximum_players_per_team: 4,
          maximum_regulation_tossup_count: 20,
          overtime_includes_bonuses: false,
          maximum_bonus_score: 30,
          answer_types: [
            { id: 'AnswerType_15', value: 15 },
            { id: 'AnswerType_10', value: 10 },
            { id: 'AnswerType_-5', value: -5 },
          ],
        },
        registrations: teams.map((team) => ({
          id: team.registrationId,
          name: team.registrationName,
          teams: [
            {
              id: team.id,
              name: team.name,
              players: team.players.map((player) => ({ id: player.id, name: player.name })),
            },
          ],
        })),
        phases: [
          {
            id: 'Phase_Prelim',
            name: 'Prelims',
            YfData: { phaseType: 'Prelim', code: '1' },
            pools: [
              { name: 'FuzzyWuzzy', position: 1, pool_teams: poolTeams(seedsA) },
              { name: 'BabyCheezItMouse', position: 1, pool_teams: poolTeams(seedsB) },
            ],
            rounds: rounds([1, 2, 3, 4, 5]),
          },
          {
            id: 'Phase_Playoff',
            name: 'Playoffs',
            YfData: { phaseType: 'Playoff', code: '2' },
            pools: playoffPools,
            rounds: rounds([6, 7, 8]),
          },
        ],
      },
    ],
  };
  return JSON.stringify(document);
}

export function loadedSynthetic(options: SyntheticOptions = {}): ShuttleTournament {
  const report = loadShuttleTournament(syntheticYftText(options));
  if (!report.ok) throw new Error(`synthetic failed to load: ${report.errors.join(' ')}`);
  return report.tournament;
}

// ------------------------------------------------------- assignment → scorer → result, for real

function typeIndex(format: IScorekeeperFormat, value: number): number {
  const found = format.answerTypes.find((answerType) => answerType.value === value);
  if (!found) throw new Error(`no answer type worth ${value}`);
  return found.index;
}

let eventSequence = 0;
function scoreEvent(partial: Omit<ScoreEvent, 'id'>): ScoreEvent {
  eventSequence += 1;
  return { ...partial, id: `e${eventSequence}` } as ScoreEvent;
}

/** A short game with a power, a neg, and bonuses on both sides. */
function playedEvents(format: IScorekeeperFormat, left: string[], right: string[]): ScoreEvent[] {
  return [
    scoreEvent({
      type: 'tossup-buzz',
      questionNumber: 1,
      team: 'left',
      playerName: left[0],
      answerTypeIndex: typeIndex(format, 15),
    } as Omit<ScoreEvent, 'id'>),
    scoreEvent({
      type: 'bonus',
      questionNumber: 1,
      team: 'left',
      controlledPoints: 20,
    } as Omit<ScoreEvent, 'id'>),
    scoreEvent({
      type: 'tossup-buzz',
      questionNumber: 2,
      team: 'left',
      playerName: left[1],
      answerTypeIndex: typeIndex(format, -5),
    } as Omit<ScoreEvent, 'id'>),
    scoreEvent({
      type: 'tossup-buzz',
      questionNumber: 2,
      team: 'right',
      playerName: right[0],
      answerTypeIndex: typeIndex(format, 10),
    } as Omit<ScoreEvent, 'id'>),
    scoreEvent({
      type: 'bonus',
      questionNumber: 2,
      team: 'right',
      controlledPoints: 30,
    } as Omit<ScoreEvent, 'id'>),
  ];
}

export interface ScoredShuttleGame {
  resultText: string;
  resultObject: { version: string; objects: Record<string, unknown>[] };
  matchId: string;
  roundNumber: number;
  slotId: string;
}

/**
 * Score one planned prelim game through QBSheet's real scorer.
 *
 * The returned result is what a room produces from the assignment — same ids, filled in —
 * not a hand-written document that resembles one.
 */
export interface CustomGameSpec {
  roundId: string;
  roundQbjName: string;
  roundNumber: number;
  phaseId: string;
  phaseName: string;
  slotId: string;
  roomName: string;
  leftTeamId: string;
  rightTeamId: string;
  existingMatchId?: string;
  partial?: boolean;
}

export function scoreCustomGame(tournament: ShuttleTournament, spec: CustomGameSpec): ScoredShuttleGame {
  const teams = new Map(tournament.teams.map((team) => [team.id, team]));
  const left = teams.get(spec.leftTeamId);
  const right = teams.get(spec.rightTeamId);
  if (!left || !right) throw new Error('unknown team in custom game');
  const built = buildAssignment({
    tournament,
    roundId: spec.roundId,
    roundQbjName: spec.roundQbjName,
    roundNumber: spec.roundNumber,
    phaseId: spec.phaseId,
    phaseName: spec.phaseName,
    slotId: spec.slotId,
    roomName: spec.roomName,
    left,
    right,
    ...(spec.existingMatchId ? { existingMatchId: spec.existingMatchId } : {}),
  });
  if (!built.ok) throw new Error(built.error);

  const source = readQbjSource(built.assignment.document);
  if (!source.ok) throw new Error(source.errors.join(' '));
  const defined = defineGame(source.value, source.value.candidates[0].index);
  if (!defined.ok) throw new Error(defined.errors.join(' '));
  const definition = defined.definition;
  const format = definition.scorekeeperFormat;
  const setup: IGameSetup = {
    left: { name: definition.left.name, players: definition.left.players.map((entry) => entry.name) },
    right: { name: definition.right.name, players: definition.right.players.map((entry) => entry.name) },
  };
  const game = deriveGame(format, setup, playedEvents(format, setup.left.players, setup.right.players));
  // The mid-game download is this same builder with a game still being played: the only
  // difference in the document is the declared `partial` lifecycle state.
  const resultObject = buildResultDocument({
    definition,
    format,
    game,
    ...(spec.partial ? { partial: true as const } : {}),
  }) as {
    version: string;
    objects: Record<string, unknown>[];
  };
  return {
    resultText: `${JSON.stringify(resultObject, null, 2)}\n`,
    resultObject,
    matchId: built.assignment.matchId,
    roundNumber: spec.roundNumber,
    slotId: spec.slotId,
  };
}

export function scorePrelimGame(
  tournament: ShuttleTournament,
  roundNumber: number,
  slotId: string,
  options: { partial?: boolean } = {},
): ScoredShuttleGame {
  const compat = validateWildcatCompatibility(tournament);
  if (!compat.ok) throw new Error(`not compatible: ${compat.errors.join(' ')}`);
  const planned = planPrelims(compat.compat).find(
    (game) => game.roundNumber === roundNumber && game.slotId === slotId,
  );
  if (!planned) throw new Error(`no planned game for round ${roundNumber} slot ${slotId}`);
  const round = compat.compat.roundsByNumber.get(roundNumber)!;
  return scoreCustomGame(tournament, {
    roundId: round.id,
    roundQbjName: round.qbjName,
    roundNumber,
    phaseId: round.phaseId,
    phaseName: round.phaseName,
    slotId,
    roomName: slotId,
    leftTeamId: planned.leftTeamId,
    rightTeamId: planned.rightTeamId,
    ...(options.partial ? { partial: true as const } : {}),
  });
}

/**
 * A mid-game copy of one planned prelim game, through QBSheet's real partial path.
 *
 * Carries scoring content but declares `partial` — the file a room downloads as a lifeboat,
 * which must never read as a finished result.
 */
export function scorePartialGame(
  tournament: ShuttleTournament,
  roundNumber: number,
  slotId: string,
): ScoredShuttleGame {
  return scorePrelimGame(tournament, roundNumber, slotId, { partial: true });
}
