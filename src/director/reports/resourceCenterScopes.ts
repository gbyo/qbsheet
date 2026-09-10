/**
 * Multi-phase Resource Center export scopes (issue #763, epic #760).
 *
 * A multi-phase tournament must produce one Resource Center report set per
 * phase plus a combined set in one operation (ACF guidance: post each phase
 * separately as well as a combined file). Scopes come from Director's
 * explicit phase model — never from contiguous round numbers — and each
 * set is a view of the same canonical accepted-results snapshots the rest
 * of Director renders.
 *
 * Scope policy (deliberate, tested in `resourceCenterScopes.test.ts`):
 *
 * - One scope per non-archived phase, ordered by `phase.order`, plus a
 *   `Combined` scope for the entire tournament. Single-stage tournaments
 *   expose only the combined scope so there is no unnecessary phase chooser.
 * - Pool/division-specific sets are intentionally not offered: a phase-level
 *   report with divisions is the conventional representation (see the
 *   non-goals in #763). Within a single phase, pools are retained as report
 *   divisions metadata (`divisions`) and games keep their `poolId`; the HTML
 *   tables themselves gain no new columns (per the #762 contract of no
 *   invented columns). Across phases, a combined set never flattens changing
 *   pools into one global division assignment — it omits divisions with an
 *   explicit warning, mirroring the full SQBS exporter.
 * - Per-phase games are exactly the accepted games whose round belongs to
 *   that phase (`acceptedGameRecords(state, { phaseId })`). That selector
 *   already excludes byes/non-games (`bye` or both sides the same team),
 *   cancelled schedule rows, superseded/corrected records (one current
 *   record per scheduled game), and invalid legacy records, while counting
 *   forfeits as decided results. Replayed games collapse to the single
 *   current accepted record; the combined set counts each unique canonical
 *   accepted game exactly once.
 * - Teams in a phase set are the teams with canonical results in that scope.
 *   Eliminated teams (no games in a later phase) naturally absent themselves
 *   from that phase. Dropped teams follow Director standings semantics:
 *   their historical games remain valid and still count for opponents, but
 *   the dropped row itself is omitted from standings (matching Director/Live
 *   rather than inventing a second roster rule for uploads).
 * - Carryover: when `phase.carryover` is set, playoff standings include the
 *   canonical prior-phase games between the phase field (both teams in the
 *   field, earlier phase order), exactly as the printable standings report
 *   does. The Scoreboard / Round Report / game-by-game detail list stage
 *   games only — a carried-over game is never duplicated in report detail
 *   merely because it influences later standings. The scope label gains the
 *   `· including carryover` suffix and the artifact warns explicitly.
 * - Tiebreakers: games played on a tiebreaker packet are explicit results in
 *   the Scoreboard but are excluded from standings aggregates unless the
 *   tournament's canonical rules set `tiebreakerCountsStatistically`, again
 *   matching the printable standings report. Finals/placement games are
 *   ordinary phase games; an explicit `finalPlacement` overrides order only
 *   in the combined set, never inside a phase set.
 * - Mixed scoring definitions are never silently re-valued: player points are
 *   valued per game under each game's own historical definition inside the
 *   canonical derivations, and the report presentation for a scope uses only
 *   the definitions of the games contributing to that scope. A scope whose
 *   games span definitions renders one semantic answer column with explicit
 *   mixed-value notes (never merged by number); the combined set additionally
 *   warns and points the director at the phase sets.
 * - Names are stable and human-readable: phase labels are phase names, the
 *   combined label is `Combined` (`Overall` for single-stage for backwards
 *   compatibility), and file bases are sanitized
 *   `<tournament>-<phase>` / `<tournament>-combined` prefixes. Raw internal
 *   IDs never appear in user-facing names.
 */

import {
  buildResourceCenterReport,
  defaultReportOptions,
  preflightResourceCenterReport,
  reportPageOrder,
  sanitizeResourceCenterBaseName,
  zipStatReportBundle,
  type FormatError,
  type FormatWarning,
  type ReportOptions,
  type ReportScoringDefinition,
  type ResourceCenterReportFile,
} from '@qbsheet/tournament-formats';
import type { DirectorState, GameRecord, Phase, TournamentRules } from '../domain';
import { acceptedGameRecords, phaseCompetitiveField } from '../domain';
import { buildCanonicalRoundStatsSnapshot } from './canonicalRoundReports';
import { withReportPresentation } from './reportPresentation';

