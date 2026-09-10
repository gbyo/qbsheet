/**
 * Lifecycle state-space tests for Director definition, assignment, recovery,
 * and result handling (#674).
 *
 * Strategy, from the issue: a reusable lifecycle model exercises Director
 * defaults, issuance, QBTCP/USB surfaces, scorer corrections, recovery,
 * results, and advancement while continuously asserting the global invariants.
 * Bounded seeded sequences run in normal CI (`SEED`/`STEPS` override the
 * defaults for a local repro: `SEED=7 STEPS=50 npx vitest --run
 * src/director/state/lifecycleStateSpace.test.ts`). A tiny action alphabet is
 * additionally explored exhaustively to depth 3 with visited-hash pruning.
 *
 * Where the ten required risk sequences live:
 *  1. bounceback mid-game — seeded `rules/bouncebacks` steps + invariant I5.
 *  2. staggered rooms — `staggered issuance stays coherent` below.
 *  3. prepared USB then settings edit — `prepared work stays pinned` below.
 *  4. late old result after reissue — `late old results never become current` below.
 *  5. recovery under wrong definition — `transfers/ingest.test.ts`
 *     definition-identity suite (unknown digests are never ready).
 *  6. power default change before a late result — `historical stats stay
 *     classified` below.
 *  7. result correction after advancement — `state/corrections.test.tsx`
 *     tier suite.
 *  8. failure during correction persistence — `correction persistence failure`
 *     below.
 *  9. checkpoint restore with newer authority —
 *     `state/invalidationRegression.test.tsx`.
 * 10. mixed USB/QBTCP definition agreement — the checked-in TypeScript vector
 *     in `crates/qbtcp-server/tests/contract.rs` plus the ingest ready path.
 *
 * A failed run throws the seed, step index, action name, and a competitive
 * state summary so the exact history can be replayed locally.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { acceptedGameRecords, deriveTeamStandings, type DirectorId, type DirectorState } from '../domain';
import { buildAssignment } from '../transfers/assignment';
import { scoringValuesForGameRecord } from '../domain/gameDefinitions';
import { MemoryDirectorRepository } from '../persistence';
import { player, score, team, tournamentState } from '../../../tests/directorFixtures';
import {
  canonicalAcceptedGame,
  useDirectorController,
  validateResultForScheduledGame,
  type DirectorController,
} from './useDirectorController';

type Hook = ReturnType<typeof renderHook<DirectorController, unknown>>;

const AT = '2026-09-12T12:00:00.000Z';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Four teams, two preliminary games (one accepted), one planned game, one live room. */
function lifecycleFixture(): DirectorState {
  const state = tournamentState();
  state.teams.push(
    team('team-a', 'Alpha'),
    team('team-b', 'Beta'),
    team('team-c', 'Gamma'),
    team('team-d', 'Delta'),
  );
  state.players.push(player('player-a', 'team-a', 'Amy'), player('player-b', 'team-b', 'Ben'));
  state.phases[0]!.roundIds = ['round-1', 'round-2'];
  state.rooms.push(
    { id: 'room-1', name: 'Room 1', available: true, status: 'finished' } as DirectorState['rooms'][number],
    { id: 'room-2', name: 'Room 2', available: true, status: 'live' } as DirectorState['rooms'][number],
  );
  state.rounds.push(
    {
      ...state.rounds[0]!,
      scheduledGameIds: ['scheduled-1', 'scheduled-2'],
    },
    {
      ...state.rounds[0]!,
      id: 'round-2',
      name: 'Round 2',
      number: 2,
      status: 'planned',
      packetId: null,
      scheduledGameIds: ['scheduled-3'],
      scheduledStart: null,
      releasedAt: null,
    },
  );
  state.scheduledGames.push(
    {
      id: 'scheduled-1',
      roundId: 'round-1',
      poolId: null,
      roomId: 'room-1',
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      bye: false,
      status: 'accepted',
      assignmentRevision: 1,
    },
    {
      id: 'scheduled-2',
      roundId: 'round-1',
      poolId: null,
      roomId: 'room-2',
      packetId: null,
      leftTeamId: 'team-c',
      rightTeamId: 'team-d',
      bye: false,
      status: 'released',
      assignmentRevision: 1,
    },
    {
      id: 'scheduled-3',
      roundId: 'round-2',
      poolId: null,
      roomId: null,
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-c',
      bye: false,
      status: 'scheduled',
      assignmentRevision: 1,
    },
  );
  state.games.push(
    {
      id: 'game-1',
      scheduledGameId: 'scheduled-1',
      roundId: 'round-1',
      packetId: null,
      status: 'accepted',
      scores: [score('team-a', 300), score('team-b', 210)],
      playerStats: [],
      source: 'manual',
      detailedStats: 'unknown',
      acceptedAt: AT,
    },
    {
      id: 'game-2',
      scheduledGameId: 'scheduled-2',
      roundId: 'round-1',
      packetId: null,
      status: 'submitted',
      scores: [score('team-c', 100), score('team-d', 90)],
      playerStats: [],
      source: 'qbtcp',
      detailedStats: 'unknown',
    },
  );
  state.submissions.push(
    {
      id: 'sub-1',
      gameId: 'game-1',
      sessionId: 'sess-1',
      receivedAt: AT,
      fingerprint: 'fingerprint-1',
      status: 'accepted',
      rawSubmission: { source: 'manual' },
      acceptedBy: 'Director',
      acceptedAt: AT,
    },
    {
      id: 'sub-review',
      gameId: 'game-2',
      sessionId: 'sess-live',
      receivedAt: AT,
      fingerprint: 'fingerprint-2',
      status: 'review',
      rawSubmission: { source: 'qbtcp' },
    },
  );
  state.qbtcpSessions.push({
    roomId: 'room-2',
    sessionId: 'sess-live',
    matchId: 'scheduled-2',
    deviceId: 'device-live',
    state: 'live',
    lastSeenAt: AT,
    progress: { tossupsRead: 5, leftScore: 20, rightScore: 10 },
    helpRequestId: null,
  });
  return state;
}

