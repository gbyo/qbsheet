/**
 * Pinned competitive definitions for issued scorer assignments (#667).
 *
 * Once a game definition has escaped Director (file/USB preparation, download/share, QBTCP
 * delivery, or round release), the exact scoring truth for that game is immutable. Tournament
 * defaults may keep changing for future games, but every transport and every recovery path
 * rebuilds an issued game from its snapshot, so `(scheduledGameId, definitionRevision)` always
 * means the same competitive semantics.
 *
 * The digest helpers here intentionally duplicate the FNV-1a shape in `transfers/canonical`
 * rather than importing it: transfers depend on this domain module, so sharing would be a
 * cycle. Both implementations are pinned by tests against the same vectors.
 */
import {
  isoNow,
  newDirectorId,
  type DirectorId,
  type DirectorState,
  type GameDefinitionSnapshot,
  type HistoricalDefinitionSource,
  type IssuedRosterPlayer,
  type ScheduledGame,
  type TournamentRules,
} from './model';

/** Sorted-key canonical JSON over plain data. Arrays keep order; undefined becomes null. */
export function canonicalDefinitionJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalDefinitionJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalDefinitionJson(entry)}`)
    .join(',')}}`;
}

/**
 * FNV-1a over a string, as 16 lowercase hex characters.
 *
 * Synchronous and dependency-free so it runs inside state reducers and the scorer alike. An
 * equality aid for recognizing same-definition artifacts, not an authenticity claim.
 */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index) & 0xffff);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export interface DefinitionDigestInput {
  rules: TournamentRules;
  roundId: DirectorId;
  packetId: DirectorId | null;
  leftTeamId: DirectorId;
  rightTeamId: DirectorId;
  leftRoster: readonly IssuedRosterPlayer[];
  rightRoster: readonly IssuedRosterPlayer[];
}

/**
 * Digest over the competitive fields only. Room names, handoff instructions, tokens, and
 * assignment revisions travel with assignments but never change what a tossup is worth, so
 * they are excluded: two snapshots with equal digests describe the same game even if the
 * room or the assignment revision differs.
 */
export function digestGameDefinition(input: DefinitionDigestInput): string {
  return fnv1a64(
    canonicalDefinitionJson({
      rules: input.rules,
      roundId: input.roundId,
      packetId: input.packetId,
      leftTeamId: input.leftTeamId,
      rightTeamId: input.rightTeamId,
      leftRoster: [...input.leftRoster].sort((left, right) =>
        left.playerId < right.playerId ? -1 : left.playerId > right.playerId ? 1 : 0,
      ),
      rightRoster: [...input.rightRoster].sort((left, right) =>
        left.playerId < right.playerId ? -1 : left.playerId > right.playerId ? 1 : 0,
      ),
    }),
  );
}

/** The three rule values answer bucketing actually depends on. */
export interface HistoricalBucketValues {
  superpowerValue?: number;
  powerValue: number;
  tossupValue: number;
}

export interface HistoricalDefinition extends HistoricalBucketValues {
  source: HistoricalDefinitionSource;
  snapshotId?: DirectorId;
  revision?: number;
  digest?: string;
}

/**
 * Derive bucket values from embedded ScoringRules answer-type values (#671 source 3).
 *
 * Standard formats tier distinct positive values tallest-first: three or more positive tiers
 * means a superpower tier above power above get; two means power above get; one means every
 * positive value is a get. Negatives always bucket as negs regardless of magnitude.
 */
export function bucketValuesFromAnswerTypes(values: readonly number[]): HistoricalBucketValues {
  const positive = [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))].sort(
    (left, right) => right - left,
  );
  if (positive.length >= 3) {
    return { superpowerValue: positive[0], powerValue: positive[1]!, tossupValue: positive[2]! };
  }
  if (positive.length === 2) return { powerValue: positive[0]!, tossupValue: positive[1]! };
  if (positive.length === 1) return { powerValue: positive[0]!, tossupValue: positive[0]! };
  return { powerValue: 15, tossupValue: 10 };
}