export type ResourceCenterScopeKind = 'phase' | 'combined';

export interface ResourceCenterScope {
  /** Stable UI key: 'combined' or `phase:<id>`. */
  key: string;
  kind: ResourceCenterScopeKind;
  phaseId?: string;
  /** Human-readable label: phase name, `Combined`, or `Overall` (single-stage). */
  label: string;
  /** Sanitized slug for file bases; never a raw internal ID. */
  slug: string;
  /** Stable filesystem-safe base prefix shared by every file in one set. */
  baseName: string;
  /** Short preview detail, e.g. "3 games". */
  detail: string;
  gameCount: number;
  /** Distinct teams with accepted games in this scope. */
  teamCount: number;
  /** Distinct rounds with accepted games in this scope. */
  roundCount: number;
  /** Pool names when this scope has exactly one stage with several pools. */
  divisions: string[];
}

export type ResourceCenterPreset = 'recommended' | 'phases-only' | 'combined-only';

export interface ResourceCenterScopeArtifact {
  scopeKey: string;
  scopeLabel: string;
  baseName: string;
  files: ResourceCenterReportFile[];
  /** Pool names retained for this single-stage scope; empty for combined. */
  divisions: string[];
  gameCount: number;
  teamCount: number;
  warnings: string[];
  errors: string[];
  /**
   * Structured #764 preflight for this set (issue #766 step 2). Blocking
   * entries refuse the save; warning entries ride along. Kept alongside the
   * flattened strings so the workflow can link each diagnostic at a fix.
   */
  blocking: FormatError[];
  preflightWarnings: FormatWarning[];
  /** ISO timestamp this set was generated, shown so repeat publishes stay comparable. */
  generatedAt: string;
  /** Short content hash of this set's files; changes when any file changes. */
  revision: string;
}

export interface ResourceCenterScopeSets {
  sets: ResourceCenterScopeArtifact[];
  bytes: Uint8Array;
  fileName: string;
  totalSets: number;
  totalFiles: number;
  warnings: string[];
  errors: string[];
  /** ISO timestamp the whole package was generated. */
  generatedAt: string;
  /** Short content hash of the ZIP; changes when any selected file changes. */
  revision: string;
}

/**
 * Short content hash (FNV-1a, hex) so an operator can tell two generated
 * packages apart after a correction. Not cryptographic — only a revision tag.
 */
