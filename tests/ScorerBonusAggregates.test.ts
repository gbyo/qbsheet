/**
 * Native Scorer bonus aggregates must survive to Director (#889).
 *
 * A normal QBSheet Scorer result already knows exact team Bonuses Heard and
 * Bonus Points (deriveGame). Those facts must travel in the portable QBJ
 * (bonuses_heard / bonus_points) and arrive intact through Director ingest
 * so canonical PPB matches the room. Missing BH must never become a verified
 * zero on this path; overtime no-bonus conversions must not invent bonuses.
 */
import { describe, expect, test } from 'vitest';
import deriveGame from '../src/scoring/deriveGame';
import toQbjMatch from '../src/scoring/toQbjMatch';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules, typeIndex } from './rules';
import { event } from './events';
import { readResultStatistics } from '../src/director/transfers/ingest';
import { directorFixture } from '../src/director/transfers/testFixtures';
import { bonusPointsPerBonus } from '../packages/tournament-domain/src/stats';

const LEFT_TEAM = 'Ninety Six A';
const RIGHT_TEAM = 'Greenwood A';
const LEFT_P1 = 'Ninety Six A player 1';
const RIGHT_P1 = 'Greenwood A player 1';

function naqtFormat() {
  return scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.NaqtUntimed));
}

function setup() {
  return {
    left: { name: LEFT_TEAM, players: [LEFT_P1, 'Ninety Six A player 2'] },
    right: { name: RIGHT_TEAM, players: [RIGHT_P1, 'Greenwood A player 2'] },
  };
}

/** Two heard bonuses for left (20 + 0 pts), one for right (10 pts). */
function regulationEvents(format: ReturnType<typeof naqtFormat>) {
  return [
    event({
      type: 'tossup-buzz',
      questionNumber: 1,
      team: 'left',
      playerName: LEFT_P1,
      answerTypeIndex: typeIndex(format, 15),
    }),
    event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
    event({
      type: 'tossup-buzz',
      questionNumber: 2,
      team: 'right',
      playerName: RIGHT_P1,
      answerTypeIndex: typeIndex(format, 10),
    }),
    event({ type: 'bonus', questionNumber: 2, team: 'right', controlledPoints: 10 }),
    event({
      type: 'tossup-buzz',
      questionNumber: 3,
      team: 'left',
      playerName: LEFT_P1,
      answerTypeIndex: typeIndex(format, 10),
    }),
    // Heard but unconverted: BH increments, BP does not.
    event({ type: 'bonus', questionNumber: 3, team: 'left', controlledPoints: 0 }),
  ];
}

function qbjDocument(match: Record<string, unknown>) {
  return { type: 'Match', ...match } as Record<string, unknown>;
}

describe('native scorer bonus aggregates (#889)', () => {
  test('toQbjMatch emits exact bonuses_heard and bonus_points', () => {
    const format = naqtFormat();
    const game = deriveGame(format, setup(), regulationEvents(format));

    expect(game.left.bonusesHeard).toBe(2);
    expect(game.left.bonusPoints).toBe(20);
    expect(game.right.bonusesHeard).toBe(1);
    expect(game.right.bonusPoints).toBe(10);

    const match = toQbjMatch(format, game) as {
      match_teams: Array<Record<string, unknown>>;
    };
    expect(match.match_teams[0]?.bonuses_heard).toBe(2);
    expect(match.match_teams[0]?.bonus_points).toBe(20);
    expect(match.match_teams[1]?.bonuses_heard).toBe(1);
    expect(match.match_teams[1]?.bonus_points).toBe(10);
  });

  test('Director ingest preserves exact BH/BP and PPB through the production path', () => {
    const format = naqtFormat();
    const game = deriveGame(format, setup(), regulationEvents(format));
    const match = toQbjMatch(format, game) as Record<string, unknown>;

    const state = directorFixture();
    const scheduled = state.scheduledGames.find((entry) => entry.id === 'game-5-1');
    const { scores, warnings } = readResultStatistics(qbjDocument(match), state, scheduled);

    expect(warnings).toEqual([]);
    expect(scores).toHaveLength(2);
    const left = scores.find((entry) => entry.teamId === 'team-1');
    const right = scores.find((entry) => entry.teamId === 'team-2');
    expect(left).toMatchObject({ bonuses: 2, bonusPoints: 20 });
    expect(right).toMatchObject({ bonuses: 1, bonusPoints: 10 });
    // Distinct denominators prove this is not a coincidental score residual:
    // left PPB = 10, right PPB = 10 would coincide here, so check the raw pair.
    expect(bonusPointsPerBonus(left!.bonusPoints, left!.bonuses)).toBeCloseTo(10);
    expect(bonusPointsPerBonus(right!.bonusPoints, right!.bonuses)).toBeCloseTo(10);
    expect(left!.bonuses).not.toBe(0);
  });

  test('overtime no-bonus conversions do not create phantom bonuses heard', () => {
    const format = naqtFormat();
    const dead = [];
    for (let questionNumber = 4; questionNumber <= 20; questionNumber += 1) {
      dead.push(event({ type: 'tossup-dead', questionNumber }));
    }
    const events = [
      ...regulationEvents(format),
      ...dead,
      event({ type: 'begin-overtime', questionNumber: 20 }),
      event({
        type: 'tossup-buzz',
        questionNumber: 21,
        team: 'left',
        playerName: LEFT_P1,
        answerTypeIndex: typeIndex(format, 10),
      }),
    ];
    const game = deriveGame(format, setup(), events);
    // The overtime get adds 10 tossup points but no bonus opportunity.
    expect(game.left.bonusesHeard).toBe(2);

    const match = toQbjMatch(format, game) as {
      match_teams: Array<Record<string, unknown>>;
    };
    expect(match.match_teams[0]?.bonuses_heard).toBe(2);

    const state = directorFixture();
    const scheduled = state.scheduledGames.find((entry) => entry.id === 'game-5-1');
    const { scores } = readResultStatistics(qbjDocument(match), state, scheduled);
    const left = scores.find((entry) => entry.teamId === 'team-1');
    expect(left).toMatchObject({ bonuses: 2 });
  });
});