/**
 * Answer-type values from a QBJ document's own embedded ScoringRules, when it carries one.
 *
 * The single implementation behind ingest resolution and stored-game valuation: the first
 * ScoringRules object carrying values wins. Never a substitute for an issued snapshot.
 */
export function embeddedAnswerValuesFromRawQbj(value: unknown): number[] | undefined {
  const document = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const objects = document && Array.isArray(document.objects) ? document.objects : [];
  for (const object of objects) {
    if (!object || typeof object !== 'object') continue;
    const record = object as Record<string, unknown>;
    if (record.type !== 'ScoringRules' || !Array.isArray(record.answer_types)) continue;
    const values = record.answer_types
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return undefined;
        const answerValue = (entry as Record<string, unknown>).value;
        return typeof answerValue === 'number' && Number.isFinite(answerValue) ? answerValue : undefined;
      })
      .filter((entry): entry is number => entry !== undefined);
    if (values.length > 0) return values;
  }
  return undefined;
}

/** Bucket values from live tournament rules, with the ingest engine's historical fallbacks. */
export function bucketValuesFromRules(rules: TournamentRules | null | undefined): HistoricalBucketValues {
  return {
    ...(typeof rules?.superpowerValue === 'number' ? { superpowerValue: rules.superpowerValue } : {}),
    powerValue: rules?.powerValue ?? 15,
    tossupValue: rules?.tossupValue ?? 10,
  };
}

export interface HistoricalResolutionInput {
  /** Digest echoed by the room, when the returned document carried one. */
  echoedDigest?: string;
  /** Answer-type values from the document's embedded ScoringRules, when present. */
  embeddedAnswerValues?: readonly number[];
}

/**
 * Resolve which scoring truth statistics must use for one scheduled game (#671).
 *
 * Precedence: exact snapshot match, superseded snapshot match, embedded document rules,
 * snapshot fallback, legacy inference, current defaults. Resolution never fails: there is
 * always a triple to bucket with, and the source says how much to trust it. Callers that
 * need enforcement (ingest classification) decide review/reject from the source and the
 * echo, not from this return alone.
 */
export function resolveHistoricalDefinition(
  state: DirectorState,
  scheduledGameId: DirectorId,
  input: HistoricalResolutionInput = {},
): HistoricalDefinition {
  const live = bucketValuesFromRules(state.tournament?.rules);
  const scheduled = state.scheduledGames.find((game) => game.id === scheduledGameId);
  const history = state.gameDefinitions.filter((entry) => entry.scheduledGameId === scheduledGameId);
  const active =
    scheduled?.definitionSnapshotId != null
      ? history.find((entry) => entry.id === scheduled.definitionSnapshotId)
      : history
          .filter((entry) => !entry.supersededById)
          .sort((left, right) => right.revision - left.revision)[0];
  if (input.echoedDigest) {
    const exact = history.find((entry) => entry.digest === input.echoedDigest);
    if (exact && active && exact.id === active.id) {
      return {
        ...bucketValuesFromRules(exact.rules),
        source: 'issued',
        snapshotId: exact.id,
        revision: exact.revision,
        digest: exact.digest,
      };
    }
    if (exact) {
      return {
        ...bucketValuesFromRules(exact.rules),
        source: 'corrected',
        snapshotId: exact.id,
        revision: exact.revision,
        digest: exact.digest,
      };
    }
  }
  if (input.embeddedAnswerValues && input.embeddedAnswerValues.length > 0) {
    return { ...bucketValuesFromAnswerTypes(input.embeddedAnswerValues), source: 'qbj' };
  }
  if (active) {
    // The game was issued, but this result proves nothing about which issue it used: the
    // active snapshot is the best available estimate, and review is mandatory (enforced by
    // the missing/stale/mismatch warnings, never by this return).
    return {
      ...bucketValuesFromRules(active.rules),
      source: 'corrected',
      snapshotId: active.id,
      revision: active.revision,
      digest: active.digest,
    };
  }
  if (!scheduled) return { ...live, source: 'current' };
  const hasHistory = state.games.some((record) => record.scheduledGameId === scheduledGameId);
  return { ...live, source: hasHistory ? 'legacy-inferred' : 'current' };
}