export function hashReportBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function activePhases(state: DirectorState): Phase[] {
  return state.phases
    .filter((phase) => phase.archived !== true)
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function tournamentBase(state: DirectorState): string {
  return sanitizeResourceCenterBaseName(state.tournament?.name ?? 'tournament');
}

function uniqueBase(proposed: string, used: Set<string>): string {
  let candidate = proposed;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${proposed}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function scopeSlugForPhase(phase: Phase): string {
  const slug = sanitizeResourceCenterBaseName(phase.name);
  return slug === 'report' ? sanitizeResourceCenterBaseName(`phase-${phase.order}`) : slug;
}

/** Pool names for one stage, mirroring the full SQBS exporter's division rule. */
function divisionsForPhase(state: DirectorState, phaseId: string): string[] {
  const phase = state.phases.find((entry) => entry.id === phaseId);
  if (!phase) return [];
  const livePools = state.pools
    .filter((pool) => !pool.archived && pool.phaseId === phaseId && phase.poolIds.includes(pool.id))
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return livePools.length > 1 ? livePools.map((pool) => pool.name) : [];
}

export interface ResourceCenterScopeCounts {
  gameCount: number;
  teamCount: number;
  roundCount: number;
}

/** Accepted-games footprint of one scope: games, distinct teams, distinct rounds. */
export function scopeCountsFor(state: DirectorState, phaseId?: string): ResourceCenterScopeCounts {
  const games = acceptedGameRecords(state, phaseId ? { phaseId } : {});
  const teams = new Set<string>();
  const rounds = new Set<string>();
  for (const game of games) {
    rounds.add(game.roundId);
    for (const score of game.scores) teams.add(score.teamId);
  }
  return { gameCount: games.length, teamCount: teams.size, roundCount: rounds.size };
}

function scopeDetail(counts: ResourceCenterScopeCounts): string {
  const games = `${counts.gameCount} game${counts.gameCount === 1 ? '' : 's'}`;
  const teams = `${counts.teamCount} team${counts.teamCount === 1 ? '' : 's'}`;
  const rounds = `${counts.roundCount} round${counts.roundCount === 1 ? '' : 's'}`;
  return `${teams} · ${games} · ${rounds}`;
}

/**
 * Publishable scopes from the explicit phase model. Single-stage
 * tournaments return only the combined scope so the UI never shows a
 * redundant phase chooser. Multi-stage tournaments return one scope per
 * phase (in phase order) plus the combined scope.
 */
export function resourceCenterScopes(state: DirectorState): ResourceCenterScope[] {
  if (!state.tournament) return [];
  const phases = activePhases(state);
  const tournament = tournamentBase(state);
  if (phases.length <= 1) {
    const counts = scopeCountsFor(state);
    return [
      {
        key: 'combined',
        kind: 'combined',
        label: 'Overall',
        slug: 'combined',
        baseName: tournament,
        detail: scopeDetail(counts),
        gameCount: counts.gameCount,
        teamCount: counts.teamCount,
        roundCount: counts.roundCount,
        divisions: [],
      },
    ];
  }
  const used = new Set<string>([tournament]);
  const scopes: ResourceCenterScope[] = [];
  for (const phase of phases) {
    const slug = scopeSlugForPhase(phase);
    const proposed = sanitizeResourceCenterBaseName(`${state.tournament.name}-${phase.name}`);
    const baseName = uniqueBase(proposed === 'report' ? `${tournament}-${slug}` : proposed, used);
    const counts = scopeCountsFor(state, phase.id);
    scopes.push({
      key: `phase:${phase.id}`,
      kind: 'phase',
      phaseId: phase.id,
      label: phase.name,
      slug,
      baseName,
      detail: scopeDetail(counts),
      gameCount: counts.gameCount,
      teamCount: counts.teamCount,
      roundCount: counts.roundCount,
      divisions: divisionsForPhase(state, phase.id),
    });
  }
  const combinedBase = uniqueBase(sanitizeResourceCenterBaseName(`${state.tournament.name}-combined`), used);
  const combinedCounts = scopeCountsFor(state);
  scopes.push({
    key: 'combined',
    kind: 'combined',
    label: 'Combined',
    slug: 'combined',
    baseName: combinedBase,
    detail: scopeDetail(combinedCounts),
    gameCount: combinedCounts.gameCount,
    teamCount: combinedCounts.teamCount,
    roundCount: combinedCounts.roundCount,
    divisions: [],
  });
  return scopes;
}

/**
 * Preset selection matching the HSQuizbowl preparation workflow. The default
 * recommendation includes only phases that already have accepted results,
 * plus Combined. Configuring tomorrow's playoff/final stage in advance must
 * never make today's publishable reports fail preflight merely because that
 * future stage is still empty (#865). Explicit presets/manual selection keep
 * empty phases available when the director intentionally chooses them.
 */
export function resourceCenterPresetScopeKeys(state: DirectorState, preset: ResourceCenterPreset): string[] {
  const scopes = resourceCenterScopes(state);
  if (scopes.length <= 1) return scopes.map((scope) => scope.key);
  if (preset === 'combined-only') return ['combined'];
  if (preset === 'phases-only') return scopes.filter((scope) => scope.kind === 'phase').map((s) => s.key);

  const playedPhases = scopes.filter((scope) => scope.kind === 'phase' && scope.gameCount > 0);
  const combined = scopes.find((scope) => scope.kind === 'combined');
  if (!combined) return playedPhases.map((scope) => scope.key);
  if (combined.gameCount === 0) return [combined.key];
  return [...playedPhases.map((scope) => scope.key), combined.key];
}

export function resourceCenterRecommendedScopeKeys(state: DirectorState): string[] {
  return resourceCenterPresetScopeKeys(state, 'recommended');
}

function withoutFinalPlacement(tournament: NonNullable<DirectorState['tournament']>) {
  const result = { ...tournament };
  delete result.finalPlacement;
  return result;
}

function scoringDefinition(rules: TournamentRules, id?: string): ReportScoringDefinition {
  return {
    ...(id ? { id } : {}),
    tossupValue: rules.tossupValue,
    superpowerValue: rules.superpowerValue,
    powerValue: rules.powerValue,
    negValue: rules.negValue,
    useBonuses: rules.useBonuses,
    tossupCount: rules.tossupCount,
    bouncebacks: rules.bouncebacks,
    lightning: rules.lightning,
    overtime: rules.overtime,
  };
}

/**
 * Scoring truths covering exactly the given games. Tournaments with no
 * issued history fall back to live defaults, mirroring report presentation.
 */
function definitionsForGames(state: DirectorState, games: readonly GameRecord[]): ReportScoringDefinition[] {
  if (state.gameDefinitions.length === 0) {
    const rules = state.tournament?.rules;
    return rules ? [scoringDefinition(rules)] : [];
  }
  const scheduledIds = new Set(games.map((game) => game.scheduledGameId));
  const digests = new Set(
    games.map((game) => game.definitionDigest).filter((value): value is string => Boolean(value)),
  );
  const relevant = state.gameDefinitions.filter(
    (snapshot) => scheduledIds.has(snapshot.scheduledGameId) || digests.has(snapshot.digest),
  );
  const seen = new Set<string>();
  const definitions: ReportScoringDefinition[] = [];
  for (const snapshot of relevant) {
    if (seen.has(snapshot.digest)) continue;
    seen.add(snapshot.digest);
    definitions.push(scoringDefinition(snapshot.rules, snapshot.id));
  }
  if (definitions.length > 0) return definitions;
  const rules = state.tournament?.rules;
  return rules ? [scoringDefinition(rules)] : [];
}

/** Accepted games played on a tiebreaker packet (mirrors standingsReport). */
function tiebreakerGameIds(state: DirectorState): Set<string> {
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet]));
  const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
  const roundById = new Map(state.rounds.map((round) => [round.id, round]));
  const ids = new Set<string>();
  for (const game of acceptedGameRecords(state)) {
    const scheduled = scheduledById.get(game.scheduledGameId);
    const round = roundById.get(game.roundId);
    const packetId = game.packetId ?? scheduled?.packetId ?? round?.packetId ?? undefined;
    if (packetId && packetById.get(packetId)?.tiebreaker) ids.add(game.id);
  }
  return ids;
}

