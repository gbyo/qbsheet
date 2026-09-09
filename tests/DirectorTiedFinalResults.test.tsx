import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { type DirectorState, type TeamGameScore } from '../src/director/domain';
import { MemoryDirectorRepository, type DirectorRepository } from '../src/director/persistence';
import { useDirectorController, type DirectorController } from '../src/director/state/useDirectorController';

const at = '2026-09-05T12:00:00.000Z';
type TwoTeamScheduledGame = DirectorState['scheduledGames'][number] & { rightTeamId: string };

function score(teamId: string, value: number): TeamGameScore {
  return {
    teamId,
    score: value,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
  };
}

async function controllerForTwoTeams() {
  const repository: DirectorRepository = new MemoryDirectorRepository();
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  act(() => {
    hook.result.current.createTournament({
      name: 'Tied final regression',
      date: '2026-09-05',
      venue: 'Test hall',
      organizer: 'QBSheet',
    });
    hook.result.current.addTeam({ displayName: 'Alpha' });
    hook.result.current.addTeam({ displayName: 'Bravo' });
    hook.result.current.addPacket('Packet 1');
  });
  await waitFor(() => expect(hook.result.current.saving).toBe(false));
  act(() => expect(hook.result.current.generateSchedule().generated).toBe(true));
  await waitFor(() => expect(hook.result.current.canLeaveCurrentDocument().ok).toBe(true));
  const scheduled = hook.result.current.state.scheduledGames.find((game) => !game.bye);
  if (!scheduled || !scheduled.rightTeamId) throw new Error('test setup produced no two-team game');
  return { hook, scheduled: scheduled as TwoTeamScheduledGame };
}

function releaseRoundForResults(hook: { result: { current: DirectorController } }, roundId: string): void {
  act(() => {
    expect(hook.result.current.prepareRound(roundId)).toBe(true);
  });
  act(() => {
    expect(hook.result.current.releaseRound(roundId)).toBe(true);
  });
}

function stagedTie(state: DirectorState, scheduledGameId: string): DirectorState {
  const next = structuredClone(state);
  const scheduled = next.scheduledGames.find((game) => game.id === scheduledGameId);
  if (!scheduled || !scheduled.rightTeamId) throw new Error('test setup produced no scheduled opponent');
  const round = next.rounds.find((entry) => entry.id === scheduled.roundId);
  if (!round) throw new Error('test setup produced no scheduled round');
  round.status = 'released';
  round.releasedAt = at;
  next.games.push({
    id: 'imported-tied-game',
    scheduledGameId,
    roundId: scheduled.roundId,
    packetId: scheduled.packetId,
    status: 'submitted',
    scores: [score(scheduled.leftTeamId, 200), score(scheduled.rightTeamId, 200)],
    playerStats: [],
    source: 'qbtcp',
    detailedStats: 'unknown',
    finishedAt: at,
  });
  next.submissions.push({
    id: 'imported-tied-submission',
    gameId: 'imported-tied-game',
    receivedAt: at,
    fingerprint: 'imported-tied',
    status: 'review',
    rawSubmission: { source: 'qbtcp' },
    reason: 'Imported tied final requires review.',
  });
  scheduled.status = 'submitted';
  return next;
}

describe('winner-required result decisions', () => {
  afterEach(() => window.localStorage.removeItem('qbsheet.operatorProfile.v1'));

  test('manual tied final is rejected without creating a game or submission', async () => {
    const { hook, scheduled } = await controllerForTwoTeams();
    releaseRoundForResults(hook, scheduled.roundId);
    const before = structuredClone(hook.result.current.state);

    act(() => {
      expect(
        hook.result.current.addManualResult({
          scheduledGameId: scheduled.id,
          scores: [score(scheduled.leftTeamId, 200), score(scheduled.rightTeamId, 200)],
        }),
      ).toBe(false);
    });

    expect(hook.result.current.state.games).toEqual(before.games);
    expect(hook.result.current.state.submissions).toEqual(before.submissions);
    expect(hook.result.current.state.scheduledGames.find((game) => game.id === scheduled.id)?.status).toBe(
      before.scheduledGames.find((game) => game.id === scheduled.id)?.status,
    );
    expect(hook.result.current.error).toMatch(/winner|overtime|forfeit/i);
  });

  test('a staged imported tied final remains reviewable but cannot be accepted', async () => {
    const { hook, scheduled } = await controllerForTwoTeams();
    const imported = stagedTie(hook.result.current.state, scheduled.id);
    act(() => expect(hook.result.current.importSnapshot(imported)).toBe(true));

    act(() => expect(hook.result.current.acceptSubmission('imported-tied-submission')).toBe(false));

    expect(hook.result.current.state.submissions).toContainEqual(
      expect.objectContaining({ id: 'imported-tied-submission', status: 'review' }),
    );
    expect(hook.result.current.state.games).toContainEqual(
      expect.objectContaining({ id: 'imported-tied-game', status: 'submitted' }),
    );
    expect(hook.result.current.state.scheduledGames).toContainEqual(
      expect.objectContaining({ id: scheduled.id, status: 'submitted' }),
    );
  });

  test('legal ties remain accepted when overtime is disabled', async () => {
    const { hook, scheduled } = await controllerForTwoTeams();
    act(() =>
      expect(hook.result.current.updateRules({ overtime: false, overtimeBonuses: false })).toBe(true),
    );
    releaseRoundForResults(hook, scheduled.roundId);
    act(() => {
      expect(
        hook.result.current.addManualResult({
          scheduledGameId: scheduled.id,
          scores: [score(scheduled.leftTeamId, 200), score(scheduled.rightTeamId, 200)],
        }),
      ).toBe(true);
    });
    const game = hook.result.current.state.games[0];
    if (!game) throw new Error('test setup did not accept a legal tie');
    expect(game.scores).toEqual([score(scheduled.leftTeamId, 200), score(scheduled.rightTeamId, 200)]);
  });

  test('correcting a decisive winner-required result to a tie is rejected atomically', async () => {
    const { hook, scheduled } = await controllerForTwoTeams();
    releaseRoundForResults(hook, scheduled.roundId);
    act(() => {
      expect(
        hook.result.current.addManualResult({
          scheduledGameId: scheduled.id,
          scores: [score(scheduled.leftTeamId, 200), score(scheduled.rightTeamId, 150)],
        }),
      ).toBe(true);
    });
    const game = hook.result.current.state.games[0];
    if (!game) throw new Error('test setup did not accept a decisive result');
    const before = structuredClone(hook.result.current.state);

    act(() =>
      expect(
        hook.result.current.editAcceptedResult(game.id, [
          score(scheduled.leftTeamId, 150),
          score(scheduled.rightTeamId, 150),
        ]),
      ).toBe(false),
    );
    expect(hook.result.current.state.games).toEqual(before.games);
    expect(hook.result.current.state.submissions).toEqual(before.submissions);
    expect(hook.result.current.error).toMatch(/winner|overtime|forfeit/i);
  });
});
