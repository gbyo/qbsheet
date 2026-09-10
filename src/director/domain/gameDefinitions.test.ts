import { describe, expect, test } from 'vitest';
import {
  acceptedGame,
  player,
  playedTournament,
  scheduledGame,
  team,
  tournamentState,
} from '../../../tests/directorFixtures';
import { derivePlayerStandings } from './stats';
import { buildAssignment } from '../transfers/assignment';
import { recordPreparedAssignments } from '../transfers/state';
import {
  activeDefinitionSnapshot,
  canonicalDefinitionJson,
  definitionRulesFor,
  deriveDefinitionSnapshot,
  digestGameDefinition,
  fnv1a64,
  inferLegacyDefinitions,
  issuedRosterFor,
  pinIssuedDefinitions,
  reissueGameDefinition,
  resolveDefinitionSnapshot,
} from './gameDefinitions';

function releasableTournament() {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Ninety Six'), team('team-b', 'Greenwood'));
  state.players.push(player('player-a', 'team-a', 'Gibson'), player('player-b', 'team-b', 'Emma'));
  state.scheduledGames.push(
    scheduledGame('scheduled-1', 'team-a', 'team-b', { status: 'released', roundId: 'round-1' }),
  );
  return state;
}

describe('game definition digests', () => {
  test('fnv1a64 matches the known empty vector', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
  });

  test('canonical JSON is key-order independent and deterministic', () => {
    expect(canonicalDefinitionJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      canonicalDefinitionJson({ a: [2, { c: 3, d: 4 }], b: 1 }),
    );
  });

  test('roster order does not change the digest but values do', () => {
    const state = releasableTournament();
    const rules = state.tournament!.rules;
    const base = {
      rules,
      roundId: 'round-1',
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      leftRoster: issuedRosterFor(state, 'team-a'),
      rightRoster: issuedRosterFor(state, 'team-b'),
    };
    const reordered = {
      ...base,
      leftRoster: [...base.leftRoster].reverse(),
      rightRoster: [...base.rightRoster].reverse(),
    };
    expect(digestGameDefinition(reordered)).toBe(digestGameDefinition(base));
    expect(digestGameDefinition({ ...base, rules: { ...rules, powerValue: 20 } })).not.toBe(
      digestGameDefinition(base),
    );
  });
});