/**
 * Canonical prior-phase games carried into a carryover phase: earlier-phase
 * accepted games where both teams belong to the phase field. Mirrors the
 * printable standings report so Resource Center standings cannot disagree
 * with Director about carryover.
 */
function carryoverGamesForPhase(state: DirectorState, phase: Phase): GameRecord[] {
  const field = new Set(phaseCompetitiveField(state, phase.id).teams.map((team) => team.id));
  // Phases that own pools but have no committed field yet (no advancement)
  // still carry prior games between the teams that actually appear in the
  // phase's own schedule: fall back to the scheduled field so carryover is
  // not silently dropped for hand-built multi-phase fixtures.
  if (field.size === 0) {
    const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
    for (const game of acceptedGameRecords(state, { phaseId: phase.id })) {
      const scheduled = scheduledById.get(game.scheduledGameId);
      if (scheduled?.leftTeamId) field.add(scheduled.leftTeamId);
      if (scheduled?.rightTeamId) field.add(scheduled.rightTeamId);
      for (const score of game.scores) field.add(score.teamId);
    }
  }
  if (field.size === 0) return [];
  const phasesById = new Map(state.phases.map((entry) => [entry.id, entry]));
  const roundPhaseId = new Map(state.rounds.map((round) => [round.id, round.phaseId]));
  return acceptedGameRecords(state).filter((game) => {
    const gamePhase = phasesById.get(roundPhaseId.get(game.roundId) ?? '');
    if (!gamePhase || gamePhase.id === phase.id || gamePhase.order >= phase.order) return false;
    const teams = game.scores.map((score) => score.teamId);
    return teams.length >= 2 && teams.every((teamId) => field.has(teamId));
  });
}

