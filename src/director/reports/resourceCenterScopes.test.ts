/**
 * Multi-phase Resource Center export scopes (issue #763).
 *
 * Covers the test matrix: single-stage (no chooser), prelims->playoffs,
 * prelim pools->playoff pools, tiebreaker/finals/placement, dropped teams,
 * cancelled/replayed/corrected games, carryover vs no-carryover, mixed
 * scoring definitions, multi-phase team presence, and combined uniqueness.
 */

import { describe, expect, test } from 'vitest';
import { unzipSync } from 'fflate';
import { acceptedGameRecords, type DirectorState, type Phase } from '../domain';
import {
  acceptedGame,
  playedTournament,
  player,
  scheduledGame,
  score,
  team,
} from '../../../tests/directorFixtures';
import {
  buildCanonicalResourceCenterScopeArtifact,
  buildCanonicalResourceCenterScopeSets,
  resourceCenterPresetScopeKeys,
  resourceCenterRecommendedScopeKeys,
  resourceCenterScopes,
} from './resourceCenterScopes';

const generatedAt = '2026-09-10T12:00:00.000Z';

function addPhase(
  state: DirectorState,
  id: string,
  name: string,
  order: number,
  overrides: Partial<Phase> = {},
): Phase {
  const phase: Phase = {
    id,
    name,
    kind: 'playoff',
    order,
    formatId: 'format-1',
    poolIds: [],
    roundIds: [],
    advancementRule: null,
    carryover: false,
    status: 'active',
    ...overrides,
  };
  state.phases.push(phase);
  return phase;
}

function addRound(
  state: DirectorState,
  id: string,
  phaseId: string,
  name: string,
  number: number,
  packetId: string | null = null,
): void {
  state.rounds.push({
    id,
    phaseId,
    name,
    number,
    revision: 1,
    status: 'closed',
    packetId,
    scheduledGameIds: [],
    scheduledStart: null,
    releasedAt: null,
    startedAt: null,
    closedAt: generatedAt,
  });
  const phase = state.phases.find((entry) => entry.id === phaseId);
  if (phase && !phase.roundIds.includes(id)) phase.roundIds.push(id);
}

function addAcceptedGame(
  state: DirectorState,
  gameId: string,
  scheduledId: string,
  roundId: string,
  leftTeamId: string,
  rightTeamId: string,
  leftPoints: number,
  rightPoints: number,
  options: {
    poolId?: string | null;
    packetId?: string | null;
    status?: 'accepted' | 'forfeit';
    forfeitedTeamId?: string;
    acceptedAt?: string;
  } = {},
): void {
  state.scheduledGames.push(
    scheduledGame(scheduledId, leftTeamId, rightTeamId, {
      roundId,
      poolId: options.poolId ?? null,
      packetId: options.packetId ?? null,
    }),
  );
  const game = acceptedGame(gameId, scheduledId, [
    score(leftTeamId, leftPoints),
    score(rightTeamId, rightPoints),
  ]);
  game.roundId = roundId;
  game.packetId = options.packetId ?? null;
  if (options.status) game.status = options.status;
  if (options.forfeitedTeamId) game.forfeitedTeamId = options.forfeitedTeamId;
  if (options.acceptedAt) game.acceptedAt = options.acceptedAt;
  state.games.push(game);
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (round) round.scheduledGameIds.push(scheduledId);
}

function prelimPlayoffTournament(): DirectorState {
  const state = playedTournament();
  state.phases[0]!.name = 'Prelims';
  state.teams.push(team('team-c', 'Dorman'), team('team-d', 'Spartanburg'));
  state.players.push(player('player-c', 'team-c', 'Cal'), player('player-d', 'team-d', 'Dee'));
  const playoffs = addPhase(state, 'phase-2', 'Playoffs', 2, { teamIds: ['team-a', 'team-c'] });
  addRound(state, 'round-2', playoffs.id, 'Round 2', 2);
  addAcceptedGame(state, 'game-2', 'scheduled-2', 'round-2', 'team-a', 'team-c', 260, 240);
  return state;
}

function fileOf(artifact: { files: Array<{ kind: string; content: string }> }, kind: string): string {
  return artifact.files.find((file) => file.kind === kind)!.content;
}

