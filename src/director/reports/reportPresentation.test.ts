import { describe, expect, test } from 'vitest';
import { defaultReportOptions } from '@qbsheet/tournament-formats';
import { directorFixture } from '../transfers/testFixtures';
import { buildCanonicalSnapshot } from './canonicalReports';
import { withReportPresentation } from './reportPresentation';

describe('Director report presentation adapter', () => {
  test('attaches public metadata, enabled zero tiers, and configured points-per-X without leaking private state', () => {
    const state = directorFixture({ games: 1 });
    state.tournament!.name = 'Public Invitational';
    state.tournament!.date = '2026-09-12';
    state.tournament!.endDate = '2026-09-13';
    state.tournament!.venue = 'Gould Hall';
    state.tournament!.questionSet = 'Custom Set';
    state.tournament!.organizer = 'Tournament Staff';
    state.tournament!.rules.superpowerValue = 20;
    state.tournament!.rules.powerValue = 15;
    state.tournament!.rules.tossupCount = 24;
    state.tournament!.rules.useBonuses = false;
    state.teams[0]!.notes = 'PRIVATE TEAM NOTE';
    state.audit.push({
      id: 'private-audit',
      at: '2026-09-09T20:00:00.000Z',
      actor: 'private@example.com',
      type: 'exported',
      summary: 'PRIVATE AUDIT DETAIL',
    });

    const options = { ...defaultReportOptions, pages: [...defaultReportOptions.pages], pointsMetric: 'pointsPerX' as const };
    const snapshot = withReportPresentation(
      state,
      buildCanonicalSnapshot(state, undefined, '2026-09-09T21:00:00.000Z'),
      options,
    );

    expect(snapshot.presentation?.metadata).toMatchObject({
      tournamentName: 'Public Invitational',
      startDate: '2026-09-12',
      endDate: '2026-09-13',
      venue: 'Gould Hall',
      questionSet: 'Custom Set',
      organizer: 'Tournament Staff',
    });
    expect(snapshot.presentation?.answerColumns.map((column) => column.key)).toContain('superpower');
    expect(snapshot.presentation?.pointsNormalization).toEqual({ tossups: 24, label: 'Pts/24' });
    expect(snapshot.presentation?.applicability.bonuses).toBe(false);
    expect(snapshot.teams[0]?.answerCounts).toHaveProperty('superpower');
    expect(snapshot.teams[0]?.pointsPerX).toBe(
      snapshot.teams[0]?.pptuh === null ? null : snapshot.teams[0]!.pptuh * 24,
    );
    const presentationJson = JSON.stringify(snapshot.presentation);
    expect(presentationJson).not.toContain('PRIVATE TEAM NOTE');
    expect(presentationJson).not.toContain('PRIVATE AUDIT DETAIL');
    expect(presentationJson).not.toContain('private@example.com');
  });

  test('report options are presentation-only and do not mutate competitive state', () => {
    const state = directorFixture({ games: 1 });
    const before = structuredClone(state);
    const snapshot = buildCanonicalSnapshot(state, undefined, '2026-09-09T21:00:00.000Z');
    const presented = withReportPresentation(state, snapshot, {
      ...defaultReportOptions,
      pages: ['standings', 'games'],
      showPointsForAgainstMargin: false,
      showPacket: false,
    });

    expect(presented.presentation?.options.pages).toEqual(['standings', 'games']);
    expect(state).toEqual(before);
  });
});