function scopePhase(state: DirectorState, scopeKey: string): Phase | undefined {
  if (scopeKey === 'combined') return undefined;
  if (!scopeKey.startsWith('phase:')) return undefined;
  return state.phases.find((phase) => phase.id === scopeKey.slice('phase:'.length));
}

/**
 * Build one scope's canonical snapshot: standings aggregates come from the
 * carryover-inclusive, tiebreaker-exclusive game set while the per-game
 * surfaces list exactly the stage's accepted games. The two sets are merged
 * here so carryover influences standings without duplicating historical
 * games in report detail, and tiebreaker packets stay visible as results
 * without moving standings they must not decide.
 */
function buildScopeSnapshot(
  state: DirectorState,
  scope: ResourceCenterScope,
  generatedAt: string,
  options: ReportOptions,
) {
  const phase = scope.kind === 'phase' && scope.phaseId ? scopePhase(state, scope.key) : undefined;
  const scopeLabel =
    phase?.carryover && scope.kind === 'phase' ? `${scope.label} · including carryover` : scope.label;
  const stageGames = acceptedGameRecords(state, scope.phaseId ? { phaseId: scope.phaseId } : {});
  const tiebreakers = tiebreakerGameIds(state);
  const countsStatistically = state.tournament?.rules.tiebreakerCountsStatistically === true;
  const tiebreakerInScope = stageGames.filter((game) => tiebreakers.has(game.id));
  const carryoverGames = phase?.carryover === true && phase ? carryoverGamesForPhase(state, phase) : [];
  // Standings aggregates: stage games minus non-counting tiebreakers plus
  // eligible prior-phase carryover. Display games stay stage-only.
  const standingsIds = new Set(
    stageGames.filter((game) => countsStatistically || !tiebreakers.has(game.id)).map((game) => game.id),
  );
  for (const game of carryoverGames) {
    if (countsStatistically || !tiebreakers.has(game.id)) standingsIds.add(game.id);
  }
  const standingsGames = acceptedGameRecords(state).filter((game) => standingsIds.has(game.id));
  const displayFilter = scope.phaseId ? { phaseId: scope.phaseId, label: scopeLabel } : { label: scopeLabel };
  const display = buildCanonicalRoundStatsSnapshot(state, displayFilter, generatedAt);
  let standingsTeams = display.teams;
  let standingsPlayers = display.players;
  if (
    carryoverGames.length > 0 ||
    tiebreakerInScope.length > 0 ||
    standingsGames.length !== stageGames.length
  ) {
    const narrowedTournament = state.tournament
      ? scope.kind === 'phase'
        ? withoutFinalPlacement(state.tournament)
        : state.tournament
      : null;
    // Restrict the narrowed roster to teams with standings games so phase
    // sets never list zero-row teams that never appeared in the scope.
    const standingsTeamIds = new Set(
      standingsGames.flatMap((game) => game.scores.map((score) => score.teamId)),
    );
    const narrowed: DirectorState = {
      ...state,
      ...(narrowedTournament ? { tournament: narrowedTournament } : { tournament: null }),
      teams: state.teams.filter((team) => standingsTeamIds.has(team.id)),
      games: state.games.filter((game) => standingsIds.has(game.id)),
    };
    const standings = buildCanonicalRoundStatsSnapshot(narrowed, { label: scopeLabel }, generatedAt);
    standingsTeams = standings.teams;
    standingsPlayers = standings.players;
  }
  // Issue #766: a scope set carries only teams with canonical results in the
  // scope. The unfiltered canonical snapshot lists the whole roster, including
  // teams with no accepted games yet; the #764 validator rightly refuses those
  // rows (`team-missing-from-games`), which would otherwise make repeat
  // mid-tournament publishing impossible. Filtering here matches the phase-set
  // rule documented above and leaves the shared snapshot builder — and every
  // Director/Live surface reading it — untouched.
  const scopeTeamIds = new Set(standingsGames.flatMap((game) => game.scores.map((score) => score.teamId)));
  const merged = {
    ...display,
    teams: standingsTeams.filter((team) => scopeTeamIds.has(team.teamId)),
    players: standingsPlayers,
  };
  const definitionGames = [...new Map([...standingsGames, ...stageGames].map((g) => [g.id, g])).values()];
  const definitions = definitionsForGames(state, definitionGames);
  const snapshot = withReportPresentation(state, merged, options, definitions);
  return { snapshot, scopeLabel, stageGames, standingsGames, carryoverGames, tiebreakerInScope };
}