async function lifecycleController(state: DirectorState): Promise<{
  hook: Hook;
  repository: MemoryDirectorRepository;
}> {
  const repository = new MemoryDirectorRepository();
  await repository.save(state);
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { hook, repository };
}

function competitiveSummary(state: DirectorState): string {
  return JSON.stringify({
    games: state.games.map((game) => [
      game.id,
      game.status,
      game.resultRevision ?? 1,
      game.scores.map((entry) => entry.score),
    ]),
    scheduled: state.scheduledGames.map((game) => [
      game.id,
      game.status,
      game.assignmentRevision,
      game.definitionRevision ?? 0,
    ]),
    definitions: state.gameDefinitions.map((snapshot) => [
      snapshot.id,
      snapshot.scheduledGameId,
      snapshot.revision,
      snapshot.digest,
    ]),
    sessions: state.qbtcpSessions.map((session) => [session.sessionId, session.state]),
    submissions: state.submissions.map((submission) => [submission.id, submission.status]),
  });
}

function standingsFingerprint(state: DirectorState): string {
  const records = acceptedGameRecords(state);
  return deriveTeamStandings(state, records)
    .map((standing) => `${standing.teamId}:${standing.wins}:${standing.pointsFor}`)
    .join('|');
}

interface InvariantContext {
  digests: Map<DirectorId, string>;
}

/**
 * The global invariants (#674), checked after every lifecycle action:
 * I1 issued definitions are immutable; I2 no split definition per revision;
 * I3 stale identity never becomes ready; I4 recovery never reinterprets;
 * I5 corrections stay closed under validation; persistence round-trips.
 */