describe('definition pinning', () => {
  test('pinning an unissued game persists revision 1 from current defaults', () => {
    const state = releasableTournament();
    const result = pinIssuedDefinitions(state, ['scheduled-1'], '2026-09-10T00:00:00.000Z');

    expect(result).toEqual({ pinned: ['scheduled-1'], alreadyPinned: [], failed: [] });
    const scheduled = state.scheduledGames[0]!;
    expect(scheduled.definitionRevision).toBe(1);
    expect(scheduled.definitionSnapshotId).toBe(state.gameDefinitions[0]!.id);
    const snapshot = activeDefinitionSnapshot(state, 'scheduled-1')!;
    expect(snapshot.revision).toBe(1);
    expect(snapshot.rules).toEqual(state.tournament!.rules);
    expect(snapshot.digest).toBe(
      digestGameDefinition({
        rules: state.tournament!.rules,
        roundId: 'round-1',
        packetId: null,
        leftTeamId: 'team-a',
        rightTeamId: 'team-b',
        leftRoster: issuedRosterFor(state, 'team-a'),
        rightRoster: issuedRosterFor(state, 'team-b'),
      }),
    );
  });

  test('pinning twice does not duplicate history', () => {
    const state = releasableTournament();
    pinIssuedDefinitions(state, ['scheduled-1']);
    const again = pinIssuedDefinitions(state, ['scheduled-1']);

    expect(again).toEqual({ pinned: [], alreadyPinned: ['scheduled-1'], failed: [] });
    expect(state.gameDefinitions).toHaveLength(1);
  });

  test('issued games build assignments from the snapshot, not live defaults', () => {
    const state = releasableTournament();
    pinIssuedDefinitions(state, ['scheduled-1']);
    state.tournament!.rules.powerValue = 20;

    const built = buildAssignment(state, 'scheduled-1');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const document = built.assignment.document as { objects: Array<Record<string, unknown>> };
    const scoring = document.objects.find((entry) => entry.type === 'ScoringRules')!;
    const powers = (scoring.answer_types as Array<Record<string, unknown>>).filter(
      (entry) => entry.short_label === 'P',
    );
    expect(powers.map((entry) => entry.value)).toEqual([15]);
    expect(definitionRulesFor(state, 'scheduled-1')?.powerValue).toBe(15);
  });

  test('assignments built before the pin stamp the identity the pin will persist', () => {
    const state = releasableTournament();
    // The file path builds its bytes before `recordPreparedAssignments` pins the issue, so an
    // unpinned build stamps the predicted identity. The pin must persist exactly that identity
    // from the unchanged draft, or rooms echoing the file would never classify ready.
    const preview = buildAssignment(state, 'scheduled-1');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const previewMatch = (
      preview.assignment.document as { objects: Array<Record<string, unknown>> }
    ).objects.find((entry) => entry.type === 'Match')!;
    const previewIdentity = previewMatch._qbtcp as Record<string, unknown>;
    expect(previewIdentity.definition_revision).toBe(1);
    expect(typeof previewIdentity.definition_digest).toBe('string');

    pinIssuedDefinitions(state, ['scheduled-1']);
    const snapshot = activeDefinitionSnapshot(state, 'scheduled-1')!;
    expect({
      definition_revision: snapshot.revision,
      definition_digest: snapshot.digest,
    }).toEqual({
      definition_revision: previewIdentity.definition_revision,
      definition_digest: previewIdentity.definition_digest,
    });

    const issued = buildAssignment(state, 'scheduled-1');
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const issuedMatch = (
      issued.assignment.document as { objects: Array<Record<string, unknown>> }
    ).objects.find((entry) => entry.type === 'Match')!;
    expect(issuedMatch._qbtcp).toMatchObject({
      definition_revision: snapshot.revision,
      definition_digest: snapshot.digest,
    });
  });

  test('a game naming a missing snapshot fails closed instead of using live rules', () => {
    const state = releasableTournament();
    pinIssuedDefinitions(state, ['scheduled-1']);
    state.gameDefinitions.length = 0;

    expect(definitionRulesFor(state, 'scheduled-1')).toBeNull();
    expect(resolveDefinitionSnapshot(state, state.scheduledGames[0]!).ok).toBe(false);
    const built = buildAssignment(state, 'scheduled-1');
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.failure.reason).toMatch(/no longer present/i);
  });
});

describe('definition reissue', () => {
  test('reissue after a defaults change creates revision 2 and supersedes revision 1', () => {
    const state = releasableTournament();
    pinIssuedDefinitions(state, ['scheduled-1'], '2026-09-10T00:00:00.000Z');
    state.tournament!.rules.powerValue = 20;

    const result = reissueGameDefinition(state, 'scheduled-1', 'Director', '2026-09-10T01:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.snapshot.revision).toBe(2);
    expect(result.snapshot.rules.powerValue).toBe(20);
    expect(state.gameDefinitions).toHaveLength(2);
    expect(state.gameDefinitions[0]!.supersededById).toBe(result.snapshot.id);
    const scheduled = state.scheduledGames[0]!;
    expect(scheduled.definitionRevision).toBe(2);
    expect(scheduled.definitionSnapshotId).toBe(result.snapshot.id);
    expect(scheduled.assignmentRevision).toBe(2);
    expect(state.audit.at(-1)).toMatchObject({ type: 'definition-reissued' });

    const rebuilt = buildAssignment(state, 'scheduled-1');
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    const document = rebuilt.assignment.document as { objects: Array<Record<string, unknown>> };
    const scoring = document.objects.find((entry) => entry.type === 'ScoringRules')!;
    const powers = (scoring.answer_types as Array<Record<string, unknown>>).filter(
      (entry) => entry.short_label === 'P',
    );
    expect(powers.map((entry) => entry.value)).toEqual([20]);
  });

  test('reissue with unchanged defaults creates no new revision', () => {
    const state = releasableTournament();
    pinIssuedDefinitions(state, ['scheduled-1']);

    const result = reissueGameDefinition(state, 'scheduled-1', 'Director');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.snapshot.revision).toBe(1);
    expect(state.gameDefinitions).toHaveLength(1);
    expect(state.scheduledGames[0]!.assignmentRevision).toBe(1);
  });

  test('reissue is refused while the game has scorer progress', () => {
    const state = releasableTournament();
    pinIssuedDefinitions(state, ['scheduled-1']);
    state.games.push({ ...acceptedGame('game-live', 'scheduled-1', []), status: 'live' });

    const result = reissueGameDefinition(state, 'scheduled-1', 'Director');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/progress|result/i);
    expect(state.gameDefinitions).toHaveLength(1);
  });

  test('a game with existing scorer history is not backdated with a fresh pin', () => {
    const state = playedTournament();
    state.scheduledGames[0]!.status = 'released';

    const pinned = pinIssuedDefinitions(state, ['scheduled-1']);
    expect(pinned.pinned).toEqual([]);
    expect(pinned.failed).toHaveLength(1);
    expect(pinned.failed[0]!.reason).toMatch(/legacy inference/);
    expect(state.gameDefinitions).toHaveLength(0);
    expect(state.scheduledGames[0]!.definitionRevision).toBeUndefined();
  });

  test('recording a completed prepare pins the written games', () => {
    const state = releasableTournament();
    const built = buildAssignment(state, 'scheduled-1');
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    recordPreparedAssignments(state, {
      report: {
        ok: true,
        written: [
          {
            assignment: built.assignment,
            path: 'round-1/room-a.qbj',
            fileName: 'room-a.qbj',
            digest: 'digest-1',
            byteLength: 10,
          },
        ],
        failures: [],
        skipped: [],
        warnings: [],
        rootPath: '/mnt/stick',
        message: 'done',
      },
      transportKind: 'removable-drive',
      destinationLabel: 'USB stick',
    });

    expect(state.scheduledGames[0]!.definitionRevision).toBe(1);
    expect(state.gameDefinitions).toHaveLength(1);
    expect(state.transfers.assignments).toHaveLength(1);
  });

  test('derive refuses games that cannot be issued', () => {
    const state = releasableTournament();
    expect(deriveDefinitionSnapshot(state, 'missing').ok).toBe(false);
    state.scheduledGames.push(scheduledGame('scheduled-bye', 'team-a', 'team-b', { bye: true }));
    expect(deriveDefinitionSnapshot(state, 'scheduled-bye').ok).toBe(false);
  });
});