describe('resource center scope enumeration', () => {
  test('single-stage tournament exposes only the combined scope', () => {
    const scopes = resourceCenterScopes(playedTournament());
    expect(scopes.map((scope) => scope.key)).toEqual(['combined']);
    expect(scopes[0]).toMatchObject({ label: 'Overall', gameCount: 1 });
    expect(scopes[0]!.baseName).toBe('Ninety-Six-Invitational');
  });

  test('prelims plus playoffs enumerate each phase plus combined in order', () => {
    const scopes = resourceCenterScopes(prelimPlayoffTournament());
    expect(scopes.map((scope) => scope.key)).toEqual(['phase:phase-1', 'phase:phase-2', 'combined']);
    expect(scopes.map((scope) => scope.label)).toEqual(['Prelims', 'Playoffs', 'Combined']);
    expect(scopes.map((scope) => scope.detail)).toEqual([
      '2 teams · 1 game · 1 round',
      '2 teams · 1 game · 1 round',
      '3 teams · 2 games · 2 rounds',
    ]);
    // User-facing names never depend on raw internal IDs.
    for (const scope of scopes) {
      expect(scope.label).not.toContain('phase-1');
      expect(scope.label).not.toContain('phase-2');
      expect(scope.baseName).not.toContain('phase-1');
      expect(scope.baseName).not.toContain('phase-2');
    }
  });

  test('scopes derive from explicit phase IDs, not round numbers', () => {
    const state = prelimPlayoffTournament();
    // Swap round numbers so a contiguous-number heuristic would misattribute
    // games; explicit phase IDs must still win.
    state.rounds.find((round) => round.id === 'round-1')!.number = 99;
    state.rounds.find((round) => round.id === 'round-2')!.number = 1;
    const prelims = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-1', generatedAt);
    const playoffs = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-2', generatedAt);
    expect(prelims.gameCount).toBe(1);
    expect(playoffs.gameCount).toBe(1);
    expect(fileOf(prelims, 'scoreboard')).toContain('Ninety Six');
    expect(fileOf(playoffs, 'scoreboard')).toContain('Dorman');
  });

  test('presets match the HSQuizbowl preparation workflow', () => {
    const state = prelimPlayoffTournament();
    expect(resourceCenterRecommendedScopeKeys(state)).toEqual(['phase:phase-1', 'phase:phase-2', 'combined']);
    expect(resourceCenterPresetScopeKeys(state, 'recommended')).toEqual([
      'phase:phase-1',
      'phase:phase-2',
      'combined',
    ]);
    expect(resourceCenterPresetScopeKeys(state, 'phases-only')).toEqual(['phase:phase-1', 'phase:phase-2']);
    expect(resourceCenterPresetScopeKeys(state, 'combined-only')).toEqual(['combined']);
    // Single-stage tournaments collapse every preset to the one scope.
    const single = playedTournament();
    expect(resourceCenterRecommendedScopeKeys(single)).toEqual(['combined']);
    expect(resourceCenterPresetScopeKeys(single, 'phases-only')).toEqual(['combined']);
  });
});