/**
 * The scoring rules a stored game record's statistics were derived under (#671).
 *
 * A record carrying a digest that names one of its game's snapshots resolves to that
 * snapshot's rules; everything else resolves to live tournament rules. Exporters use this
 * so per-game values (player points recomputation, box scores) match the app exactly even
 * after tournament defaults move on.
 */
export function historicalRulesForGame(
  state: DirectorState,
  game: { scheduledGameId: DirectorId; definitionDigest?: string },
): TournamentRules | undefined {
  if (game.definitionDigest) {
    const snapshot = state.gameDefinitions.find(
      (entry) => entry.scheduledGameId === game.scheduledGameId && entry.digest === game.definitionDigest,
    );
    if (snapshot) return snapshot.rules;
  }
  return state.tournament?.rules;
}

interface ScoringValues {
  superpowerValue?: number | null;
  powerValue?: number | null;
  tossupValue?: number | null;
  negValue?: number | null;
}

/**
 * The answer values one stored game record's lines must be valued with (#671).
 *
 * Same precedence as ingest resolution, at the granularity aggregates need: the snapshot the
 * game's digest names, the game's own embedded ScoringRules, live tournament rules. Exporters
 * and report rows use this so per-game values match the app exactly even after defaults move
 * on — and legacy games carrying their rules in raw QBJ stay stable without a snapshot.
 */
export function scoringValuesForGameRecord(
  state: DirectorState,
  game: { scheduledGameId: DirectorId; definitionDigest?: string; rawQbj?: unknown },
): ScoringValues | undefined {
  if (game.definitionDigest) {
    const snapshot = state.gameDefinitions.find(
      (entry) => entry.scheduledGameId === game.scheduledGameId && entry.digest === game.definitionDigest,
    );
    if (snapshot) return snapshot.rules;
  }
  const embedded = embeddedAnswerValuesFromRawQbj(game.rawQbj);
  if (embedded) return bucketValuesFromAnswerTypes(embedded);
  return state.tournament?.rules;
}

/** Active roster as the assignment builder carries it: same membership, same order. */
export function issuedRosterFor(state: DirectorState, teamId: DirectorId): IssuedRosterPlayer[] {
  return state.players
    .filter((player) => player.teamId === teamId && player.active !== false)
    .map((player) => ({
      playerId: player.id,
      name: player.name,
      ...(player.captain ? { captain: true as const } : {}),
    }));
}

export type DefinitionDerivation =
  { ok: true; snapshot: GameDefinitionSnapshot } | { ok: false; reason: string };

/**
 * Derive (but do not persist) the snapshot the current tournament defaults dictate for one
 * scheduled game. The revision continues that game's existing history so pin and reissue
 * share one constructor.
 */
export function deriveDefinitionSnapshot(
  state: DirectorState,
  scheduledGameId: DirectorId,
  at: string = isoNow(),
): DefinitionDerivation {
  const tournament = state.tournament;
  if (!tournament) return { ok: false, reason: 'There is no open tournament.' };
  const scheduled = state.scheduledGames.find((game) => game.id === scheduledGameId);
  if (!scheduled) return { ok: false, reason: 'That scheduled game is no longer in the schedule.' };
  if (scheduled.bye) return { ok: false, reason: 'A bye has no game to score.' };
  if (scheduled.status === 'cancelled') return { ok: false, reason: 'That game is cancelled.' };
  if (!scheduled.rightTeamId) return { ok: false, reason: 'That game has only one team.' };
  const round = state.rounds.find((entry) => entry.id === scheduled.roundId);
  if (!round) return { ok: false, reason: 'That game is not in a round.' };

  const leftRoster = issuedRosterFor(state, scheduled.leftTeamId);
  const rightRoster = issuedRosterFor(state, scheduled.rightTeamId);
  const rules = structuredClone(tournament.rules) as TournamentRules;
  const digest = digestGameDefinition({
    rules,
    roundId: round.id,
    packetId: scheduled.packetId ?? round.packetId ?? null,
    leftTeamId: scheduled.leftTeamId,
    rightTeamId: scheduled.rightTeamId,
    leftRoster,
    rightRoster,
  });
  const revision =
    state.gameDefinitions
      .filter((entry) => entry.scheduledGameId === scheduledGameId)
      .reduce((highest, entry) => Math.max(highest, entry.revision), 0) + 1;
  return {
    ok: true,
    snapshot: {
      id: newDirectorId('game-definition'),
      scheduledGameId: scheduledGameId,
      revision,
      createdAt: at,
      rules,
      roundId: round.id,
      packetId: scheduled.packetId ?? round.packetId ?? null,
      leftTeamId: scheduled.leftTeamId,
      rightTeamId: scheduled.rightTeamId,
      leftRoster,
      rightRoster,
      assignmentRevision: scheduled.assignmentRevision,
      digest,
    },
  };
}