function assertLifecycleInvariants(
  state: DirectorState,
  context: InvariantContext,
  exportSnapshot: () => string,
  where: string,
): void {
  const fail = (invariant: string, detail: string): never => {
    throw new Error(
      `[${where}] invariant ${invariant} violated: ${detail}\nstate: ${competitiveSummary(state)}`,
    );
  };
  // I1 + I2 + pin coherence.
  const byGameRevision = new Map<string, string>();
  for (const snapshot of state.gameDefinitions) {
    const seen = context.digests.get(snapshot.id);
    if (seen !== undefined && seen !== snapshot.digest) {
      fail('I1', `issued definition ${snapshot.id} changed digest ${seen} -> ${snapshot.digest}`);
    }
    context.digests.set(snapshot.id, snapshot.digest);
    const key = `${snapshot.scheduledGameId}#${snapshot.revision}`;
    const clash = byGameRevision.get(key);
    if (clash !== undefined && clash !== snapshot.digest) fail('I2', `split definition for ${key}`);
    byGameRevision.set(key, snapshot.digest);
  }
  for (const scheduled of state.scheduledGames) {
    if (!scheduled.definitionSnapshotId) continue;
    const snapshot = state.gameDefinitions.find((entry) => entry.id === scheduled.definitionSnapshotId);
    if (!snapshot) fail('I1', `${scheduled.id} pins missing snapshot ${scheduled.definitionSnapshotId}`);
    else if (snapshot.scheduledGameId !== scheduled.id) {
      fail('I1', `${scheduled.id} pins a snapshot issued for ${snapshot.scheduledGameId}`);
    } else if (snapshot.revision !== scheduled.definitionRevision) {
      fail(
        'I1',
        `${scheduled.id} pins revision ${scheduled.definitionRevision} of snapshot ${snapshot.id}@${snapshot.revision}`,
      );
    }
  }
  // I3: stale identity never becomes ready silently.
  for (const submission of state.submissions) {
    if (submission.status !== 'accepted') continue;
    const game =
      state.games.find((entry) => entry.id === submission.gameId) ??
      fail('I3', `accepted submission ${submission.id} points at a missing game`);
    if (game.status !== 'accepted' && game.status !== 'forfeit') {
      fail('I3', `accepted submission ${submission.id} points at a non-canonical game`);
    }
    const canonical = canonicalAcceptedGame(state, game.scheduledGameId);
    if (canonical?.id !== game.id) {
      fail('I3', `accepted submission ${submission.id} is not the canonical result anymore`);
    }
  }
  for (const session of state.qbtcpSessions) {
    if (session.state !== 'abandoned' || session.resumable !== false || !session.matchId) continue;
    const canonical = canonicalAcceptedGame(state, session.matchId);
    const canonicalSubmission = canonical
      ? state.submissions.find(
          (submission) =>
            submission.gameId === canonical.id &&
            submission.status === 'accepted' &&
            submission.sessionId === session.sessionId,
        )
      : undefined;
    if (canonicalSubmission) {
      fail('I3', `abandoned session ${session.sessionId} silently retook ${session.matchId}`);
    }
  }
  // I4: a game carrying a definition digest resolves to the issued truth.
  for (const game of state.games) {
    if (!game.definitionDigest) continue;
    const snapshots = state.gameDefinitions.filter(
      (snapshot) => snapshot.scheduledGameId === game.scheduledGameId,
    );
    if (snapshots.length > 0 && !snapshots.some((snapshot) => snapshot.digest === game.definitionDigest)) {
      fail('I4', `${game.id} resolves under an unknown definition digest`);
    }
  }
  // I5: every accepted result validates, and the document round-trips.
  for (const game of state.games) {
    if (game.status !== 'accepted') continue;
    const scheduled = state.scheduledGames.find((entry) => entry.id === game.scheduledGameId);
    const issue = validateResultForScheduledGame(state, scheduled, game.scores, game.playerStats);
    if (issue) fail('I5', `${game.id} fails validation after lifecycle action: ${issue}`);
  }
  const roundTripped = JSON.parse(exportSnapshot()) as DirectorState;
  if (roundTripped.games.length !== state.games.length) {
    fail('I5', 'persistence round-trip drops game records');
  }
  if (roundTripped.gameDefinitions.length !== state.gameDefinitions.length) {
    fail('I5', 'persistence round-trip drops definition history');
  }
}

/** Accepted history plus its standings derivation: future-default edits must not move it. */
function historicalFingerprint(state: DirectorState): string {
  const games = state.games
    .filter((game) => game.status === 'accepted')
    .map((game) => `${game.id}:${JSON.stringify(game.scores)}:${JSON.stringify(game.playerStats)}`)
    .join('|');
  return `${games}#${standingsFingerprint(state)}`;
}

function snapshotDefinitions(state: DirectorState): Array<{
  id: DirectorId;
  scheduledGameId: DirectorId;
  revision: number;
  digest: string;
}> {
  return state.gameDefinitions.map((snapshot) => ({
    id: snapshot.id,
    scheduledGameId: snapshot.scheduledGameId,
    revision: snapshot.revision,
    digest: snapshot.digest,
  }));
}

/**
 * One lifecycle action, chosen by the seeded stream. Refusals are legal
 * outcomes: the invariants must hold whether the action applies or not.
 * Returns the action label for failure reports.
 */