describe('resource center per-phase and combined sets', () => {
  test('each accepted game appears exactly where intended; combined never double-counts', () => {
    const state = prelimPlayoffTournament();
    const prelims = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-1', generatedAt);
    const playoffs = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-2', generatedAt);
    const combined = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
    expect(prelims.gameCount).toBe(1);
    expect(playoffs.gameCount).toBe(1);
    expect(combined.gameCount).toBe(2);
    expect(combined.gameCount).toBe(acceptedGameRecords(state).length);
    // Same team in multiple phases appears in both phase sets (team anchors
    // avoid colliding with the tournament title).
    expect(fileOf(prelims, 'standings')).toContain('team-team-a');
    expect(fileOf(playoffs, 'standings')).toContain('team-team-a');
    // Teams that do not advance absent themselves from the later phase.
    expect(fileOf(prelims, 'standings')).toContain('team-team-b');
    expect(fileOf(playoffs, 'standings')).not.toContain('team-team-b');
    expect(fileOf(combined, 'standings')).toContain('team-team-b');
  });

  test('one operation produces every phase set plus combined with stable filenames', () => {
    const state = prelimPlayoffTournament();
    state.tournament!.name = 'My Tournament!';
    const sets = buildCanonicalResourceCenterScopeSets(
      state,
      resourceCenterRecommendedScopeKeys(state),
      generatedAt,
    );
    expect(sets.errors).toEqual([]);
    expect(sets.totalSets).toBe(3);
    // Six required roles plus the stat-key companion per set.
    expect(sets.totalFiles).toBe(3 * 7);
    const names = sets.sets.flatMap((set) => set.files.map((file) => file.fileName));
    expect(new Set(names).size).toBe(names.length);
    const bases = sets.sets.map((set) => set.baseName);
    expect(bases).toEqual(['My-Tournament-Prelims', 'My-Tournament-Playoffs', 'My-Tournament-combined']);
    for (const fileName of names) {
      expect(fileName).toMatch(
        /_standings\.html|_individuals\.html|_games\.html|_teamdetail\.html|_playerdetail\.html|_rounds\.html|_statkey\.html/,
      );
    }
    expect(sets.fileName).toBe('My-Tournament-resource-center-all.zip');
    const entries = Object.keys(unzipSync(sets.bytes));
    expect(entries).toHaveLength(sets.totalFiles);
  });

  test('prelim pools map to divisions within the phase; combined never flattens changing pools', () => {
    const state = playedTournament();
    state.phases[0]!.name = 'Prelims';
    state.phases[0]!.poolIds = ['pool-a', 'pool-b'];
    state.teams.push(team('team-c', 'Dorman'), team('team-d', 'Spartanburg'));
    state.pools.push(
      { id: 'pool-a', phaseId: 'phase-1', name: 'Pool A', teamIds: ['team-a', 'team-b'], order: 1 },
      { id: 'pool-b', phaseId: 'phase-1', name: 'Pool B', teamIds: ['team-c', 'team-d'], order: 2 },
    );
    state.scheduledGames[0]!.poolId = 'pool-a';
    addAcceptedGame(state, 'game-b', 'scheduled-b', 'round-1', 'team-c', 'team-d', 250, 200, {
      poolId: 'pool-b',
    });
    const playoffs = addPhase(state, 'phase-2', 'Playoffs', 2, { teamIds: ['team-a', 'team-c'] });
    addRound(state, 'round-2', playoffs.id, 'Round 2', 2);
    addAcceptedGame(state, 'game-p', 'scheduled-p', 'round-2', 'team-a', 'team-c', 300, 220);

    const prelims = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-1', generatedAt);
    expect(prelims.divisions).toEqual(['Pool A', 'Pool B']);
    expect(prelims.gameCount).toBe(2);
    const combined = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
    expect(combined.divisions).toEqual([]);
    expect(combined.warnings.join('\n')).toMatch(/multiple stages/);
    expect(combined.warnings.join('\n')).toMatch(/pool assignments are omitted/);
    expect(combined.gameCount).toBe(3);
    expect(combined.gameCount).toBe(acceptedGameRecords(state).length);
  });

  test('dropped teams keep valid historical games while leaving later standings', () => {
    const state = prelimPlayoffTournament();
    state.teams.find((entry) => entry.id === 'team-b')!.status = 'dropped';
    const prelims = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-1', generatedAt);
    // The historical prelim game still counts exactly once…
    expect(prelims.gameCount).toBe(1);
    expect(fileOf(prelims, 'scoreboard')).toContain('Greenwood');
    // …but the dropped row follows Director standings semantics and is omitted.
    expect(fileOf(prelims, 'standings')).not.toContain('Greenwood');
    // Opponents still keep the result: Ninety Six leaves prelims 1–0.
    expect(fileOf(prelims, 'standings')).toMatch(/1–0/);
    const combined = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
    expect(combined.gameCount).toBe(2);
  });

  test('cancelled games and byes never reach any report set', () => {
    const state = prelimPlayoffTournament();
    state.scheduledGames.push(
      scheduledGame('scheduled-cancelled', 'team-a', 'team-b', { roundId: 'round-1' }),
    );
    state.scheduledGames.find((entry) => entry.id === 'scheduled-cancelled')!.status = 'cancelled';
    state.games.push({
      ...acceptedGame('game-cancelled', 'scheduled-cancelled', [score('team-a', 100), score('team-b', 50)]),
      roundId: 'round-1',
    });
    state.scheduledGames.push(
      scheduledGame('scheduled-bye', 'team-a', 'team-a', { roundId: 'round-1', bye: true }),
    );
    const prelims = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-1', generatedAt);
    const combined = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
    expect(prelims.gameCount).toBe(1);
    expect(combined.gameCount).toBe(2);
    expect(fileOf(combined, 'scoreboard')).not.toContain('100–50');
  });

  test('replayed and corrected games count once with the current accepted truth', () => {
    const state = playedTournament();
    const correction = acceptedGame('game-1-correction', 'scheduled-1', [
      score('team-a', 330, { powers: 5, gets: 8, negs: 1, bonuses: 12, bonusPoints: 130 }),
      score('team-b', 210, { powers: 1, gets: 9, negs: 3, bonuses: 10, bonusPoints: 90 }),
    ]);
    correction.roundId = 'round-1';
    correction.acceptedAt = '2026-09-02T12:00:00.000Z';
    state.games.push(correction);
    expect(acceptedGameRecords(state)).toHaveLength(1);
    const combined = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
    expect(combined.gameCount).toBe(1);
    expect(fileOf(combined, 'scoreboard')).toContain('330–210');
    expect(fileOf(combined, 'scoreboard')).not.toContain('300–210');
  });
});

