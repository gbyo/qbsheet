/**
 * Scenario G: a custom 20 / 15 / 10 / -5 format with non-default bonus and
 * overtime settings must survive the whole electronic path with every point
 * value intact:
 *
 * Director rules -> assignment QBJ -> scorer format -> result QBJ ->
 * Director stats -> stat report.
 *
 * No point value may be silently simplified along the way.
 */
import { describe, expect, it } from 'vitest';
import { readQbjScoringRules } from '../../qbj/QbjScoringRules';
import { toInterchange } from '../format/interchange';
import { scoringRulesObject } from './assignment';
import { ingestWarnings, readResultStatistics } from './ingest';
import { assignmentFor, directorFixture } from './testFixtures';
import type { DirectorState } from '../domain/model';

function customRules(): NonNullable<DirectorState['tournament']>['rules'] {
  const state = directorFixture();
  const base = state.tournament?.rules;
  if (!base) throw new Error('fixture: no tournament rules');
  return {
    ...base,
    tossupValue: 10,
    superpowerValue: 20,
    powerValue: 15,
    negValue: -5,
    useBonuses: true,
    bonusValue: 10,
    tossupCount: 20,
    bonusParts: 3,
    minimumBonusParts: null,
    maximumBonusScore: null,
    bonusDivisor: null,
    // Non-default bonus and overtime settings.
    bouncebacks: true,
    overtime: true,
    overtimeTossupCount: 3,
    overtimeBonuses: false,
    timed: false,
  };
}

function counts(counts: Array<[number, number]>) {
  return counts.map(([value, number]) => ({ answer_type: { value }, number }));
}

describe('scenario G: custom 20/15/10/-5 rules round-trip exactly', () => {
  it('writes every tier into the assignment and the scorer reads them back', () => {
    const rules = customRules();
    const qbj = scoringRulesObject(rules, 'scoring-rules-g');
    const answerValues = ((qbj.answer_types ?? []) as Array<{ value?: unknown }>).map((entry) => entry.value);
    expect(answerValues).toEqual([20, 15, 10, -5]);

    const read = readQbjScoringRules(qbj, rules.timed);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.format.answerTypes.map((type) => type.value)).toEqual([20, 15, 10, -5]);
    expect(read.format.overtime.minimumQuestionCount).toBe(3);
    expect(read.format.overtime.includesBonuses).toBe(false);
    expect(read.format.bonus?.bounceBack).toBe(true);
  });

  it('attributes every tier on ingest and reconciles points in the stat report', () => {
    const state = directorFixture();
    const rules = customRules();
    if (!state.tournament) throw new Error('fixture: no tournament');
    state.tournament.rules = rules;

    // Score the assignment the way a room scorer would: two superpowers, three
    // powers, eight gets, one neg, eleven bonuses heard for 200 bonus points.
    const assignment = assignmentFor(state, 'game-5-1');
    const document = structuredClone(assignment.document) as {
      objects: Array<Record<string, unknown>>;
    };
    const match = document.objects.find((object) => object.type === 'Match');
    if (!match) throw new Error('fixture: the assignment has no match');
    match.tossups_read = 20;
    const teams = match.match_teams as Array<Record<string, unknown>>;
    const leftRef = (teams[0].team as { $ref: string }).$ref;
    const rightRef = (teams[1].team as { $ref: string }).$ref;
    teams[0].points = 360;
    teams[0].bonuses_heard = 11;
    teams[0].bonus_points = 200;
    teams[0].match_players = [
      {
        player: { $ref: `${leftRef}-player-1` },
        // No tossups_heard: the fallback must count every tier, superpowers included.
        answer_counts: counts([
          [20, 2],
          [15, 3],
          [10, 8],
          [-5, 1],
        ]),
      },
    ];
    teams[1].points = 120;
    teams[1].bonuses_heard = 4;
    teams[1].bonus_points = 40;
    teams[1].match_players = [
      {
        player: { $ref: `${rightRef}-player-1` },
        tossups_heard: 20,
        answer_counts: counts([
          [15, 2],
          [10, 5],
          [-5, 0],
        ]),
      },
    ];

    const scheduled = state.scheduledGames.find((game) => game.id === 'game-5-1');
    const { scores, playerStats, warnings } = readResultStatistics(document, state, scheduled);
    expect(warnings).toEqual([]);
    expect(scores).toHaveLength(2);
    // 2*20 + 3*15 + 8*10 - 5 + 200 = 360. Nothing is dropped or revalued.
    expect(scores[0]).toMatchObject({
      score: 360,
      superpowers: 2,
      powers: 3,
      gets: 8,
      negs: 1,
      bonuses: 11,
      bonusPoints: 200,
    });
    expect(scores[1]).toMatchObject({
      score: 120,
      superpowers: 0,
      powers: 2,
      gets: 5,
      negs: 0,
      bonuses: 4,
      bonusPoints: 40,
    });
    const scorer = playerStats.find((player) => player.playerId === 'team-1-player-1');
    expect(scorer).toMatchObject({
      superpowers: 2,
      powers: 3,
      gets: 8,
      negs: 1,
      bonusPoints: 0,
      tossupsHeard: 14,
    });

    // The stat report recomputes player points from the same canonical rules.
    state.games.push({
      id: 'game-g-1',
      scheduledGameId: 'game-5-1',
      roundId: 'round-5',
      packetId: null,
      status: 'accepted',
      scores,
      playerStats,
      source: 'qbtcp',
      finishedAt: '2026-09-05T14:00:00.000Z',
      acceptedAt: '2026-09-05T14:01:00.000Z',
    });
    const exported = toInterchange(state).games.find((game) => game.id === 'game-g-1');
    const exportedScorer = exported?.result?.players?.find((player) => player.playerId === 'team-1-player-1');
    // 2*20 + 3*15 + 8*10 - 5 + 0 bonus = 160.
    expect(exportedScorer).toMatchObject({ superpowers: 2, points: 160 });
  });

  it('warns rather than drops a point value the rules do not name', () => {
    const state = directorFixture();
    const scheduled = state.scheduledGames.find((game) => game.id === 'game-5-1');
    const { scores, warnings } = readResultStatistics(
      {
        type: 'Match',
        match_teams: [
          {
            team: { $ref: 'team-1' },
            points: 100,
            match_players: [
              {
                player: { $ref: 'team-1-player-1' },
                answer_counts: [{ answer_type: { value: 25 }, number: 4 }],
              },
            ],
          },
        ],
      },
      state,
      scheduled,
    );
    // 4 × 25 is kept in the total even though no bucket names it.
    expect(scores[0]?.score).toBe(100);
    expect(scores[0]).toMatchObject({ superpowers: 0, powers: 0, gets: 0, negs: 0 });
    expect(warnings).toContain(ingestWarnings.unrecognizedAnswerValue);
  });
});