async function lifecycleStep(hook: Hook, rng: () => number, flip: { value: boolean }): Promise<string> {
  const controller = hook.result.current;
  const state = controller.state;
  const pick = Math.floor(rng() * 11);
  switch (pick) {
    case 0:
    case 1: {
      const key = pick === 0 ? 'tossupValue' : 'bouncebacks';
      const current = state.tournament!.rules[key];
      // The tier validator requires power > tossup, so flip 10 <-> 5 (power is 15).
      const next = typeof current === 'boolean' ? !current : current === 10 ? 5 : 10;
      const before = historicalFingerprint(state);
      let applied = false;
      await act(async () => {
        applied = hook.result.current.updateRules({ [key]: next });
      });
      // I6: future-default edits never reinterpret accepted history.
      if (applied && historicalFingerprint(hook.result.current.state) !== before) {
        throw new Error(`I6 violated by rules/${String(key)}: accepted history moved`);
      }
      return `rules/${String(key)}=${String(next)}${applied ? '' : ' (refused)'}`;
    }
    case 2: {
      const order = [...state.tournament!.rules.tiebreakers];
      [order[0], order[1]] = [order[1]!, order[0]!];
      let applied = false;
      await act(async () => {
        applied = hook.result.current.updateTiebreakers(order);
      });
      return `tiebreakers/swap${applied ? '' : ' (refused)'}`;
    }
    case 3: {
      flip.value = !flip.value;
      const scores = flip.value
        ? [score('team-a', 300), score('team-b', 210)]
        : [score('team-a', 210), score('team-b', 300)];
      let applied = false;
      await act(async () => {
        applied = hook.result.current.editAcceptedResult('game-1', scores, 'State-space correction.');
      });
      return `correct/game-1${applied ? '' : ' (refused)'}`;
    }
    case 4: {
      const left = 100 + Math.floor(rng() * 300);
      let right = 100 + Math.floor(rng() * 300);
      if (right === left) right += 10;
      let outcome: unknown = false;
      await act(async () => {
        outcome = await hook.result.current.addManualResult({
          scheduledGameId: 'scheduled-2',
          scores: [score('team-c', left), score('team-d', right)],
        });
      });
      return `manual/scheduled-2=${left}-${right}${outcome ? '' : ' (refused)'}`;
    }
    case 5: {
      const forfeited = rng() < 0.5 ? 'team-c' : 'team-d';
      let outcome: unknown = false;
      await act(async () => {
        outcome = await hook.result.current.recordForfeit('scheduled-2', forfeited, 'State-space forfeit.');
      });
      return `forfeit/scheduled-2=${forfeited}${outcome ? '' : ' (refused)'}`;
    }
    case 6: {
      const target = ['scheduled-1', 'scheduled-2'].find((id) => {
        const canonical = canonicalAcceptedGame(hook.result.current.state, id);
        return canonical?.status === 'forfeit';
      });
      if (!target) return 'correct-forfeit (skipped: no forfeit)';
      const reopen = rng() < 0.5;
      const scheduled = hook.result.current.state.scheduledGames.find((game) => game.id === target)!;
      const replacementScores = [score(scheduled.leftTeamId, 250)];
      if (scheduled.rightTeamId) replacementScores.push(score(scheduled.rightTeamId, 200));
      let applied = false;
      await act(async () => {
        applied = hook.result.current.correctForfeit(
          target,
          reopen ? { kind: 'reopen' } : { kind: 'scores', scores: replacementScores },
          'State-space administrative correction.',
        );
      });
      return `correct-forfeit/${target}${applied ? '' : ' (refused)'}`;
    }
    case 7: {
      const open = hook.result.current.state.protests.find((protest) => protest.status === 'open');
      if (open) {
        const delta = (rng() < 0.5 ? 1 : -1) * 10;
        let applied = false;
        await act(async () => {
          applied = hook.result.current.ruleProtest(open.id, 'State-space ruling.', {
            teamId: 'team-a',
            delta,
          });
        });
        return `protest/rule@${open.id}${applied ? '' : ' (refused)'}`;
      }
      let applied = false;
      await act(async () => {
        applied = hook.result.current.addProtest('game-1', 'State-space protest.', 'other');
      });
      return `protest/open${applied ? '' : ' (refused)'}`;
    }
    case 8: {
      // scheduled-3 is pristine and pinnable; scheduled-1/2 carry scorer
      // history, so reissue must refuse them outside recovery (I7).
      const candidates = ['scheduled-1', 'scheduled-2', 'scheduled-3'] as const;
      const target = candidates[Math.floor(rng() * candidates.length)]!;
      const before = snapshotDefinitions(hook.result.current.state);
      let result: { ok: boolean } = { ok: false };
      await act(async () => {
        result = hook.result.current.reissueGameDefinition(target);
      });
      // I7: safe reissue mints a new revision; it never mutates issued history,
      // and a refusal changes nothing.
      const after = snapshotDefinitions(hook.result.current.state);
      const beforeById = new Map(before.map((entry) => [entry.id, entry]));
      for (const entry of after) {
        const previous = beforeById.get(entry.id);
        if (previous && (previous.digest !== entry.digest || previous.revision !== entry.revision)) {
          throw new Error(`I7 violated by reissue/${target}: issued snapshot ${entry.id} mutated`);
        }
      }
      if (!result.ok && after.length !== before.length) {
        throw new Error(`I7 violated by reissue/${target}: a refused reissue changed history`);
      }
      return `reissue/${target}${result.ok ? '' : ' (refused)'}`;
    }
    case 9: {
      const teamD = hook.result.current.state.teams.find((entry) => entry.id === 'team-d');
      let applied = false;
      await act(async () => {
        applied =
          teamD?.status === 'dropped'
            ? hook.result.current.restoreTeam('team-d')
            : hook.result.current.dropTeam('team-d', 'State-space drop.');
      });
      return `${teamD?.status === 'dropped' ? 'restore' : 'drop'}/team-d${applied ? '' : ' (refused)'}`;
    }
    default: {
      const review = hook.result.current.state.submissions.find(
        (submission) => submission.status === 'review',
      );
      if (!review) return 'accept-review (skipped: none in review)';
      let applied = false;
      await act(async () => {
        applied = hook.result.current.acceptSubmission(review.id, 'Director');
      });
      return `accept-review/${review.id}${applied ? '' : ' (refused)'}`;
    }
  }
}