/** The snapshot a scheduled game's refs point at, if it is still present. */
export function activeDefinitionSnapshot(
  state: DirectorState,
  scheduledGameId: DirectorId,
): GameDefinitionSnapshot | undefined {
  const scheduled = state.scheduledGames.find((game) => game.id === scheduledGameId);
  const snapshotId = scheduled?.definitionSnapshotId;
  if (snapshotId) return state.gameDefinitions.find((entry) => entry.id === snapshotId);
  return state.gameDefinitions
    .filter((entry) => entry.scheduledGameId === scheduledGameId && !entry.supersededById)
    .sort((left, right) => right.revision - left.revision)[0];
}

/**
 * Fail-closed snapshot resolution for builders: a game whose refs name a snapshot that is no
 * longer present must not silently fall back to current defaults.
 */
export function resolveDefinitionSnapshot(
  state: DirectorState,
  scheduled: ScheduledGame,
): DefinitionDerivation {
  if (scheduled.definitionRevision === undefined && !scheduled.definitionSnapshotId) {
    return { ok: false, reason: 'That game has no issued definition.' };
  }
  const snapshot = activeDefinitionSnapshot(state, scheduled.id);
  if (!snapshot || (scheduled.definitionSnapshotId && snapshot.id !== scheduled.definitionSnapshotId)) {
    return {
      ok: false,
      reason:
        'That game names an issued definition that is no longer present. ' +
        'Reissue the game before building its assignment.',
    };
  }
  return { ok: true, snapshot };
}

/**
 * The scoring truth builders must use for one scheduled game: the pinned snapshot when the
 * game was issued, else current tournament defaults. Null only when there is no tournament.
 */
export function definitionRulesFor(
  state: DirectorState,
  scheduledGameId: DirectorId,
): TournamentRules | null {
  const scheduled = state.scheduledGames.find((game) => game.id === scheduledGameId);
  if (scheduled && (scheduled.definitionRevision !== undefined || scheduled.definitionSnapshotId)) {
    const snapshot = activeDefinitionSnapshot(state, scheduledGameId);
    if (snapshot) return snapshot.rules;
    return null;
  }
  return state.tournament?.rules ?? null;
}

export interface PinDefinitionsResult {
  pinned: DirectorId[];
  alreadyPinned: DirectorId[];
  failed: Array<{ scheduledGameId: DirectorId; reason: string }>;
}

/**
 * Persist first-issue snapshots for games with none (draft mutator for `commit`).
 *
 * Derives every snapshot from the same draft the assignments were just built from, so the
 * persisted truth always matches the bytes that escaped. Games that already carry refs are
 * left untouched; only genuinely unissued games gain history.
 */
