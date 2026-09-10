import {
  isoNow,
  newDirectorId,
  type DirectorId,
  type DirectorState,
  type GameRecord,
  type ScheduledGame,
  type TeamGameScore,
} from './model';
import { advancementBasisToken, latestAdvancementCommit, previewAdvancement } from './advancement';
import { resolveDirectorBracket } from './scheduling';

export interface BracketCorrectionUpdate {
  scheduledGameId: DirectorId;
  leftTeamId: DirectorId;
  rightTeamId: DirectorId;
}

export interface BracketCorrectionPlan {
  updates: BracketCorrectionUpdate[];
  issue?: string;
}

export function winnerAndLoser(
  scores: readonly TeamGameScore[],
  leftTeamId: DirectorId,
  rightTeamId: DirectorId | null,
): { winnerTeamId: DirectorId | null; loserTeamId: DirectorId | null } {
  if (!rightTeamId) return { winnerTeamId: null, loserTeamId: null };
  const left = scores.find((score) => score.teamId === leftTeamId);
  const right = scores.find((score) => score.teamId === rightTeamId);
  if (!left || !right || left.score === right.score) return { winnerTeamId: null, loserTeamId: null };
  return left.score > right.score
    ? { winnerTeamId: leftTeamId, loserTeamId: rightTeamId }
    : { winnerTeamId: rightTeamId, loserTeamId: leftTeamId };
}

export function outcomeForGame(
  game: Pick<GameRecord, 'status' | 'scores' | 'forfeitedTeamId'>,
  scheduled: Pick<ScheduledGame, 'leftTeamId' | 'rightTeamId'>,
): { winnerTeamId: DirectorId | null; loserTeamId: DirectorId | null } {
  if (
    game.status === 'forfeit' &&
    game.forfeitedTeamId &&
    [scheduled.leftTeamId, scheduled.rightTeamId].includes(game.forfeitedTeamId)
  ) {
    const winnerTeamId =
      game.forfeitedTeamId === scheduled.leftTeamId ? scheduled.rightTeamId : scheduled.leftTeamId;
    return { winnerTeamId, loserTeamId: game.forfeitedTeamId };
  }
  return winnerAndLoser(game.scores, scheduled.leftTeamId, scheduled.rightTeamId);
}

function dependentBracketKeys(
  bracket: NonNullable<DirectorState['formats'][number]['bracket']>,
  root: string,
): Set<string> {
  const seen = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const source = pending.shift() as string;
    for (const node of bracket.nodes) {
      if (seen.has(node.key)) continue;
      const dependsOnSource = [node.slotA, node.slotB].some(
        (slot) => slot.kind !== 'seed' && slot.gameKey === source,
      );
      if (!dependsOnSource) continue;
      seen.add(node.key);
      pending.push(node.key);
    }
  }
  return seen;
}

export function bracketCorrectionUpdates(
  state: DirectorState,
  bracket: NonNullable<DirectorState['formats'][number]['bracket']>,
  sourceKey: string,
  after: NonNullable<ReturnType<typeof resolveDirectorBracket>>,
  sourceScheduledGameId: DirectorId,
): BracketCorrectionPlan {
  const updates: BracketCorrectionUpdate[] = [];
  for (const key of dependentBracketKeys(bracket, sourceKey)) {
    const expected = after.games.find((candidate) => candidate.key === key);
    const dependents = state.scheduledGames.filter((candidate) => candidate.bracketKey === key);
    for (const dependent of dependents) {
      if (
        expected?.ready &&
        dependent.leftTeamId === expected.slotA.teamId &&
        dependent.rightTeamId === expected.slotB.teamId
      ) {
        continue;
      }
      if (!expected?.ready) {
        return {
          updates: [],
          issue: `Cannot correct ${sourceScheduledGameId}: dependent bracket game ${dependent.id} is no longer resolvable.`,
        };
      }
      const hasUnresolvedRecord = state.games.some(
        (candidate) =>
          candidate.scheduledGameId === dependent.id &&
          candidate.status !== 'rejected' &&
          candidate.status !== 'cancelled',
      );
      if (dependent.status !== 'scheduled' || hasUnresolvedRecord) {
        return {
          updates: [],
          issue: `Cannot correct ${sourceScheduledGameId}: dependent bracket game ${dependent.id} has already been released or has a result.`,
        };
      }
      updates.push({
        scheduledGameId: dependent.id,
        leftTeamId: expected.slotA.teamId as DirectorId,
        rightTeamId: expected.slotB.teamId as DirectorId,
      });
    }
  }
  return { updates };
}