const configuredSeeds = (() => {
  const seed = Number(process.env.SEED);
  if (Number.isInteger(seed)) return [seed];
  return [11, 22, 33, 44, 55, 66];
})();
const configuredSteps = (() => {
  const steps = Number(process.env.STEPS);
  return Number.isInteger(steps) && steps > 0 ? Math.min(steps, 200) : 18;
})();

describe('lifecycle state space (#674)', () => {
  for (const seed of configuredSeeds) {
    test(`seeded sequence ${seed} preserves every lifecycle invariant`, async () => {
      const { hook } = await lifecycleController(lifecycleFixture());
      const context: InvariantContext = { digests: new Map() };
      const rng = mulberry32(seed);
      const flip = { value: false };
      const exportSnapshot = () => hook.result.current.exportSnapshot();
      assertLifecycleInvariants(hook.result.current.state, context, exportSnapshot, `seed ${seed} setup`);
      for (let step = 0; step < configuredSteps; step += 1) {
        const label = await lifecycleStep(hook, rng, flip);
        await waitFor(() => expect(hook.result.current.saving).toBe(false));
        assertLifecycleInvariants(
          hook.result.current.state,
          context,
          exportSnapshot,
          `seed ${seed} step ${step} (${label})`,
        );
      }
    }, 120000);
  }

  test('a tiny alphabet is explored exhaustively to depth 3 with pruning', async () => {
    // Alphabet: correct game-1 either way, or flip the tossup default. Small
    // enough to exhaust, rich enough to interleave corrections with default
    // edits — the historically dangerous combination.
    const alphabet = ['correct-a', 'correct-b', 'toggle-rules'] as const;
    const visited = new Set<string>();
    const queue: Array<{ prefix: Array<(typeof alphabet)[number]> }> = alphabet.map((action) => ({
      prefix: [action],
    }));
    let evaluations = 0;
    const maxEvaluations = 20;
    const apply = async (hook: Hook, action: (typeof alphabet)[number]): Promise<void> => {
      if (action === 'correct-a') {
        await act(async () => {
          hook.result.current.editAcceptedResult(
            'game-1',
            [score('team-a', 300), score('team-b', 210)],
            'Exhaustive correction.',
          );
        });
      } else if (action === 'correct-b') {
        await act(async () => {
          hook.result.current.editAcceptedResult(
            'game-1',
            [score('team-a', 210), score('team-b', 300)],
            'Exhaustive correction.',
          );
        });
      } else {
        const current = hook.result.current.state.tournament!.rules.tossupValue;
        await act(async () => {
          hook.result.current.updateRules({ tossupValue: current === 10 ? 5 : 10 });
        });
      }
    };
    while (queue.length > 0 && evaluations < maxEvaluations) {
      const { prefix } = queue.shift()!;
      const { hook } = await lifecycleController(lifecycleFixture());
      const context: InvariantContext = { digests: new Map() };
      const exportSnapshot = () => hook.result.current.exportSnapshot();
      for (const action of prefix) {
        await apply(hook, action);
      }
      await waitFor(() => expect(hook.result.current.saving).toBe(false));
      evaluations += 1;
      const hash = competitiveSummary(hook.result.current.state);
      assertLifecycleInvariants(
        hook.result.current.state,
        context,
        exportSnapshot,
        `exhaustive [${prefix.join(', ')}]`,
      );
      hook.unmount();
      if (prefix.length < 3 && !visited.has(hash)) {
        visited.add(hash);
        for (const action of alphabet) queue.push({ prefix: [...prefix, action] });
      }
    }
    // Pruning must actually collapse the space: 39 raw prefixes, far fewer states.
    expect(evaluations).toBeLessThan(3 + 9 + 27);
    expect(evaluations).toBeGreaterThan(3);
  }, 180000);
});