export function pinIssuedDefinitions(
  draft: DirectorState,
  scheduledGameIds: readonly DirectorId[],
  at: string = isoNow(),
): PinDefinitionsResult {
  const result: PinDefinitionsResult = { pinned: [], alreadyPinned: [], failed: [] };
  for (const scheduledGameId of new Set(scheduledGameIds)) {
    const scheduled = draft.scheduledGames.find((game) => game.id === scheduledGameId);
    if (!scheduled) {
      result.failed.push({ scheduledGameId, reason: 'That scheduled game is no longer in the schedule.' });
      continue;
    }
    if (scheduled.definitionRevision !== undefined || scheduled.definitionSnapshotId) {
      result.alreadyPinned.push(scheduledGameId);
      continue;
    }
    // A fresh pin claims "issued now under current defaults". A game that already has scorer
    // history cannot honestly gain that provenance here: its definition needs legacy
    // inference (#671), not a backdated first issue.
    const hasHistory = draft.games.some((record) => record.scheduledGameId === scheduledGameId);
    if (hasHistory) {
      result.failed.push({
        scheduledGameId,
        reason:
          'That game already has scorer results or progress; ' +
          'its definition needs legacy inference, not a fresh pin.',
      });
      continue;
    }
    const derived = deriveDefinitionSnapshot(draft, scheduledGameId, at);
    if (!derived.ok) {
      result.failed.push({ scheduledGameId, reason: derived.reason });
      continue;
    }
    draft.gameDefinitions.push(derived.snapshot);
    scheduled.definitionRevision = derived.snapshot.revision;
    scheduled.definitionSnapshotId = derived.snapshot.id;
    result.pinned.push(scheduledGameId);
  }
  return result;
}

function scorerProgressBlocker(state: DirectorState, scheduled: ScheduledGame): string | null {
  const recordIds = new Set(
    state.games.filter((record) => record.scheduledGameId === scheduled.id).map((record) => record.id),
  );
  const terminal = state.games.some(
    (record) =>
      record.scheduledGameId === scheduled.id &&
      (record.status === 'accepted' ||
        record.status === 'forfeit' ||
        record.status === 'submitted' ||
        record.status === 'live'),
  );
  if (
    terminal ||
    scheduled.status === 'accepted' ||
    scheduled.status === 'submitted' ||
    scheduled.status === 'live'
  ) {
    return 'That game already has scorer progress or a result; its issued definition cannot be replaced.';
  }
  const pendingSubmission = state.submissions.some(
    (submission) =>
      recordIds.has(submission.gameId) &&
      (submission.status === 'received' || submission.status === 'review'),
  );
  if (pendingSubmission) {
    return 'A result is awaiting review; reissue the game only after the review lands.';
  }
  const session = state.qbtcpSessions.find((entry) => entry.matchId === scheduled.id);
  const sessionBlocks =
    session &&
    (session.state === 'result-received' ||
      session.progress !== null ||
      (session.progressSequence !== undefined && session.progressSequence > 0));
  if (sessionBlocks) {
    return 'That game has an active scorer session; use the scorer recovery workflow instead.';
  }
  return null;
}

export type ReissueDefinitionResult =
  { ok: true; snapshot: GameDefinitionSnapshot; created: boolean } | { ok: false; reason: string };

/**
 * Explicit reissue of an issued game's definition (draft mutator for `commit`).
 *
 * Derives the candidate from current defaults, then:
 * - unissued game -> pins revision 1 (same as first issue);
 * - identical digest -> no new revision; the issued truth already matches;
 * - changed digest -> new revision, previous revision marked superseded, assignment revision
 *   bumped so old prepared artifacts read as stale, audit records the replacement.
 *
 * Reissue is refused while the game has scorer progress, a pending result, or an active
 * session: an old artifact already exists and cannot be wished away, and replacing the
 * definition underneath live play would misread the room's game.
 */
/**
 * One-time historical definitions for games that predate pins (#671 migration).
 *
 * A scheduled game with accepted results but no snapshot history gains a revision-1 snapshot
 * derived from current defaults, and each accepted game without definition evidence gains that
 * snapshot's digest marked `legacy-inferred`. Games whose raw QBJ carries embedded ScoringRules
 * are left alone: resolution reads their rules from the immutable document, and pointing them
 * at a current-defaults snapshot would corrupt that. Scheduled-game refs are NOT set — the
 * game was never issued, and claiming otherwise would let future assignments rebuild from an
 * inference instead of failing closed.
 *
 * Idempotent: games that already have snapshots, and accepted games that already carry a
 * digest, are skipped, so a later defaults change never re-infers history.
 */