export function planBracketCorrection(
  state: DirectorState,
  gameId: DirectorId,
  scores: TeamGameScore[],
): BracketCorrectionPlan {
  const game = state.games.find((entry) => entry.id === gameId);
  const scheduled = game
    ? state.scheduledGames.find((entry) => entry.id === game.scheduledGameId)
    : undefined;
  const round = scheduled ? state.rounds.find((entry) => entry.id === scheduled.roundId) : undefined;
  const phase = round ? state.phases.find((entry) => entry.id === round.phaseId) : undefined;
  const format = phase ? state.formats.find((entry) => entry.id === phase.formatId) : undefined;
  if (!game || !scheduled || !format || format.kind !== 'single-elimination' || !scheduled.bracketKey) {
    return { updates: [] };
  }

  const previousOutcome = winnerAndLoser(game.scores, scheduled.leftTeamId, scheduled.rightTeamId);
  const correctedOutcome = winnerAndLoser(scores, scheduled.leftTeamId, scheduled.rightTeamId);
  if (correctedOutcome.winnerTeamId === null || correctedOutcome.loserTeamId === null) {
    return {
      updates: [],
      issue: `Cannot correct ${scheduled.id}: a single-elimination result must remain decisive.`,
    };
  }
  if (
    previousOutcome.winnerTeamId === correctedOutcome.winnerTeamId &&
    previousOutcome.loserTeamId === correctedOutcome.loserTeamId
  ) {
    return { updates: [] };
  }

  const corrected = structuredClone(state);
  const correctedGame = corrected.games.find((entry) => entry.id === gameId);
  if (correctedGame) correctedGame.scores = structuredClone(scores);
  const after = resolveDirectorBracket(corrected, format.id);
  if (!after || !format.bracket) return { updates: [] };

  return bracketCorrectionUpdates(state, format.bracket, scheduled.bracketKey, after, scheduled.id);
}

/** An advancement phase a result correction would invalidate. */
export interface StaleAdvancementImpact {
  phaseId: DirectorId;
  phaseName: string;
  /** The qualifier set itself changes, not just the basis token. */
  qualifiersChange: boolean;
}

export interface ResultCorrectionImpact {
  gameId: DirectorId;
  scheduledGameId: DirectorId;
  /** The game is unknown or not an accepted result: there is nothing to plan against. */
  empty: boolean;
  winnerChanged: boolean;
  staleAdvancement: StaleAdvancementImpact[];
  bracketUpdates: BracketCorrectionUpdate[];
  issue?: string;
}

/**
 * What a score correction would invalidate before it is applied (#673).
 *
 * Pure and side-effect free: simulates the corrected scores on a clone, recomputes
 * every committed advancement basis, and reuses the bracket planner. Callers render
 * this as "correcting this result would invalidate …" and must still run the real
 * correction path, which re-verifies everything at commit.
 */
export function planResultCorrectionImpact(
  state: DirectorState,
  gameId: DirectorId,
  scores: TeamGameScore[],
): ResultCorrectionImpact {
  const empty: ResultCorrectionImpact = {
    gameId,
    scheduledGameId: '',
    empty: true,
    winnerChanged: false,
    staleAdvancement: [],
    bracketUpdates: [],
  };
  const game = state.games.find((entry) => entry.id === gameId);
  if (!game || game.status !== 'accepted') return empty;
  const scheduled = state.scheduledGames.find((entry) => entry.id === game.scheduledGameId);
  if (!scheduled) return empty;

  const previousOutcome = winnerAndLoser(game.scores, scheduled.leftTeamId, scheduled.rightTeamId);
  const correctedOutcome = winnerAndLoser(scores, scheduled.leftTeamId, scheduled.rightTeamId);
  const winnerChanged =
    previousOutcome.winnerTeamId !== correctedOutcome.winnerTeamId ||
    previousOutcome.loserTeamId !== correctedOutcome.loserTeamId;

  const bracket = planBracketCorrection(state, gameId, scores);

  const simulated = structuredClone(state);
  const simulatedGame = simulated.games.find((entry) => entry.id === gameId);
  if (simulatedGame) simulatedGame.scores = structuredClone(scores);
  const staleAdvancement: StaleAdvancementImpact[] = [];
  for (const phase of state.phases) {
    const commit = latestAdvancementCommit(state, phase.id);
    if (!commit) continue;
    if (advancementBasisToken(simulated, phase) === advancementBasisToken(state, phase)) continue;
    const stored = (commit.details as Record<string, unknown> | undefined)?.qualifierTeamIds;
    const beforeIds = Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === 'string')
      : [];
    const afterIds = previewAdvancement(simulated, phase).qualifiers.map((team) => team.id);
    const qualifiersChange =
      beforeIds.length !== afterIds.length || beforeIds.some((id, index) => afterIds[index] !== id);
    staleAdvancement.push({ phaseId: phase.id, phaseName: phase.name, qualifiersChange });
  }

  return {
    gameId,
    scheduledGameId: scheduled.id,
    empty: false,
    winnerChanged,
    staleAdvancement,
    bracketUpdates: bracket.updates,
    ...(bracket.issue ? { issue: bracket.issue } : {}),
  };
}