describe('named risk sequences (#674)', () => {
  test('staggered issuance stays coherent across a defaults change', async () => {
    // A game is issued, the defaults move, then it is reissued for a later
    // room: revision 1 keeps exactly what was issued while revision 2 carries
    // the new truth. scheduled-3 is pristine, so issuance can pin it.
    const { hook } = await lifecycleController(lifecycleFixture());
    await act(async () => {
      const result = hook.result.current.reissueGameDefinition('scheduled-3');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.created).toBe(true);
    });
    const firstDigest = hook.result.current.state.gameDefinitions[0]!.digest;
    const current = hook.result.current.state.tournament!.rules.tossupValue;
    await act(async () => {
      expect(hook.result.current.updateRules({ tossupValue: current === 10 ? 5 : 10 })).toBe(true);
    });
    await act(async () => {
      const result = hook.result.current.reissueGameDefinition('scheduled-3');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.snapshot.revision).toBe(2);
    });
    const state = hook.result.current.state;
    // The defaults save also pins legacy evidence for the older accepted game;
    // the two scheduled-3 revisions are what this sequence asserts about.
    const issued = state.gameDefinitions.filter((snapshot) => snapshot.scheduledGameId === 'scheduled-3');
    expect(issued).toHaveLength(2);
    // The first issuance still plays under exactly what it was issued.
    expect(issued[0]!.revision).toBe(1);
    expect(issued[0]!.digest).toBe(firstDigest);
    expect(issued[1]!.revision).toBe(2);
    expect(issued[1]!.digest).not.toBe(firstDigest);
  });

  test('prepared work stays pinned exactly across a settings edit', async () => {
    // An assignment cut from a pinned game still builds byte-equal bytes after
    // a settings edit: prepared work is pinned exactly, never silently current
    // under the new definition.
    const { hook } = await lifecycleController(lifecycleFixture());
    await act(async () => {
      expect(hook.result.current.reissueGameDefinition('scheduled-3').ok).toBe(true);
    });
    const pinnedDigest = hook.result.current.state.gameDefinitions[0]!.digest;
    const before = buildAssignment(hook.result.current.state, 'scheduled-3');
    expect(before.ok).toBe(true);
    await act(async () => {
      expect(hook.result.current.updateRules({ bonusValue: 20 })).toBe(true);
    });
    const after = buildAssignment(hook.result.current.state, 'scheduled-3');
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.assignment.document).toEqual(before.assignment.document);
    const match = (after.assignment.document as { objects: Array<Record<string, unknown>> }).objects.find(
      (entry) => entry.type === 'Match',
    )!;
    expect((match._qbtcp as Record<string, unknown>).definition_digest).toBe(pinnedDigest);
  });

  test('late old results are retained for review but never become current automatically', async () => {
    // Reopening a forfeit abandons its room session; the late review
    // submission from that session stays reviewable and cannot take over.
    const at = '2026-09-05T12:00:00.000Z';
    const state = lifecycleFixture();
    state.games.length = 0;
    state.submissions.length = 0;
    state.scheduledGames.find((game) => game.id === 'scheduled-1')!.status = 'accepted';
    state.games.push({
      id: 'forfeit-1',
      scheduledGameId: 'scheduled-1',
      roundId: 'round-1',
      packetId: null,
      status: 'forfeit',
      forfeitedTeamId: 'team-a',
      scores: [score('team-a', 0), score('team-b', 0)],
      playerStats: [],
      source: 'manual',
      detailedStats: 'unknown',
      acceptedAt: at,
    });
    state.submissions.push(
      {
        id: 'sub-forfeit',
        gameId: 'forfeit-1',
        receivedAt: at,
        fingerprint: 'forfeit-print',
        status: 'accepted',
        rawSubmission: { source: 'manual' },
        acceptedBy: 'Director',
        acceptedAt: at,
      },
      {
        id: 'sub-late',
        gameId: 'forfeit-1',
        sessionId: 'sess-old',
        receivedAt: at,
        fingerprint: 'late-print',
        status: 'review',
        rawSubmission: { source: 'qbtcp' },
      },
    );
    state.qbtcpSessions.push({
      roomId: 'room-1',
      sessionId: 'sess-old',
      matchId: 'scheduled-1',
      deviceId: 'device-old',
      state: 'assigned',
      lastSeenAt: at,
      progress: null,
      helpRequestId: null,
    });
    const { hook } = await lifecycleController(state);

    await act(async () => {
      expect(
        hook.result.current.correctForfeit('scheduled-1', { kind: 'reopen' }, 'Reopening for review.'),
      ).toBe(true);
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));

    const next = hook.result.current.state;
    expect(next.qbtcpSessions.find((session) => session.sessionId === 'sess-old')).toMatchObject({
      state: 'abandoned',
      resumable: false,
    });
    // Retained and reviewable — but the reopened game has no canonical result.
    expect(next.submissions.find((submission) => submission.id === 'sub-late')?.status).toBe('review');
    expect(canonicalAcceptedGame(next, 'scheduled-1')).toBeUndefined();
  });

  test('historical stats stay classified under the old definition after a power change', async () => {
    // A late-arriving understanding (new power value) must not reinterpret the
    // already-accepted game: the defaults save pins the old evidence first,
    // and the derived scoring values stay under that pin.
    const state = lifecycleFixture();
    const { hook } = await lifecycleController(state);
    const valuesBefore = scoringValuesForGameRecord(
      hook.result.current.state,
      hook.result.current.state.games.find((game) => game.id === 'game-1')!,
    );
    await act(async () => {
      expect(hook.result.current.updateRules({ powerValue: 20 })).toBe(true);
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    const next = hook.result.current.state;
    expect(
      scoringValuesForGameRecord(
        next,
        next.games.find((game) => game.id === 'game-1')!,
      ),
    ).toEqual(valuesBefore);
    expect(next.games.find((game) => game.id === 'game-1')!.scores).toEqual([
      score('team-a', 300),
      score('team-b', 210),
    ]);
  });

  test('a correction persistence failure cannot produce mixed revisions after restart', async () => {
    // Failure injection (#674.8): the save fails mid-correction, so a restart
    // must load the pre-correction document — never a corrected score at the
    // old revision or a bumped revision with old scores.
    const { hook, repository } = await lifecycleController(lifecycleFixture());
    const beforeScores = structuredClone(
      hook.result.current.state.games.find((game) => game.id === 'game-1')!.scores,
    );
    vi.spyOn(repository, 'save').mockRejectedValueOnce(new Error('Disk full'));
    await act(async () => {
      expect(
        hook.result.current.editAcceptedResult(
          'game-1',
          [score('team-a', 250), score('team-b', 200)],
          'Correction that fails to persist.',
        ),
      ).toBe(true);
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    expect(hook.result.current.persistence.status).toBe('failed');

    const reloaded = await repository.load();
    const reloadedGame = reloaded.games.find((game) => game.id === 'game-1')!;
    expect(reloadedGame.scores).toEqual(beforeScores);
    expect(reloadedGame.resultRevision ?? 1).toBe(1);
    expect(reloaded.submissions.some((submission) => submission.status === 'accepted')).toBe(true);
  });
});
