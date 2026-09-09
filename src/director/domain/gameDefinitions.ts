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