/** External authority a checkpoint restore invalidates (#673). */
export interface CheckpointRestoreImpact {
  /** Restored sessions rotated to abandoned so old room authority never looks current. */
  abandonedSessionIds: DirectorId[];
  /** Sessions issued after the checkpoint that no longer have authority. */
  invalidatedSessionIds: DirectorId[];
  /** Accepted results newer than the checkpoint; retained in history, not current. */
  supersededResultIds: DirectorId[];
  /** Prepared assignments cut after the checkpoint that must be re-prepared. */
  invalidatedAssignmentIds: DirectorId[];
  /** Transfer artifacts seen after the checkpoint that need re-review. */
  invalidatedArtifactIds: DirectorId[];
}

/**
 * Reconcile a restored checkpoint against the external authority it invalidates (#673).
 *
 * Anything issued, accepted, or prepared after the checkpoint was taken exists
 * in `current` but not in `restored`. Those objects lose their authority: live
 * sessions restored from the checkpoint are rotated to abandoned (old room
 * results must not look current against the restored document), and the newer
 * objects are reported so the caller audits them. Mutates `restored` sessions;
 * returns the impact for the audit trail.
 */
export function reconcileRestoredCheckpoint(
  current: DirectorState,
  restored: DirectorState,
): CheckpointRestoreImpact {
  const impact: CheckpointRestoreImpact = {
    abandonedSessionIds: [],
    invalidatedSessionIds: [],
    supersededResultIds: [],
    invalidatedAssignmentIds: [],
    invalidatedArtifactIds: [],
  };
  const restoredSessionIds = new Set(restored.qbtcpSessions.map((session) => session.sessionId));
  for (const session of current.qbtcpSessions) {
    if (!restoredSessionIds.has(session.sessionId)) impact.invalidatedSessionIds.push(session.sessionId);
  }
  for (const session of restored.qbtcpSessions) {
    if (session.state === 'paired' || session.state === 'assigned' || session.state === 'live') {
      session.state = 'abandoned';
      session.resumable = false;
      session.resultReceived = false;
      session.progress = null;
      impact.abandonedSessionIds.push(session.sessionId);
    }
  }
  const restoredGameIds = new Set(restored.games.map((game) => game.id));
  for (const game of current.games) {
    if (!restoredGameIds.has(game.id) && (game.status === 'accepted' || game.status === 'forfeit')) {
      impact.supersededResultIds.push(game.id);
    }
  }
  const restoredAssignmentIds = new Set(
    (restored.transfers?.assignments ?? []).map((assignment) => assignment.id),
  );
  for (const assignment of current.transfers?.assignments ?? []) {
    if (!restoredAssignmentIds.has(assignment.id)) impact.invalidatedAssignmentIds.push(assignment.id);
  }
  const restoredArtifactIds = new Set((restored.transfers?.artifacts ?? []).map((artifact) => artifact.id));
  for (const artifact of current.transfers?.artifacts ?? []) {
    if (!restoredArtifactIds.has(artifact.id)) impact.invalidatedArtifactIds.push(artifact.id);
  }
  return impact;
}

export function auditCheckpointRestored(
  restored: DirectorState,
  checkpointId: DirectorId,
  impact: CheckpointRestoreImpact,
): void {
  const parts = [
    impact.abandonedSessionIds.length > 0
      ? `${impact.abandonedSessionIds.length} room session(s) rotated to abandoned`
      : null,
    impact.invalidatedSessionIds.length > 0
      ? `${impact.invalidatedSessionIds.length} newer session(s) lost authority`
      : null,
    impact.supersededResultIds.length > 0
      ? `${impact.supersededResultIds.length} newer accepted result(s) superseded`
      : null,
    impact.invalidatedAssignmentIds.length > 0
      ? `${impact.invalidatedAssignmentIds.length} prepared assignment(s) invalidated`
      : null,
    impact.invalidatedArtifactIds.length > 0
      ? `${impact.invalidatedArtifactIds.length} transfer artifact(s) need re-review`
      : null,
  ].filter((part): part is string => part !== null);
  restored.audit.push({
    id: newDirectorId('audit'),
    at: isoNow(),
    actor: 'Director',
    type: 'checkpoint-restored',
    summary:
      parts.length === 0
        ? `Restored recovery point ${checkpointId}. No newer external authority was invalidated.`
        : `Restored recovery point ${checkpointId}. Reconciliation: ${parts.join('; ')}.`,
    entityId: checkpointId,
    details: { checkpointId, ...impact },
  });
}