describe('resource center scope semantics', () => {
  test('carryover influences playoff standings without duplicating games in detail', () => {
    const state = playedTournament();
    state.phases[0]!.name = 'Prelims';
    // Prelims: A beats C; Playoffs: A vs C again with carryover enabled.
    state.teams.push(team('team-c', 'Dorman'));
    state.players.push(player('player-c', 'team-c', 'Cal'));
    state.scheduledGames[0]!.leftTeamId = 'team-a';
    state.scheduledGames[0]!.rightTeamId = 'team-c';
    state.games[0]!.scores = [score('team-a', 300), score('team-c', 200)];
    const playoffs = addPhase(state, 'phase-2', 'Playoffs', 2, {
      teamIds: ['team-a', 'team-c'],
      carryover: true,
    });
    addRound(state, 'round-2', playoffs.id, 'Round 2', 2);
    addAcceptedGame(state, 'game-2', 'scheduled-2', 'round-2', 'team-a', 'team-c', 240, 260);

    const playoffSet = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-2', generatedAt);
    expect(playoffSet.scopeLabel).toContain('including carryover');
    expect(playoffSet.gameCount).toBe(1);
    expect(playoffSet.warnings.join('\n')).toMatch(/carryover/);
    expect(playoffSet.warnings.join('\n')).toMatch(/not duplicated/);
    // Standings include carryover: A is 1–1 (won prelims, lost playoffs).
    expect(fileOf(playoffSet, 'standings')).toMatch(/1–1/);
    // Detail lists the stage game only — the prelim result is not duplicated.
    expect(fileOf(playoffSet, 'scoreboard')).toContain('240–260');
    expect(fileOf(playoffSet, 'scoreboard')).not.toContain('300–200');
    const combined = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
    expect(combined.gameCount).toBe(2);
    expect(combined.gameCount).toBe(acceptedGameRecords(state).length);
  });

  test('without carryover, playoff standings cover stage games only', () => {
    const state = playedTournament();
    state.phases[0]!.name = 'Prelims';
    state.teams.push(team('team-c', 'Dorman'));
    state.players.push(player('player-c', 'team-c', 'Cal'));
    state.scheduledGames[0]!.leftTeamId = 'team-a';
    state.scheduledGames[0]!.rightTeamId = 'team-c';
    state.games[0]!.scores = [score('team-a', 300), score('team-c', 200)];
    const playoffs = addPhase(state, 'phase-2', 'Playoffs', 2, {
      teamIds: ['team-a', 'team-c'],
      carryover: false,
    });
    addRound(state, 'round-2', playoffs.id, 'Round 2', 2);
    addAcceptedGame(state, 'game-2', 'scheduled-2', 'round-2', 'team-a', 'team-c', 240, 260);

    const playoffSet = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-2', generatedAt);
    expect(playoffSet.scopeLabel).not.toContain('carryover');
    expect(playoffSet.warnings.join('\n')).not.toMatch(/carryover/);
    // Stage only: A is 0–1 in the playoffs.
    expect(fileOf(playoffSet, 'standings')).toMatch(/0–1/);
  });

  test('tiebreaker-packet games stay visible as results without deciding standings', () => {
    const state = playedTournament();
    state.packets.push({
      id: 'packet-tb',
      name: 'Tiebreaker',
      source: 'manual',
      assignedRoundIds: [],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
      tiebreaker: true,
    });
    addAcceptedGame(state, 'game-tb', 'scheduled-tb', 'round-1', 'team-a', 'team-b', 100, 90, {
      packetId: 'packet-tb',
    });
    const combined = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
    expect(combined.gameCount).toBe(2);
    expect(combined.warnings.join('\n')).toMatch(/tiebreaker/);
    // Scoreboard keeps the explicit tiebreaker result…
    expect(fileOf(combined, 'scoreboard')).toContain('100–90');
    // …but standings still show the 1–0 regulation record, not 2–0.
    expect(fileOf(combined, 'standings')).toMatch(/1–0/);
    expect(fileOf(combined, 'standings')).not.toMatch(/2–0/);
  });

  test('finals and placement phases report normally; final placement applies to combined only', () => {
    const state = prelimPlayoffTournament();
    const finals = addPhase(state, 'phase-3', 'Finals', 3, { kind: 'final', teamIds: ['team-a'] });
    addRound(state, 'round-3', finals.id, 'Final', 3);
    addAcceptedGame(state, 'game-3', 'scheduled-3', 'round-3', 'team-a', 'team-c', 320, 300);
    state.tournament!.finalPlacement = {
      order: ['team-c', 'team-a', 'team-b', 'team-d'],
      actor: 'Director',
      at: generatedAt,
    };
    const finalSet = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-3', generatedAt);
    expect(finalSet.gameCount).toBe(1);
    expect(fileOf(finalSet, 'scoreboard')).toContain('320–300');
    // Phase sets ignore the explicit final ranking…
    expect(fileOf(finalSet, 'standings')).toContain('team-team-a');
    const combined = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
    // …while the combined set honors it: Dorman (team-c) outranks Ninety Six (team-a).
    // Compare team anchors: display names collide with the tournament title.
    const standings = fileOf(combined, 'standings');
    expect(standings.indexOf('team-team-c')).toBeLessThan(standings.indexOf('team-team-a'));
    expect(combined.gameCount).toBe(3);
  });

  test('mixed scoring definitions stay honest and never silently re-value history', () => {
    const state = prelimPlayoffTournament();
    const prelimRules = structuredClone(state.tournament!.rules);
    const playoffRules = structuredClone(state.tournament!.rules);
    playoffRules.powerValue = 20;
    playoffRules.tossupCount = 24;
    state.gameDefinitions.push(
      {
        id: 'def-1',
        scheduledGameId: 'scheduled-1',
        revision: 1,
        createdAt: generatedAt,
        rules: prelimRules,
        roundId: 'round-1',
        packetId: null,
        leftTeamId: 'team-a',
        rightTeamId: 'team-b',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 1,
        digest: 'digest-prelim',
      },
      {
        id: 'def-2',
        scheduledGameId: 'scheduled-2',
        revision: 1,
        createdAt: generatedAt,
        rules: playoffRules,
        roundId: 'round-2',
        packetId: null,
        leftTeamId: 'team-a',
        rightTeamId: 'team-c',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 1,
        digest: 'digest-playoff',
      },
    );
    state.games.find((game) => game.id === 'game-1')!.definitionDigest = 'digest-prelim';
    state.games.find((game) => game.id === 'game-2')!.definitionDigest = 'digest-playoff';

    const prelims = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-1', generatedAt);
    expect(prelims.warnings.join('\n')).not.toMatch(/different scoring definitions/);
    const combined = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
    expect(combined.warnings.join('\n')).toMatch(/different scoring definitions/);
    expect(combined.warnings.join('\n')).toMatch(/phase reports \(recommended\)/);
    expect(fileOf(combined, 'statKey')).toMatch(/vary within this report/);
  });

  test('unknown scope keys fail closed', () => {
    const state = prelimPlayoffTournament();
    const artifact = buildCanonicalResourceCenterScopeArtifact(state, 'phase:missing', generatedAt);
    expect(artifact.errors.join('\n')).toMatch(/Unknown report scope/);
    expect(artifact.files).toHaveLength(0);
  });

  test('single-stage scope output matches the existing overall report shape', () => {
    const state = playedTournament();
    const artifact = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
    expect(artifact.scopeLabel).toBe('Overall');
    expect(artifact.baseName).toBe('Ninety-Six-Invitational');
    expect(artifact.files.map((file) => file.kind)).toEqual([
      'standings',
      'individuals',
      'scoreboard',
      'teamDetail',
      'playerDetail',
      'rounds',
      'statKey',
    ]);
    for (const file of artifact.files) {
      expect(file.requiredForResourceCenter).toBe(file.kind !== 'statKey');
      expect(file.fileName.startsWith(`${artifact.baseName}_`)).toBe(true);
    }
    expect(fileOf(artifact, 'standings')).toContain('Ninety Six Invitational');
  });
});

