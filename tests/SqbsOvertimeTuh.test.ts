/**
 * SQBS overtime, no-bonus, and exact-TUH export (#890, SQBS consumer gap in #746).
 *
 * The adapter dropped the overtime flag and per-team no-bonus conversions even
 * though Scorer/Director retain the facts, and it rebuilt match TUH from player
 * exposure (`max(player TUH)`) instead of the exact accepted `tossupsRead` —
 * so a halftime full-lineup swap halved match TUH and doubled every GP.
 *
 * These tests travel the production path (native Scorer → QBJ → Director
 * ingest → accepted GameRecord → SQBS file → SQBS-compatible parse) and pin:
 * exact total TUH with substitutions, fractional GP, the overtime flag,
 * per-team no-bonus counts under each game's own historical rules, and honest
 * warnings where per-team detail is unknowable. Bonus-aggregate exactness
 * itself is owned by #889; here SQBS BH/BP must equal the canonical scores
 * (passthrough fidelity, never invention).
 */
import { describe, expect, test } from 'vitest';
import { parseSqbsTournamentFile } from '@qbsheet/tournament-formats';
import deriveGame from '../src/scoring/deriveGame';
import toQbjMatch from '../src/scoring/toQbjMatch';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules, typeIndex } from './rules';
import { event } from './events';
import type { ScoreEvent } from '../src/scoring/ScoreEvents';
import type { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { readResultStatistics } from '../src/director/transfers/ingest';
import { directorFixture } from '../src/director/transfers/testFixtures';
import { exportSqbsTournament } from '../src/director/format/interchange';
import { isoNow, type DirectorState, type GameRecord } from '../src/director/domain/model';

const TEAM_A = 'Ninety Six A';
const TEAM_B = 'Greenwood A';
const TEAM_C = 'Emerald A';
const TEAM_D = 'Clinton A';

const playerNames = (team: string) => [1, 2, 3, 4].map((seat) => `${team} player ${seat}`);

function naqtFormat(): IScorekeeperFormat {
  return scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.NaqtUntimed));
}

function buzz(
  format: IScorekeeperFormat,
  questionNumber: number,
  team: 'left' | 'right',
  playerName: string,
  value: number,
): ScoreEvent {
  return event({
    type: 'tossup-buzz',
    questionNumber,
    team,
    playerName,
    answerTypeIndex: typeIndex(format, value),
  });
}

function bonus(questionNumber: number, team: 'left' | 'right', controlledPoints: number): ScoreEvent {
  return event({ type: 'bonus', questionNumber, team, controlledPoints });
}

function dead(questionNumber: number): ScoreEvent {
  return event({ type: 'tossup-dead', questionNumber });
}

function sub(questionNumber: number, team: 'left' | 'right', activePlayers: string[]): ScoreEvent {
  return event({ type: 'substitution', questionNumber, team, activePlayers });
}

function qbjMatchDocument(match: Record<string, unknown>): Record<string, unknown> {
  return { type: 'Match', ...match };
}

function addRosterPlayers(state: DirectorState, teamId: string, teamName: string, seats: number[]): void {
  for (const seat of seats) {
    state.players.push({
      id: `${teamId}-player-${seat}`,
      teamId,
      name: `${teamName} player ${seat}`,
      captain: false,
      active: true,
    });
  }
}

function acceptScoredGame(
  state: DirectorState,
  scheduledGameId: string,
  gameId: string,
  doc: Record<string, unknown>,
  detailedStats: GameRecord['detailedStats'],
): GameRecord {
  const scheduled = state.scheduledGames.find((entry) => entry.id === scheduledGameId);
  const result = readResultStatistics(doc, state, scheduled);
  const game: GameRecord = {
    id: gameId,
    scheduledGameId,
    roundId: scheduled?.roundId ?? 'round-5',
    packetId: scheduled?.packetId ?? null,
    status: 'accepted',
    scores: result.scores,
    playerStats: result.playerStats,
    ...(result.tossupsRead === null ? {} : { tossupsRead: result.tossupsRead }),
    ...(result.overtimeTossupsRead === null ? {} : { overtimeTossupsRead: result.overtimeTossupsRead }),
    source: 'qbj',
    detailedStats,
    rawQbj: doc,
    acceptedAt: isoNow(),
  };
  state.games.push(game);
  return game;
}