export function inferLegacyDefinitions(draft: DirectorState, at: string = isoNow()): DirectorId[] {
  const inferred: DirectorId[] = [];
  if (!draft.tournament) return inferred;
  for (const scheduled of draft.scheduledGames) {
    if (draft.gameDefinitions.some((entry) => entry.scheduledGameId === scheduled.id)) continue;
    // Only games with no stronger evidence take the inference. In particular, a game whose
    // raw QBJ carries embedded ScoringRules keeps resolving from the immutable document.
    const targets = draft.games.filter(
      (game) =>
        game.scheduledGameId === scheduled.id &&
        game.status === 'accepted' &&
        !game.definitionDigest &&
        !embeddedAnswerValuesFromRawQbj(game.rawQbj),
    );
    if (targets.length === 0) continue;
    const derived = deriveDefinitionSnapshot(draft, scheduled.id, at);
    if (!derived.ok) continue;
    draft.gameDefinitions.push(derived.snapshot);
    for (const game of targets) {
      game.definitionDigest = derived.snapshot.digest;
      game.definitionRevision = derived.snapshot.revision;
      game.definitionSource = 'legacy-inferred';
    }
    inferred.push(scheduled.id);
  }
  return inferred;
}

/**
 * Stamp accepted games with the issued truth they were scored under (#672).
 *
 * An accepted game that carries no digest and no embedded rules resolves against live
 * tournament defaults — harmless while defaults are frozen, silently reinterpreting
 * history the moment they move. Before a defaults save, every such game gains evidence:
 * the active issued snapshot's digest when the game was issued (`issued`), else the
 * legacy inference path. Idempotent: games that already carry evidence are skipped.
 */
export function pinAcceptedGameEvidence(draft: DirectorState): DirectorId[] {
  const evidencedBefore = new Set(draft.games.filter((game) => game.definitionDigest).map((game) => game.id));
  inferLegacyDefinitions(draft);
  for (const game of draft.games) {
    if (game.status !== 'accepted' && game.status !== 'forfeit') continue;
    if (game.definitionDigest || embeddedAnswerValuesFromRawQbj(game.rawQbj)) continue;
    const snapshot = game.scheduledGameId ? activeDefinitionSnapshot(draft, game.scheduledGameId) : undefined;
    if (!snapshot) continue;
    game.definitionDigest = snapshot.digest;
    game.definitionRevision = snapshot.revision;
    game.definitionSource = 'issued';
  }
  return draft.games
    .filter((game) => game.definitionDigest && !evidencedBefore.has(game.id))
    .map((game) => game.id);
}

export function reissueGameDefinition(
  draft: DirectorState,
  scheduledGameId: DirectorId,
  actor: string,
  at: string = isoNow(),
): ReissueDefinitionResult {
  const scheduled = draft.scheduledGames.find((game) => game.id === scheduledGameId);
  if (!scheduled) return { ok: false, reason: 'That scheduled game is no longer in the schedule.' };
  const progressBlocker = scorerProgressBlocker(draft, scheduled);
  if (progressBlocker) return { ok: false, reason: progressBlocker };
  const active = activeDefinitionSnapshot(draft, scheduledGameId);
  if (!active) {
    const pin = pinIssuedDefinitions(draft, [scheduledGameId], at);
    if (pin.pinned.length === 1) {
      const snapshot = activeDefinitionSnapshot(draft, scheduledGameId);
      if (snapshot) return { ok: true, snapshot, created: true };
    }
    return { ok: false, reason: pin.failed[0]?.reason ?? 'That game cannot be issued.' };
  }
  const candidate = deriveDefinitionSnapshot(draft, scheduledGameId, at);
  if (!candidate.ok) return { ok: false, reason: candidate.reason };
  if (candidate.snapshot.digest === active.digest) {
    return { ok: true, snapshot: active, created: false };
  }
  draft.gameDefinitions.push(candidate.snapshot);
  active.supersededById = candidate.snapshot.id;
  scheduled.definitionRevision = candidate.snapshot.revision;
  scheduled.definitionSnapshotId = candidate.snapshot.id;
  scheduled.assignmentRevision += 1;
  draft.audit.push({
    id: newDirectorId('audit'),
    at,
    actor,
    type: 'definition-reissued',
    summary: `Reissued the competitive definition for the scheduled game as revision ${candidate.snapshot.revision}.`,
    entityId: scheduledGameId,
    details: { revision: candidate.snapshot.revision, digest: candidate.snapshot.digest },
  });
  return { ok: true, snapshot: candidate.snapshot, created: true };
}