describe('prepare-for-HSQuizbowl workflow support (issue #766)', () => {
  test('scopes carry team and round counts for the pre-export preview', () => {
    const scopes = resourceCenterScopes(prelimPlayoffTournament());
    expect(scopes.map((scope) => [scope.teamCount, scope.gameCount, scope.roundCount])).toEqual([
      [2, 1, 1],
      [2, 1, 1],
      [3, 2, 2],
    ]);
    const single = resourceCenterScopes(playedTournament());
    expect(single[0]).toMatchObject({ teamCount: 2, gameCount: 1, roundCount: 1 });
  });

  test('multi-scope sets run the structural preflight instead of skipping it', () => {
    const state = playedTournament();
    state.tournament!.name = '';
    const sets = buildCanonicalResourceCenterScopeSets(state, ['combined'], generatedAt);
    expect(sets.errors.join('\n')).toMatch(/no tournament name/);
    expect(sets.sets[0]!.blocking.map((entry) => entry.code)).toContain('missing-tournament-identity');
    expect(sets.sets[0]!.blocking[0]).toMatchObject({
      code: expect.any(String),
      path: expect.any(String),
      message: expect.any(String),
    });
  });

  test('preflight warnings ride along with multi-scope sets', () => {
    const sets = buildCanonicalResourceCenterScopeSets(playedTournament(), ['combined'], generatedAt);
    expect(sets.errors).toEqual([]);
    expect(sets.sets[0]!.preflightWarnings.length).toBeGreaterThan(0);
    expect(sets.warnings.join('\n')).toContain(sets.sets[0]!.preflightWarnings[0]!.message);
  });

  test('report labels are editable while filenames stay sanitized and stable', () => {
    const state = prelimPlayoffTournament();
    const sets = buildCanonicalResourceCenterScopeSets(
      state,
      ['phase:phase-1', 'combined'],
      generatedAt,
      undefined,
      { 'phase:phase-1': 'Opening <b>Rounds</b>' },
    );
    const prelims = sets.sets[0]!;
    expect(prelims.scopeLabel).toBe('Opening <b>Rounds</b>');
    // Filenames ignore the display label; the label itself is HTML-escaped.
    const unedited = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-1', generatedAt);
    expect(prelims.baseName).toBe(unedited.baseName);
    for (const file of prelims.files) {
      expect(file.fileName.startsWith(`${unedited.baseName}_`)).toBe(true);
      expect(file.content).not.toContain('Opening <b>Rounds</b>');
    }
    expect(fileOf(prelims, 'standings')).toContain('Opening &lt;b&gt;Rounds&lt;/b&gt;');
    // A blank override falls back to the scope default.
    const fallback = buildCanonicalResourceCenterScopeArtifact(
      state,
      'phase:phase-1',
      generatedAt,
      undefined,
      '   ',
    );
    expect(fallback.scopeLabel).toBe('Prelims');
  });

  test('duplicate report names warn without renaming files', () => {
    const state = prelimPlayoffTournament();
    const sets = buildCanonicalResourceCenterScopeSets(
      state,
      ['phase:phase-1', 'phase:phase-2', 'combined'],
      generatedAt,
      undefined,
      { 'phase:phase-2': 'prelims' },
    );
    expect(sets.errors).toEqual([]);
    expect(sets.warnings.join('\n')).toMatch(/Duplicate report name "prelims"/);
    const bases = sets.sets.map((set) => set.baseName);
    expect(new Set(bases).size).toBe(bases.length);
  });

  test('regeneration after a correction changes the revision and the counts', () => {
    const state = playedTournament();
    const before = buildCanonicalResourceCenterScopeSets(state, ['combined'], generatedAt);
    addAcceptedGame(state, 'game-2', 'scheduled-2', 'round-1', 'team-b', 'team-a', 250, 240);
    const after = buildCanonicalResourceCenterScopeSets(state, ['combined'], generatedAt);
    expect(after.sets[0]!.gameCount).toBe(before.sets[0]!.gameCount + 1);
    expect(after.revision).not.toBe(before.revision);
    expect(after.sets[0]!.revision).not.toBe(before.sets[0]!.revision);
    // Same input regenerates identically, so a revision always means a change.
    const repeat = buildCanonicalResourceCenterScopeSets(state, ['combined'], generatedAt);
    expect(repeat.revision).toBe(after.revision);
  });
});