describe('legacy definition inference', () => {
  test('accepted games without history gain a marked revision-1 snapshot', () => {
    const state = playedTournament();

    expect(inferLegacyDefinitions(state, '2026-09-10T00:00:00.000Z')).toEqual(['scheduled-1']);
    expect(state.gameDefinitions).toHaveLength(1);
    const snapshot = state.gameDefinitions[0]!;
    expect(snapshot.revision).toBe(1);
    expect(snapshot.rules).toEqual(state.tournament!.rules);

    const game = state.games[0]!;
    expect(game.definitionDigest).toBe(snapshot.digest);
    expect(game.definitionRevision).toBe(1);
    expect(game.definitionSource).toBe('legacy-inferred');
    // Never issued: scheduled refs stay absent so a future assignment build fails closed
    // instead of rebuilding from an inference.
    expect(state.scheduledGames[0]!.definitionSnapshotId).toBeUndefined();
    expect(state.scheduledGames[0]!.definitionRevision).toBeUndefined();
  });

  test('games with embedded scoring rules keep resolving from the document', () => {
    const state = playedTournament();
    state.games[0]!.rawQbj = {
      objects: [
        {
          type: 'ScoringRules',
          answer_types: [{ value: 15 }, { value: 10 }, { value: -5 }],
        },
      ],
    };

    expect(inferLegacyDefinitions(state, '2026-09-10T00:00:00.000Z')).toEqual([]);
    expect(state.gameDefinitions).toEqual([]);
    expect(state.games[0]!.definitionDigest).toBeUndefined();
    expect(state.games[0]!.definitionSource).toBeUndefined();
  });

  test('inference is stable across later defaults changes', () => {
    const state = playedTournament();
    inferLegacyDefinitions(state, '2026-09-10T00:00:00.000Z');
    const digest = state.games[0]!.definitionDigest;
    const before = derivePlayerStandings(state);

    state.tournament!.rules.powerValue = 20;
    expect(inferLegacyDefinitions(state, '2026-09-11T00:00:00.000Z')).toEqual([]);
    expect(state.gameDefinitions).toHaveLength(1);
    expect(state.games[0]!.definitionDigest).toBe(digest);
    expect(derivePlayerStandings(state)).toEqual(before);
  });

  test('unplayed games gain no history', () => {
    const state = releasableTournament();

    expect(inferLegacyDefinitions(state, '2026-09-10T00:00:00.000Z')).toEqual([]);
    expect(state.gameDefinitions).toEqual([]);
  });
});