/**
 * Whether the game's issued definition still matches current tournament defaults (#672).
 *
 * Derives the candidate the game would be issued under today and compares digests
 * without persisting anything. True means a reissue would be a no-op; false means the
 * game keeps older rules as a normal historical fact; null means the game was never
 * issued (or cannot be derived), so there is nothing to compare.
 */
export function definitionMatchesDefaults(state: DirectorState, scheduledGameId: DirectorId): boolean | null {
  const scheduled = state.scheduledGames.find((game) => game.id === scheduledGameId);
  if (!scheduled || (scheduled.definitionRevision === undefined && !scheduled.definitionSnapshotId)) {
    return null;
  }
  const active = activeDefinitionSnapshot(state, scheduledGameId);
  if (!active) return null;
  const candidate = deriveDefinitionSnapshot(state, scheduledGameId);
  if (!candidate.ok) return null;
  return candidate.snapshot.digest === active.digest;
}

/**
 * Lifecycle buckets for a tournament-defaults save (#672).
 *
 * Saving scoring defaults is prospective: only `unissued` games adopt the new defaults
 * automatically. Every other bucket keeps its pinned or historical truth, and changing
 * those games requires the explicit reissue/correction workflows, never a settings save.
 */
export interface ScoringDefaultsImpact {
  /** No issued definition: adopts new defaults automatically. */
  unissued: DirectorId[];
  /** Issued but unstarted: pinned, keeps existing rules unless explicitly reissued. */
  issuedPinned: DirectorId[];
  /** In progress or awaiting review: never touched by a defaults edit. */
  live: DirectorId[];
  /** Accepted/completed: historical truth, immutable except through recovery. */
  completed: DirectorId[];
}

export function scoringDefaultsImpact(state: DirectorState): ScoringDefaultsImpact {
  const impact: ScoringDefaultsImpact = { unissued: [], issuedPinned: [], live: [], completed: [] };
  for (const scheduled of state.scheduledGames) {
    if (scheduled.bye || scheduled.status === 'cancelled' || !scheduled.rightTeamId) continue;
    const records = state.games.filter((record) => record.scheduledGameId === scheduled.id);
    if (
      scheduled.status === 'accepted' ||
      records.some((record) => record.status === 'accepted' || record.status === 'forfeit')
    ) {
      impact.completed.push(scheduled.id);
      continue;
    }
    const recordIds = new Set(records.map((record) => record.id));
    const hasPendingSubmission = state.submissions.some(
      (submission) =>
        recordIds.has(submission.gameId) &&
        (submission.status === 'received' || submission.status === 'review'),
    );
    const session = state.qbtcpSessions.find((entry) => entry.matchId === scheduled.id);
    const hasSessionProgress =
      session &&
      (session.state === 'result-received' ||
        session.progress !== null ||
        (session.progressSequence !== undefined && session.progressSequence > 0));
    if (
      scheduled.status === 'live' ||
      scheduled.status === 'submitted' ||
      records.some((record) => record.status === 'live' || record.status === 'submitted') ||
      hasPendingSubmission ||
      hasSessionProgress
    ) {
      impact.live.push(scheduled.id);
      continue;
    }
    if (scheduled.definitionRevision !== undefined || scheduled.definitionSnapshotId) {
      impact.issuedPinned.push(scheduled.id);
      continue;
    }
    impact.unissued.push(scheduled.id);
  }
  return impact;
}
