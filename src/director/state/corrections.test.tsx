import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  acceptedGameRecords,
  advancementBasisStatus,
  advancementBasisToken,
  deriveTeamStandings,
  resultRevisionOf,
} from '../domain';
import { MemoryDirectorRepository } from '../persistence';
import { score, scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';
import { useDirectorController } from './useDirectorController';
import type { DirectorState } from '../domain';
import { dropTeamFlexibly } from './flexibleEditing';

function forfeitState(): DirectorState {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
  state.rounds[0]!.scheduledGameIds = ['scheduled-1'];
  state.scheduledGames.push(scheduledGame('scheduled-1', 'team-a', 'team-b', { status: 'accepted' }));
  state.games.push({
    id: 'forfeit-game',
    scheduledGameId: 'scheduled-1',
    roundId: 'round-1',
    packetId: null,
    status: 'forfeit',
    forfeitedTeamId: 'team-a',
    scores: [score('team-a', 0), score('team-b', 0)],
    playerStats: [],
    source: 'manual',
    detailedStats: 'unknown',
    acceptedAt: '2026-09-05T12:00:00.000Z',
  });
  state.submissions.push({
    id: 'forfeit-submission',
    gameId: 'forfeit-game',
    receivedAt: '2026-09-05T12:00:00.000Z',
    fingerprint: 'forfeit-fingerprint',
    status: 'accepted',
    rawSubmission: { source: 'manual', outcome: 'forfeit', forfeitedTeamId: 'team-a' },
    acceptedBy: 'Director',
    acceptedAt: '2026-09-05T12:00:00.000Z',
  });
  return state;
}

async function controllerFor(state: DirectorState) {
  const repository = new MemoryDirectorRepository();
  await repository.save(state);
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { hook, repository };
}

function committedAdvancementState(): DirectorState {
  const state = forfeitState();
  state.phases.push({
    id: 'playoffs',
    name: 'Playoffs',
    roundIds: ['downstream-round'],
  } as DirectorState['phases'][number]);
  state.audit.push({
    id: 'advancement-audit',
    at: '2026-09-05T12:01:00.000Z',
    actor: 'Director',
    type: 'advancement-committed',
    entityId: 'playoffs',
    summary: 'Committed advancement.',
    details: { sourcePhaseId: 'phase-1' },
  });
  state.scheduledGames.push(
    scheduledGame('downstream-game', 'team-a', 'team-b', {
      roundId: 'downstream-round',
      status: 'scheduled',
    }),
  );
  state.rounds.push({
    ...state.rounds[0]!,
    id: 'downstream-round',
    phaseId: 'playoffs',
    name: 'Playoffs Round 1',
    scheduledGameIds: ['downstream-game'],
    status: 'planned',
  });
  return state;
}

describe('administrative result corrections', () => {
  test.each([
    ['reopen', { kind: 'reopen' as const }],
    ['switch', { kind: 'forfeit' as const, forfeitedTeamId: 'team-b' }],
    [
      'played result',
      {
        kind: 'scores' as const,
        scores: [score('team-a', 250), score('team-b', 200)],
      },
    ],
  ])('retains the original forfeit while applying the %s outcome', async (_label, replacement) => {
    const { hook, repository } = await controllerFor(forfeitState());
    let saved = false;
    act(() => {
      saved = hook.result.current.correctForfeit(
        'scheduled-1',
        replacement,
        'Operator selected the wrong outcome.',
      );
    });
    expect(saved).toBe(true);
    await waitFor(() => expect(hook.result.current.saving).toBe(false));

    const state = hook.result.current.state;
    const oldGame = state.games.find((game) => game.id === 'forfeit-game');
    const oldSubmission = state.submissions.find((submission) => submission.id === 'forfeit-submission');
    expect(oldGame?.status).toBe('rejected');
    expect(oldSubmission?.status).toBe('superseded');
    expect(state.audit.some((event) => event.type === 'result-edited' && event.details?.correctionKind)).toBe(
      true,
    );
    if (replacement.kind === 'reopen') {
      expect(state.scheduledGames[0]?.status).toBe('released');
      expect(acceptedGameRecords(state)).toHaveLength(0);
    } else {
      expect(state.scheduledGames[0]?.status).toBe('accepted');
      const current = acceptedGameRecords(state);
      expect(current).toHaveLength(1);
      if (replacement.kind === 'forfeit') {
        expect(current[0]?.forfeitedTeamId).toBe('team-b');
        expect(
          deriveTeamStandings(state, current).find((standing) => standing.teamId === 'team-a')?.wins,
        ).toBe(1);
      } else {
        expect(current[0]?.scores.find((entry) => entry.teamId === 'team-a')?.score).toBe(250);
        expect(
          deriveTeamStandings(state, current).find((standing) => standing.teamId === 'team-a')?.pointsFor,
        ).toBe(250);
      }
    }
    const reloaded = await repository.load();
    expect(reloaded.games.find((game) => game.id === 'forfeit-game')?.status).toBe('rejected');
    expect(reloaded.submissions.find((submission) => submission.id === 'forfeit-submission')?.status).toBe(
      'superseded',
    );
  });

  /**
   * A committed advancement whose basis verifies, so a later correction must retire it
   * explicitly instead of leaving it silently current.
   */
  function verifiableAdvancementState(): DirectorState {
    const state = committedAdvancementState();
    const phase = state.phases.find((entry) => entry.id === 'phase-1')!;
    const commit = state.audit.find((entry) => entry.type === 'advancement-committed')!;
    commit.details = {
      ...((commit.details as Record<string, unknown> | undefined) ?? {}),
      basisToken: advancementBasisToken(state, phase),
      qualifierTeamIds: ['team-a'],
    };
    expect(advancementBasisStatus(state, 'phase-1')).toBe('current');
    return state;
  }

  test.each(['reopen', 'switch-forfeit', 'score replacement'] as const)(
    'correctForfeit applies %s after advancement when nothing downstream is issued, and retires the basis',
    async (kind) => {
      const state = verifiableAdvancementState();
      const { hook } = await controllerFor(state);
      const replacement =
        kind === 'reopen'
          ? { kind: 'reopen' as const }
          : kind === 'switch-forfeit'
            ? { kind: 'forfeit' as const, forfeitedTeamId: 'team-b' }
            : { kind: 'scores' as const, scores: [score('team-a', 250), score('team-b', 200)] };

      act(() => {
        expect(
          hook.result.current.correctForfeit('scheduled-1', replacement, 'The original result was wrong.'),
        ).toBe(true);
      });
      await waitFor(() => expect(hook.result.current.saving).toBe(false));

      const next = hook.result.current.state;
      expect(next.games.find((game) => game.id === 'forfeit-game')?.status).toBe('rejected');
      // The dependent basis no longer verifies, and the audit says why.
      expect(advancementBasisStatus(next, 'phase-1')).toBe('stale');
      const stale = next.audit.find((entry) => entry.type === 'advancement-stale');
      expect(stale?.details).toMatchObject({ sourcePhaseId: 'phase-1', cause: 'administrative-correction' });
      if (kind !== 'reopen') {
        const current = next.games.find(
          (game) => game.scheduledGameId === 'scheduled-1' && game.status !== 'rejected',
        );
        expect(resultRevisionOf(current!)).toBe(2);
      }
    },
  );

  test.each(['accepted result', 'protest score adjustment'] as const)(
    '%s correction applies after advancement when nothing downstream is issued, with a new result revision',
    async (path) => {
      const state = verifiableAdvancementState();
      const game = state.games[0]!;
      game.status = 'accepted';
      delete game.forfeitedTeamId;
      game.scores = [score('team-a', 100), score('team-b', 90)];
      // Re-stamp the basis after reshaping the fixture game: the commit verifies this game.
      const phase = state.phases.find((entry) => entry.id === 'phase-1')!;
      const commit = state.audit.find((entry) => entry.type === 'advancement-committed')!;
      commit.details = {
        ...((commit.details as Record<string, unknown> | undefined) ?? {}),
        basisToken: advancementBasisToken(state, phase),
      };
      expect(advancementBasisStatus(state, 'phase-1')).toBe('current');
      if (path === 'protest score adjustment') {
        state.protests.push({
          id: 'protest-1',
          gameId: game.id,
          category: 'other',
          description: 'Correction path test',
          status: 'open',
          createdAt: '2026-09-05T12:00:00.000Z',
          updatedAt: '2026-09-05T12:00:00.000Z',
        });
      }
      const { hook } = await controllerFor(state);

      act(() => {
        const saved =
          path === 'accepted result'
            ? hook.result.current.editAcceptedResult(
                game.id,
                [score('team-a', 250), score('team-b', 200)],
                'The score was entered incorrectly.',
              )
            : hook.result.current.ruleProtest('protest-1', 'Awarded the disputed points.', {
                teamId: 'team-a',
                delta: 10,
              });
        expect(saved).toBe(true);
      });
      await waitFor(() => expect(hook.result.current.saving).toBe(false));

      const next = hook.result.current.state;
      expect(resultRevisionOf(next.games.find((entry) => entry.id === game.id)!)).toBe(2);
      expect(advancementBasisStatus(next, 'phase-1')).toBe('stale');
      expect(next.audit.find((entry) => entry.type === 'advancement-stale')?.details).toMatchObject({
        sourcePhaseId: 'phase-1',
        cause: 'result-correction',
      });
    },
  );

  test('a correction is refused atomically once a downstream assignment is issued', async () => {
    const state = verifiableAdvancementState();
    state.rounds.find((round) => round.id === 'downstream-round')!.status = 'released';
    const { hook } = await controllerFor(state);
    const before = structuredClone(hook.result.current.state);

    act(() => {
      expect(
        hook.result.current.correctForfeit(
          'scheduled-1',
          { kind: 'scores' as const, scores: [score('team-a', 250), score('team-b', 200)] },
          'The original result was wrong.',
        ),
      ).toBe(false);
    });
    expect(hook.result.current.state).toEqual(before);
    expect(hook.result.current.error).toContain('downstream-game');
    expect(hook.result.current.error).toMatch(/reissue/i);
  });

  test('a correction is refused atomically once a downstream game has a result', async () => {
    const state = verifiableAdvancementState();
    state.scheduledGames.find((game) => game.id === 'downstream-game')!.status = 'accepted';
    const { hook } = await controllerFor(state);
    const before = structuredClone(hook.result.current.state);

    act(() => {
      expect(
        hook.result.current.editAcceptedResult(
          'forfeit-game',
          [score('team-a', 250), score('team-b', 200)],
          'The score was entered incorrectly.',
        ),
      ).toBe(false);
    });
    expect(hook.result.current.state).toEqual(before);
    expect(hook.result.current.error).toMatch(/recovery action/i);
  });

  test('blocks a correction that would rewrite an active downstream bracket game', async () => {
    const state = forfeitState();
    state.teams.push(team('team-c', 'Gamma'), team('team-d', 'Delta'));
    state.teams[0]!.seed = 1;
    state.teams[1]!.seed = 4;
    state.teams[2]!.seed = 2;
    state.teams[3]!.seed = 3;
    state.formats.push({
      id: 'format-1',
      name: 'Elimination',
      kind: 'single-elimination',
      phaseIds: ['phase-1'],
      roundsPerTeam: null,
      avoidRematches: false,
      avoidSameOrganization: false,
      allowByes: false,
      editable: false,
      bracket: {
        teamCount: 4,
        bracketSize: 4,
        roundCount: 2,
        seeding: [
          { seed: 1, teamId: 'team-a' },
          { seed: 2, teamId: 'team-c' },
          { seed: 3, teamId: 'team-d' },
          { seed: 4, teamId: 'team-b' },
        ],
        nodes: [
          {
            key: 'A',
            roundIndex: 0,
            sequence: 0,
            label: 'Semifinal',
            kind: 'elimination',
            slotA: { kind: 'seed', seed: 1 },
            slotB: { kind: 'seed', seed: 4 },
          },
          {
            key: 'B',
            roundIndex: 0,
            sequence: 1,
            label: 'Semifinal',
            kind: 'elimination',
            slotA: { kind: 'seed', seed: 2 },
            slotB: { kind: 'seed', seed: 3 },
          },
          {
            key: 'C',
            roundIndex: 1,
            sequence: 0,
            label: 'Final',
            kind: 'elimination',
            slotA: { kind: 'winner', gameKey: 'A' },
            slotB: { kind: 'winner', gameKey: 'B' },
          },
        ],
        byes: [],
        roundNumbers: [1, 2],
        roundIds: {},
      },
    });
    state.scheduledGames[0]!.rightTeamId = 'team-d';
    state.scheduledGames[0]!.bracketKey = 'A';
    state.rounds[0]!.scheduledGameIds = ['scheduled-1', 'semi-2'];
    state.scheduledGames.push(
      scheduledGame('semi-2', 'team-c', 'team-d', { status: 'accepted', bracketKey: 'B' }),
      scheduledGame('final-game', 'team-d', 'team-c', {
        roundId: 'round-2',
        status: 'released',
        bracketKey: 'C',
      }),
    );
    state.rounds.push({
      ...state.rounds[0]!,
      id: 'round-2',
      name: 'Final',
      number: 2,
      status: 'released',
      scheduledGameIds: ['final-game'],
    });
    state.phases[0]!.roundIds.push('round-2');
    state.games.push({
      id: 'semi-2-result',
      scheduledGameId: 'semi-2',
      roundId: 'round-1',
      packetId: null,
      status: 'accepted',
      scores: [score('team-c', 250), score('team-d', 200)],
      playerStats: [],
      source: 'manual',
      detailedStats: 'unknown',
      acceptedAt: '2026-09-05T12:00:00.000Z',
    });
    state.submissions.push({
      id: 'semi-2-submission',
      gameId: 'semi-2-result',
      receivedAt: '2026-09-05T12:00:00.000Z',
      fingerprint: 'semi-2-fingerprint',
      status: 'accepted',
      rawSubmission: {},
      acceptedAt: '2026-09-05T12:00:00.000Z',
    });
    const { hook } = await controllerFor(state);
    act(() => {
      expect(
        hook.result.current.correctForfeit(
          'scheduled-1',
          { kind: 'forfeit', forfeitedTeamId: 'team-d' },
          'The wrong team was selected.',
        ),
      ).toBe(false);
    });
    expect(hook.result.current.state.scheduledGames[0]?.status).toBe('accepted');
    expect(hook.result.current.error).toMatch(/final-game/);
  });
});

test('restoring a dropped team reopens only attributable future games and records review work', async () => {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
  state.teams[0]!.status = 'dropped';
  state.rounds[0]!.status = 'planned';
  state.rounds[0]!.scheduledGameIds = ['drop-game', 'manual-game', 'closed-game'];
  state.scheduledGames.push(
    scheduledGame('drop-game', 'team-a', 'team-b', {
      status: 'cancelled',
      cancellation: { reasonKind: 'team-dropped', teamId: 'team-a', reason: 'No-show', at: '2026-09-05' },
    }),
    scheduledGame('manual-game', 'team-a', 'team-b', {
      status: 'cancelled',
      cancellation: { reasonKind: 'manual', reason: 'Packet issue', at: '2026-09-05' },
    }),
    scheduledGame('closed-game', 'team-a', 'team-b', {
      roundId: 'closed-round',
      status: 'cancelled',
      cancellation: { reasonKind: 'team-dropped', teamId: 'team-a', reason: 'No-show', at: '2026-09-05' },
    }),
  );
  state.rounds.push({
    ...state.rounds[0]!,
    id: 'closed-round',
    status: 'closed',
    scheduledGameIds: ['closed-game'],
  });
  const { hook, repository } = await controllerFor(state);
  act(() => expect(hook.result.current.restoreTeam('team-a')).toBe(true));
  expect(hook.result.current.state.teams.find((entry) => entry.id === 'team-a')?.status).toBe('confirmed');
  expect(hook.result.current.state.scheduledGames.find((game) => game.id === 'drop-game')?.status).toBe(
    'scheduled',
  );
  expect(
    hook.result.current.state.scheduledGames.find((game) => game.id === 'drop-game')?.cancellation,
  ).toBeUndefined();
  expect(hook.result.current.state.scheduledGames.find((game) => game.id === 'manual-game')?.status).toBe(
    'cancelled',
  );
  expect(hook.result.current.state.scheduledGames.find((game) => game.id === 'closed-game')?.status).toBe(
    'cancelled',
  );
  const repair = hook.result.current.state.audit.find((event) => event.type === 'schedule-repaired');
  expect(repair?.details?.reviewRequired).toEqual([
    { scheduledGameId: 'closed-game', roundId: 'closed-round', reason: 'The round is already closed.' },
  ]);
  await waitFor(() => expect(hook.result.current.saving).toBe(false));
  const reloaded = await repository.load();
  expect(reloaded.scheduledGames.find((game) => game.id === 'manual-game')?.cancellation?.reasonKind).toBe(
    'manual',
  );
  expect(reloaded.scheduledGames.find((game) => game.id === 'closed-game')?.cancellation?.teamId).toBe(
    'team-a',
  );
});

test('dropTeamFlexibly records per-game team-drop provenance for later restoration', async () => {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
  state.rounds[0]!.status = 'planned';
  state.rounds[0]!.scheduledGameIds = ['drop-game'];
  state.scheduledGames.push(scheduledGame('drop-game', 'team-a', 'team-b', { status: 'scheduled' }));
  const { hook } = await controllerFor(state);
  let dropped = false;
  await act(async () => {
    dropped = await dropTeamFlexibly(hook.result.current, 'team-a', 'No-show');
  });
  expect(dropped).toBe(true);
  expect(hook.result.current.state.scheduledGames[0]?.cancellation).toMatchObject({
    reasonKind: 'team-dropped',
    teamId: 'team-a',
    reason: 'No-show',
  });
  expect(hook.result.current.state.audit.some((event) => event.type === 'schedule-cancelled')).toBe(true);
});