function warningsForScope(
  state: DirectorState,
  scope: ResourceCenterScope,
  built: ReturnType<typeof buildScopeSnapshot>,
): string[] {
  const warnings: string[] = [];
  const { stageGames, carryoverGames, tiebreakerInScope, snapshot } = built;
  if (scope.kind === 'combined' && activePhases(state).length > 1) {
    const hasPools = state.pools.some((pool) => !pool.archived);
    const gamePhases = new Set(
      stageGames.map(
        (game) => state.rounds.find((round) => round.id === game.roundId)?.phaseId ?? game.roundId,
      ),
    );
    if (hasPools && gamePhases.size > 1) {
      warnings.push(
        'This combined report covers multiple stages, so pool assignments are omitted: report divisions can only describe one stage. Post each phase separately to keep its divisions.',
      );
    }
  }
  if (scope.divisions.length > 1) {
    const divisionPoolIds = new Set(
      state.pools
        .filter((pool) => pool.phaseId === scope.phaseId && scope.divisions.includes(pool.name))
        .map((pool) => pool.id),
    );
    const teamDivisions = new Map<string, string>();
    for (const pool of state.pools) {
      if (!divisionPoolIds.has(pool.id)) continue;
      for (const teamId of pool.teamIds) teamDivisions.set(teamId, pool.name);
    }
    const unpooled = snapshot.teams.filter((team) => !teamDivisions.has(team.teamId));
    if (unpooled.length > 0) {
      warnings.push(
        `${unpooled.length} team(s) (${unpooled
          .slice(0, 3)
          .map((team) => team.teamName)
          .join(
            ', ',
          )}${unpooled.length > 3 ? ', …' : ''}) are not in a pool and are reported without a division.`,
      );
    }
  }
  if (carryoverGames.length > 0) {
    warnings.push(
      `Standings include ${carryoverGames.length} canonical carryover game(s) from earlier phases; the Scoreboard and Round Report list stage games only (${stageGames.length}). Each physical game appears once; carryover is not duplicated in report detail.`,
    );
  }
  if (tiebreakerInScope.length > 0 && state.tournament?.rules.tiebreakerCountsStatistically !== true) {
    warnings.push(
      `Standings exclude ${tiebreakerInScope.length} tiebreaker-packet game(s); they remain in the Scoreboard as explicit results and do not decide placement.`,
    );
  }
  const mixedNote =
    typeof snapshot.presentation?.mixedDefinitionNote === 'string'
      ? snapshot.presentation.mixedDefinitionNote
      : undefined;
  if (mixedNote) {
    warnings.push(
      scope.kind === 'combined'
        ? `This combined report spans phases with different scoring definitions. ${mixedNote} For the clearest per-phase numbers, also post the individual phase reports (recommended).`
        : `This scope spans scoring definitions. ${mixedNote}`,
    );
  }
  if (stageGames.length === 0) {
    warnings.push('This scope has no decided games yet; the report shows empty tables.');
  }
  return warnings;
}

/**
 * Build one scope's Resource Center files from the canonical snapshot.
 * Filenames share the scope's stable base prefix with conventional
 * SQBS/YellowFruit suffixes; the scope label is human-readable.
 */
