import { act, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { deriveTeamStandings, orderDayItems, recommendTournamentPlan, runPreflight } from '../domain';
import { IndexedDbDirectorRepository } from '../persistence';
import { useDirectorController } from '../state/useDirectorController';
import { currentOperationalRound, buildAssignment } from '../transfers/assignment';
import { scoreAssignment } from '../transfers/testFixtures';
import { score } from '../../../tests/directorFixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('ten teams: five rounds, lunch, four rounds; optional clocks, manual/USB/QBTCP results and reload', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const repository = new IndexedDbDirectorRepository();
  let hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  act(() => {
    hook.result.current.createTournament({ name: 'Next Saturday', date: '', venue: '', organizer: '' });
    for (let index = 1; index <= 10; index++) hook.result.current.addTeam({ displayName: `Team ${index}` });
    expect(hook.result.current.applyTournamentPlan(recommendTournamentPlan(10)!.recommended)).toBe(true);
    hook.result.current.addTimelineEvent({ title: 'Lunch', type: 'lunch', visibility: 'public' });
  });
  const lunch = hook.result.current.state.timeline[0];
  act(() => {
    for (let move = 0; move < 4; move++) hook.result.current.moveDayItem(lunch.id, 'up');
  });
  const rounds = hook.result.current.state.rounds;
  expect(rounds).toHaveLength(9);
  expect(hook.result.current.state.scheduledGames).toHaveLength(45);
  const pairs = hook.result.current.state.scheduledGames.map((game) =>
    [game.leftTeamId, game.rightTeamId].sort().join('/'),
  );
  expect(new Set(pairs).size).toBe(45);
  expect(rounds.every((round) => round.scheduledGameIds.length === 5 && !round.scheduledStart)).toBe(true);
  expect(hook.result.current.state.timeline[0].scheduledStart).toBeNull();
  expect(
    orderDayItems(rounds, hook.result.current.state.timeline).map(
      (item) => item.round?.name ?? item.event?.title,
    ),
  ).toEqual([
    'Round 1',
    'Round 2',
    'Round 3',
    'Round 4',
    'Round 5',
    'Lunch',
    'Round 6',
    'Round 7',
    'Round 8',
    'Round 9',
  ]);
  expect(currentOperationalRound(hook.result.current.state)?.number).toBe(1);
  expect(runPreflight(hook.result.current.state, false, true).some((issue) => issue.area === 'qbtcp')).toBe(
    false,
  );
  expect(hook.result.current.state.transfers.locations).toEqual([]);
  const tournamentId = hook.result.current.state.tournament!.id;

  for (const round of rounds) {
    await act(async () => {
      expect((await hook.result.current.startRound(round.id)).ok).toBe(true);
    });
    expect(hook.result.current.state.rounds.find((entry) => entry.id === round.id)?.status).toBe('released');
    act(() => {
      expect(hook.result.current.finishRound(round.id)).toMatchObject({ finished: false, remaining: 5 });
    });
    const games = hook.result.current.state.scheduledGames.filter((game) => game.roundId === round.id);
    for (let index = 0; index < games.length; index++) {
      const game = games[index];
      if (round.number === 9 && index === 4) {
        act(() => {
          expect(hook.result.current.cancelScheduledGame(game.id, 'Unplayed by agreement')).toBe(true);
        });
        continue;
      }
      act(() => {
        if (index < 2) {
          const assignment = buildAssignment(hook.result.current.state, game.id);
          if (!assignment.ok) throw new Error(assignment.failure.reason);
          const result = scoreAssignment(assignment.assignment.document);
          const sourceKind = index === 0 ? ('removable-drive' as const) : ('qbtcp' as const);
          const input = {
            sourceKind,
            sourceLabel: sourceKind,
            fileName: `${game.id}.qbj`,
            byteLength: JSON.stringify(result).length,
            digest: game.id,
            qbj: result,
          };
          hook.result.current.importTransferDocuments([{ ok: true, document: input }]);
          // Returning the same result by another transport does not create a second game.
          hook.result.current.importTransferDocuments([
            { ok: true, document: { ...input, sourceKind: 'file-picker', digest: `${game.id}-copy` } },
          ]);
        } else {
          expect(
            hook.result.current.addManualResult({
              scheduledGameId: game.id,
              scores: [score(game.leftTeamId, 300), score(game.rightTeamId!, 100)],
            }),
          ).toBe(true);
        }
      });
      if (round.number === 1 && index === 0) {
        await waitFor(() => expect(hook.result.current.saving).toBe(false));
        const staged = hook.result.current.state.submissions.length;
        hook.unmount();
        hook = renderHook(() => useDirectorController(new IndexedDbDirectorRepository()));
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
        expect(hook.result.current.state.tournament!.id).toBe(tournamentId);
        expect(hook.result.current.state.submissions).toHaveLength(staged);
        expect(hook.result.current.state.submissions[0].status).not.toBe('accepted');
      }
      if (index < 2) {
        const record = hook.result.current.state.games.find((entry) => entry.scheduledGameId === game.id)!;
        const submission = hook.result.current.state.submissions.find(
          (entry) => entry.gameId === record.id && (entry.status === 'received' || entry.status === 'review'),
        )!;
        act(() => {
          expect(hook.result.current.acceptSubmission(submission.id)).toBe(true);
        });
      }
      expect(
        hook.result.current.state.games.filter(
          (entry) => entry.scheduledGameId === game.id && entry.status === 'accepted',
        ),
      ).toHaveLength(1);
    }
    act(() => {
      expect(hook.result.current.finishRound(round.id).finished).toBe(true);
    });
    if (round.number === 5) {
      await waitFor(() => expect(hook.result.current.saving).toBe(false));
      const order = orderDayItems(hook.result.current.state.rounds, hook.result.current.state.timeline).map(
        (item) => item.id,
      );
      hook.unmount();
      hook = renderHook(() => useDirectorController(new IndexedDbDirectorRepository()));
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      expect(
        orderDayItems(hook.result.current.state.rounds, hook.result.current.state.timeline).map(
          (item) => item.id,
        ),
      ).toEqual(order);
      expect(currentOperationalRound(hook.result.current.state)?.number).toBe(6);
      expect(hook.result.current.checkpoints.length).toBeGreaterThanOrEqual(5);
    }
  }
  await waitFor(() => expect(hook.result.current.saving).toBe(false));
  expect(hook.result.current.state.rounds.every((round) => round.status === 'closed')).toBe(true);
  const standings = deriveTeamStandings(hook.result.current.state);
  expect(standings.reduce((total, entry) => total + entry.wins, 0)).toBe(44);
  expect(standings.reduce((total, entry) => total + entry.losses, 0)).toBe(44);
  expect((await repository.load()).rounds.every((round) => round.status === 'closed')).toBe(true);
  hook.unmount();
}, 30000);