function manualGame(overrides: Partial<GameRecord> & Pick<GameRecord, 'id' | 'scheduledGameId'>): GameRecord {
  return {
    roundId: 'round-5',
    packetId: 'packet-5',
    status: 'accepted',
    scores: [],
    playerStats: [],
    source: 'paper',
    detailedStats: 'complete',
    acceptedAt: isoNow(),
    ...overrides,
  } as GameRecord;
}

describe('SQBS exact TUH with substitutions (#746 consumer)', () => {
  test('halftime full-lineup swap keeps match TUH 20 and halves every GP', () => {
    const format = naqtFormat();
    const state = directorFixture();
    addRosterPlayers(state, 'team-1', TEAM_A, [5, 6, 7, 8]);
    addRosterPlayers(state, 'team-2', TEAM_B, [5, 6, 7, 8]);

    const leftFirst = playerNames(TEAM_A);
    const rightFirst = playerNames(TEAM_B);
    const leftSecond = [5, 6, 7, 8].map((seat) => `${TEAM_A} player ${seat}`);
    const rightSecond = [5, 6, 7, 8].map((seat) => `${TEAM_B} player ${seat}`);
    const events: ScoreEvent[] = [
      sub(1, 'left', leftFirst),
      sub(1, 'right', rightFirst),
      buzz(format, 1, 'left', leftFirst[0]!, 15),
      bonus(1, 'left', 20),
      buzz(format, 2, 'right', rightFirst[0]!, 10),
      bonus(2, 'right', 10),
    ];
    for (let question = 3; question <= 10; question += 1) events.push(dead(question));
    events.push(sub(11, 'left', leftSecond), sub(11, 'right', rightSecond));
    events.push(buzz(format, 11, 'left', leftSecond[0]!, 10), bonus(11, 'left', 10));
    events.push(buzz(format, 12, 'right', rightSecond[0]!, 15), bonus(12, 'right', 30));
    for (let question = 13; question <= 20; question += 1) events.push(dead(question));

    const setup = {
      left: { name: TEAM_A, players: [...leftFirst, ...leftSecond] },
      right: { name: TEAM_B, players: [...rightFirst, ...rightSecond] },
    };
    const derived = deriveGame(format, setup, events);
    // Every participant heard exactly half the game; the match heard all of it.
    expect(derived.left.players.find((entry) => entry.name === leftFirst[0])?.tossupsHeard).toBe(10);
    expect(derived.tossupsRead).toBe(20);

    const match = toQbjMatch(format, derived) as Record<string, unknown>;
    const game = acceptScoredGame(state, 'game-5-1', 'game-sub-1', qbjMatchDocument(match), 'complete');
    expect(game.tossupsRead).toBe(20);

    // A score-only game with no player detail still exports its known TUH.
    state.games.push(
      manualGame({
        id: 'game-score-only-1',
        scheduledGameId: 'game-5-2',
        scores: [
          {
            teamId: 'team-3',
            score: 300,
            superpowers: 0,
            powers: 0,
            gets: 0,
            negs: 0,
            bonuses: 0,
            bonusPoints: 0,
          },
          {
            teamId: 'team-4',
            score: 250,
            superpowers: 0,
            powers: 0,
            gets: 0,
            negs: 0,
            bonuses: 0,
            bonusPoints: 0,
          },
        ],
        tossupsRead: 20,
        detailedStats: 'unknown',
      }),
    );

    const exported = exportSqbsTournament(state, {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const subGame = parsed.value.games.find((entry) => entry.left.players.length === 8);
    expect(subGame).toBeDefined();
    // Eight participants per side, every one at half participation.
    expect(subGame!.tossupsHeard).toBe(20);
    expect(subGame!.right.players).toHaveLength(8);
    for (const player of [...subGame!.left.players, ...subGame!.right.players]) {
      expect(player.gamesPlayed).toBeCloseTo(0.5);
    }
    const scoreOnly = parsed.value.games.find(
      (entry) => entry !== subGame && entry.left.players.length === 0 && entry.right.players.length === 0,
    );
    expect(scoreOnly?.tossupsHeard).toBe(20);
    expect(exported.warnings.filter((entry) => /overtime|no-bonus/i.test(entry))).toEqual([]);
  });
});

describe('SQBS NAQT overtime and no-bonus conversions (#890)', () => {
  function overtimeEvents(format: IScorekeeperFormat): {
    setup: { left: { name: string; players: string[] }; right: { name: string; players: string[] } };
    events: ScoreEvent[];
  } {
    const left = [...playerNames(TEAM_A), `${TEAM_A} player 5`];
    const right = [...playerNames(TEAM_B), `${TEAM_B} player 5`];
    const events: ScoreEvent[] = [
      sub(1, 'left', left.slice(0, 4)),
      sub(1, 'right', right.slice(0, 4)),
      buzz(format, 1, 'left', left[0]!, 15),
      bonus(1, 'left', 20),
      buzz(format, 2, 'right', right[0]!, 10),
      bonus(2, 'right', 20),
      buzz(format, 5, 'left', left[1]!, 10),
      bonus(5, 'left', 10),
      buzz(format, 6, 'right', right[1]!, 15),
      bonus(6, 'right', 10),
    ];
    for (const question of [3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
      events.push(dead(question));
    // Tied 55–55 after regulation; one substitution arrives with overtime.
    events.push(sub(20, 'left', [left[1]!, left[2]!, left[3]!, left[4]!]));
    events.push(sub(20, 'right', [right[1]!, right[2]!, right[3]!, right[4]!]));
    events.push(event({ type: 'begin-overtime', questionNumber: 20 }));
    events.push(dead(21));
    // Powers and negs live in overtime; bonuses do not follow.
    events.push(buzz(format, 22, 'left', left[4]!, 15));
    events.push(buzz(format, 23, 'right', right[4]!, 15));
    events.push(event({ type: 'begin-sudden-death', questionNumber: 23 }));
    events.push(buzz(format, 24, 'left', left[4]!, 10));
    return {
      setup: { left: { name: TEAM_A, players: left }, right: { name: TEAM_B, players: right } },
      events,
    };
  }

  test('overtime flag, no-bonus split, and total TUH survive to SQBS', () => {
    const format = naqtFormat();
    const state = directorFixture();
    addRosterPlayers(state, 'team-1', TEAM_A, [5]);
    addRosterPlayers(state, 'team-2', TEAM_B, [5]);

    const { setup, events } = overtimeEvents(format);
    const derived = deriveGame(format, setup, events);
    expect(derived.tossupsRead).toBe(24);
    expect(derived.overtimeTossupsRead).toBe(4);

    const match = toQbjMatch(format, derived) as {
      match_teams: Array<Record<string, unknown>>;
      tossups_read: number;
      overtime_tossups_read: number;
    };
    expect(match.tossups_read).toBe(24);
    expect(match.overtime_tossups_read).toBe(4);
    expect(match.match_teams[0]?.correct_tossups_without_bonuses).toBe(2);
    expect(match.match_teams[1]?.correct_tossups_without_bonuses).toBe(1);

    const game = acceptScoredGame(state, 'game-5-1', 'game-ot-1', qbjMatchDocument(match), 'complete');
    expect(game.tossupsRead).toBe(24);
    expect(game.overtimeTossupsRead).toBe(4);

    const exported = exportSqbsTournament(state, {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.warnings.filter((entry) => /overtime|no-bonus/i.test(entry))).toEqual([]);
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const sqbsGame = parsed.value.games[0]!;
    expect(sqbsGame.tossupsHeard).toBe(24);
    expect(sqbsGame.overtime).toBe(true);
    expect([sqbsGame.left.score, sqbsGame.right.score]).toEqual([80, 70]);
    expect(sqbsGame.left.tossupsWithoutBonus).toBe(2);
    expect(sqbsGame.right.tossupsWithoutBonus).toBe(1);
    // Overtime powers stay in answer totals at full value (slots are
    // 15/10/-5 in file order for this definition).
    const subStandout = sqbsGame.left.players.find((entry) => entry.points === 25);
    expect(subStandout).toMatchObject({ counts: [1, 1, 0, 0], points: 25 });
    // BH/BP are passed through exactly as the canonical scores hold them:
    // the adapter invents no overtime bonus opportunities.
    expect(sqbsGame.left.bonusesHeard).toBe(game.scores[0]!.bonuses);
    expect(sqbsGame.right.bonusesHeard).toBe(game.scores[1]!.bonuses);
    expect(sqbsGame.left.bonusPoints).toBe(game.scores[0]!.bonusPoints);
    expect(sqbsGame.right.bonusPoints).toBe(game.scores[1]!.bonusPoints);
  });

  test('proven overtime without a per-team split warns instead of writing silent zeroes', () => {
    const state = directorFixture();
    const doc: Record<string, unknown> = {
      type: 'Match',
      tossups_read: 23,
      overtime_tossups_read: 3,
      match_teams: [
        {
          team: { name: TEAM_A },
          points: 300,
          match_players: [
            {
              player: { name: `${TEAM_A} player 1` },
              tossups_heard: 23,
              answer_counts: [{ answer_type: { value: 10 }, number: 6 }],
            },
          ],
        },
        {
          team: { name: TEAM_B },
          points: 250,
          match_players: [
            {
              player: { name: `${TEAM_B} player 1` },
              tossups_heard: 23,
              answer_counts: [{ answer_type: { value: 10 }, number: 5 }],
            },
          ],
        },
      ],
    };
    // No correct_tossups_without_bonuses and no YfData: the split is unknowable.
    acceptScoredGame(state, 'game-5-1', 'game-ot-unknown-1', doc, 'complete');

    const exported = exportSqbsTournament(state, {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.warnings.filter((entry) => /overtime|no-bonus/i.test(entry))).toHaveLength(1);
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.games[0]!.overtime).toBe(true);
  });

  test('no-bonus classification follows each game’s own historical rules', () => {
    const state = directorFixture();
    if (!state.tournament) throw new Error('fixture: no tournament');
    state.tournament.rules = { ...state.tournament.rules, overtimeBonuses: false };
    const yfData = (value: number) => ({
      YfData: { overTimeBuzzes: [{ number: 1, answer_type: { value } }] },
    });
    const yfOnlyDoc = (leftTeam: string, rightTeam: string): Record<string, unknown> => ({
      type: 'Match',
      tossups_read: 22,
      overtime_tossups_read: 2,
      match_teams: [
        { team: { name: leftTeam }, points: 300, ...yfData(10) },
        { team: { name: rightTeam }, points: 250, ...yfData(10) },
      ],
    });

    // Game 1 plays under a pinned definition with overtime bonuses enabled: the
    // same YfData detail must NOT be read as no-bonus conversions.
    const digest = 'digest-ot-bonuses-on';
    state.gameDefinitions.push({
      id: 'snap-ot-on',
      scheduledGameId: 'game-5-1',
      revision: 1,
      createdAt: isoNow(),
      rules: { ...state.tournament.rules, overtimeBonuses: true },
      roundId: 'round-5',
      packetId: 'packet-5',
      leftTeamId: 'team-1',
      rightTeamId: 'team-2',
      leftRoster: [],
      rightRoster: [],
      assignmentRevision: 1,
      digest,
    });
    const onGame = manualGame({
      id: 'game-ot-rules-on',
      scheduledGameId: 'game-5-1',
      scores: [
        {
          teamId: 'team-1',
          score: 300,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
        },
        {
          teamId: 'team-2',
          score: 250,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
        },
      ],
      tossupsRead: 22,
      overtimeTossupsRead: 2,
      definitionDigest: digest,
      rawQbj: yfOnlyDoc(TEAM_A, TEAM_B),
    });
    // Game 2 plays under current defaults (no overtime bonuses): the detail counts.
    const offGame = manualGame({
      id: 'game-ot-rules-off',
      scheduledGameId: 'game-5-2',
      scores: [
        {
          teamId: 'team-3',
          score: 300,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
        },
        {
          teamId: 'team-4',
          score: 250,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
        },
      ],
      tossupsRead: 22,
      overtimeTossupsRead: 2,
      rawQbj: yfOnlyDoc(TEAM_C, TEAM_D),
    });
    state.games.push(onGame, offGame);

    const exported = exportSqbsTournament(state, {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const otWarnings = exported.warnings.filter((entry) => /overtime|no-bonus/i.test(entry));
    expect(otWarnings).toHaveLength(1);
    expect(otWarnings[0]).toContain('game-ot-rules-on');

    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Both games share teams/scores shapes; the no-bonus split disambiguates them.
    const onParsed = parsed.value.games.find(
      (entry) =>
        entry.left.score === 300 && entry.right.score === 250 && entry.left.tossupsWithoutBonus === 0,
    );
    const offParsed = parsed.value.games.find((entry) => entry.left.tossupsWithoutBonus === 1);
    expect(onParsed).toBeDefined();
    expect(offParsed).toBeDefined();
    expect(offParsed!.left.tossupsWithoutBonus).toBe(1);
    expect(offParsed!.right.tossupsWithoutBonus).toBe(1);
    expect(offParsed!.overtime).toBe(true);
  });

  test('regulation games report known zeroes and forfeits fabricate nothing', () => {
    const state = directorFixture();
    state.games.push(
      manualGame({
        id: 'game-reg-1',
        scheduledGameId: 'game-5-1',
        scores: [
          {
            teamId: 'team-1',
            score: 200,
            superpowers: 0,
            powers: 1,
            gets: 5,
            negs: 0,
            bonuses: 6,
            bonusPoints: 100,
          },
          {
            teamId: 'team-2',
            score: 150,
            superpowers: 0,
            powers: 0,
            gets: 4,
            negs: 1,
            bonuses: 4,
            bonusPoints: 60,
          },
        ],
        tossupsRead: 20,
        overtimeTossupsRead: 0,
      }),
      {
        ...manualGame({
          id: 'game-forfeit-1',
          scheduledGameId: 'game-5-2',
          scores: [
            {
              teamId: 'team-3',
              score: 0,
              superpowers: 0,
              powers: 0,
              gets: 0,
              negs: 0,
              bonuses: 0,
              bonusPoints: 0,
            },
            {
              teamId: 'team-4',
              score: 0,
              superpowers: 0,
              powers: 0,
              gets: 0,
              negs: 0,
              bonuses: 0,
              bonusPoints: 0,
            },
          ],
        }),
        status: 'forfeit',
        forfeitedTeamId: 'team-4',
      } as GameRecord,
    );

    const exported = exportSqbsTournament(state, {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.warnings.filter((entry) => /overtime|no-bonus/i.test(entry))).toEqual([]);
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const regulation = parsed.value.games.find((entry) => !entry.forfeit)!;
    expect(regulation.overtime).toBe(false);
    expect(regulation.left.tossupsWithoutBonus).toBe(0);
    expect(regulation.right.tossupsWithoutBonus).toBe(0);
    const forfeit = parsed.value.games.find((entry) => entry.forfeit)!;
    expect(forfeit.overtime).toBe(false);
    expect(forfeit.left.tossupsWithoutBonus).toBe(0);
    expect(forfeit.right.tossupsWithoutBonus).toBe(0);
  });
});