export function buildCanonicalResourceCenterScopeArtifact(
  state: DirectorState,
  scopeKey: string,
  generatedAt = new Date().toISOString(),
  options: ReportOptions = { ...defaultReportOptions, pages: [...reportPageOrder] },
  labelOverride?: string,
): ResourceCenterScopeArtifact {
  const scopes = resourceCenterScopes(state);
  const scope = scopes.find((entry) => entry.key === scopeKey);
  if (!state.tournament || !scope) {
    return {
      scopeKey,
      scopeLabel: scope?.label ?? 'Combined',
      baseName: scope?.baseName ?? 'report',
      files: [],
      divisions: [],
      gameCount: 0,
      teamCount: 0,
      warnings: [],
      errors: [scope ? 'There is no tournament to export.' : `Unknown report scope "${scopeKey}".`],
      blocking: [],
      preflightWarnings: [],
      generatedAt,
      revision: hashReportBytes(new Uint8Array()),
    };
  }
  const trimmedLabel = labelOverride?.trim() ?? '';
  const effectiveScope = trimmedLabel ? { ...scope, label: trimmedLabel } : scope;
  const normalizedOptions: ReportOptions = { ...options, pages: [...reportPageOrder] };
  const built = buildScopeSnapshot(state, effectiveScope, generatedAt, normalizedOptions);
  const artifact = buildResourceCenterReport(built.snapshot, {
    baseName: scope.baseName,
    includeStatKey: true,
  });
  // Issue #764 gate, applied per set: the #763 multi-scope path must not skip
  // the validator the single-scope path runs. Blocking diagnostics refuse the
  // save; warnings ride along with it.
  const preflight = preflightResourceCenterReport(artifact, built.snapshot);
  const warnings = [
    ...warningsForScope(state, effectiveScope, built),
    ...preflight.warnings.map((entry) => entry.message),
  ];
  const errors = [
    ...artifact.errors.map((entry) => entry.message),
    ...preflight.blocking.map((entry) => entry.message),
  ];
  return {
    scopeKey: scope.key,
    scopeLabel: built.scopeLabel,
    baseName: artifact.baseName,
    files: artifact.files,
    divisions: scope.divisions,
    gameCount: built.stageGames.length,
    teamCount: built.snapshot.teams.length,
    warnings,
    errors,
    blocking: [...artifact.errors, ...preflight.blocking],
    preflightWarnings: [...preflight.warnings],
    generatedAt,
    revision: hashReportBytes(
      new TextEncoder().encode(artifact.files.map((file) => `${file.fileName}\n${file.content}`).join('\n')),
    ),
  };
}

/**
 * Build every selected scope plus one ZIP containing all of their files.
 * Each set keeps its own base prefix so files never collide; the combined
 * set counts each unique canonical accepted game exactly once.
 */
export function buildCanonicalResourceCenterScopeSets(
  state: DirectorState,
  scopeKeys: readonly string[],
  generatedAt = new Date().toISOString(),
  options: ReportOptions = { ...defaultReportOptions, pages: [...reportPageOrder] },
  scopeLabels: Readonly<Record<string, string>> = {},
): ResourceCenterScopeSets {
  const uniqueKeys = [...new Set(scopeKeys)];
  const sets = uniqueKeys.map((key) =>
    buildCanonicalResourceCenterScopeArtifact(state, key, generatedAt, options, scopeLabels[key]),
  );
  const errors = sets.flatMap((set) => set.errors);
  const warnings = sets.flatMap((set) => set.warnings.map((warning) => `${set.scopeLabel}: ${warning}`));
  // Issue #766 report-name safety: two sets sharing one display label would be
  // posted as two indistinguishable stat reports. Filenames stay unique via
  // stable base prefixes; the collision is a warning, never a silent rename.
  const seenLabels = new Map<string, string>();
  for (const set of sets) {
    const folded = set.scopeLabel.trim().toLocaleLowerCase();
    const first = seenLabels.get(folded);
    if (first !== undefined && first !== set.scopeKey) {
      warnings.push(
        `Duplicate report name "${set.scopeLabel}": two report sets share one display label. ` +
          `Rename one before posting so each stat report stays distinguishable.`,
      );
    } else if (first === undefined) {
      seenLabels.set(folded, set.scopeKey);
    }
  }
  const files = sets.flatMap((set) => set.files);
  const seen = new Set<string>();
  const deduped = files.filter((file) => {
    if (seen.has(file.fileName)) return false;
    seen.add(file.fileName);
    return true;
  });
  const tournament = tournamentBase(state);
  const multi = sets.length > 1;
  const bytes = zipStatReportBundle(deduped.map((file) => ({ name: file.fileName, content: file.content })));
  return {
    sets,
    bytes,
    fileName: multi
      ? `${tournament}-resource-center-all.zip`
      : `${sets[0]?.baseName ?? tournament}-resource-center.zip`,
    totalSets: sets.length,
    totalFiles: deduped.length,
    warnings,
    errors,
    generatedAt,
    revision: hashReportBytes(bytes),
  };
}
