/**
 * The one place a returned result becomes a staged result, whatever route it took.
 *
 * # Why this file exists at all
 *
 * Before it, the QBTCP path did its own matching, its own score extraction and its own duplicate
 * check inside the state controller. Adding file handoff next to that would have produced a second
 * implementation of the same three things — and the two would have disagreed within a release,
 * because nothing would have forced them not to. The first disagreement a tournament noticed would
 * have been a result accepted over the network and rejected off a stick, or worse, accepted twice.
 *
 * So `assessIncomingDocument` is transport-independent by construction: it takes a parsed QBJ
 * document and a label saying where it came from, and it has no idea whether that was a socket, a
 * USB stick, a synced folder or a file the director dropped on the window. The QBTCP path calls it.
 * The file paths call it. There is one matching rule, one fingerprint, one duplicate check and one
 * warning vocabulary, and the tests that pin the mixed-transport cases are testing one thing rather
 * than the agreement of two.
 *
 * # Assess, then stage. Never accept.
 *
 * Assessment is a pure function of state and document. Staging mutates a draft to add a submission
 * to the results inbox. Neither of them accepts anything: a result becomes part of the tournament
 * only through `acceptSubmission`, the same path a QBTCP result and a hand-entered paper result
 * take. Inserting a drive is not consent to change the standings.
 */
import {
  isoNow,
  newDirectorId,
  resultDecisionIssue,
  type DirectorId,
  type DirectorState,
  type GameRecord,
  type PlayerGameStat,
  type ResultSubmission,
  type TeamGameScore,
} from '../domain/model';
import { invalidPlayerGameStatCountField, invalidTeamGameScoreCountField, isCanonicalCount } from '../domain';
import {
  activeDefinitionSnapshot,
  embeddedAnswerValuesFromRawQbj,
  resolveHistoricalDefinition,
  type HistoricalBucketValues,
  type HistoricalDefinition,
} from '../domain/gameDefinitions';
import { resultFingerprint } from './canonical';
import { hasScoringContent, matchObject, readQbjIdentity, type QbjIdentity } from './parse';
import {
  maxIncomingArtifacts,
  maxTransferEvents,
  type ArtifactClassification,
  type ArtifactSourceKind,
  type IncomingArtifact,
  type TransferEventKind,
} from './model';

/**
 * Machine-readable reasons, shared with the QBTCP server's vocabulary.
 *
 * `crates/qbtcp-server/src/state.rs` emits `tournament-mismatch`, `missing-tournament-identity`,
 * `missing-match-identity`, `stale-assignment`, `late-after-abandon` and `result-conflict`. Those
 * spellings are reused verbatim where the meaning is the same so that a director reading the
 * results inbox sees one vocabulary rather than two dialects of the same complaint.
 */
export const ingestWarnings = {
  tournamentMismatch: 'tournament-mismatch',
  missingTournamentIdentity: 'missing-tournament-identity',
  missingMatchIdentity: 'missing-match-identity',
  unknownMatch: 'unknown-match',
  matchedByTeams: 'matched-by-teams',
  staleRoundRevision: 'stale-round-revision',
  staleAssignmentRevision: 'stale-assignment-revision',
  missingDefinitionIdentity: 'missing-definition-identity',
  staleDefinitionRevision: 'stale-definition-revision',
  definitionMismatch: 'definition-mismatch',
  correctedDefinitionReview: 'corrected-definition-review',
  resultConflict: 'result-conflict',
  rosterMismatch: 'roster-mismatch',
  cancelledGame: 'cancelled-game',
  alreadyAccepted: 'already-accepted',
  statisticsWarning: 'statistics-warning',
  invalidStatisticCount: 'invalid-statistic-count',
  ambiguousTeamIdentity: 'ambiguous-team-identity',
  unresolvedPlayerIdentity: 'unresolved-player-identity',
  unrecognizedAnswerValue: 'unrecognized-answer-value',
  lateAfterAbandon: 'late-after-abandon',
  transportReviewRequired: 'transport-review-required',
  directorAssociation: 'director-association',
  winnerRequiredTie: 'winner-required-tie',
} as const;

export type IngestWarning = (typeof ingestWarnings)[keyof typeof ingestWarnings];

/** One sentence per reason, in the words the Transfers and Results tables show. */
export function describeWarning(code: string): string {
  switch (code) {
    case ingestWarnings.tournamentMismatch:
      return 'The file is from a different tournament.';
    case ingestWarnings.missingTournamentIdentity:
      return 'The file names no tournament.';
    case ingestWarnings.missingMatchIdentity:
      return 'The file names no match.';
    case ingestWarnings.unknownMatch:
      return 'No scheduled game has this match ID.';
    case ingestWarnings.matchedByTeams:
      return 'Matched by the two teams rather than by match ID.';
    case ingestWarnings.staleRoundRevision:
      return 'Scored from an older revision of this round.';
    case ingestWarnings.staleAssignmentRevision:
      return 'Scored from an older issue of this assignment.';
    case ingestWarnings.missingDefinitionIdentity:
      return 'The result does not say which issued competitive definition it was scored under.';
    case ingestWarnings.staleDefinitionRevision:
      return 'Scored under a superseded issue of this game’s competitive definition.';
    case ingestWarnings.definitionMismatch:
      return 'Scored under a competitive definition Director never issued for this game.';
    case ingestWarnings.correctedDefinitionReview:
      return 'Scored under a room-corrected definition that needs Director review.';
    case ingestWarnings.resultConflict:
      return 'A different result already exists for this game.';
    case ingestWarnings.rosterMismatch:
      return 'The teams do not match the current assignment.';
    case ingestWarnings.cancelledGame:
      return 'This game was cancelled.';
    case ingestWarnings.alreadyAccepted:
      return 'This game already has an accepted result.';
    case ingestWarnings.statisticsWarning:
      return 'The statistics did not validate cleanly.';
    case ingestWarnings.invalidStatisticCount:
      return 'A statistic count was not a finite non-negative whole number.';
    case ingestWarnings.ambiguousTeamIdentity:
      return 'A team name matches more than one roster entry.';
    case ingestWarnings.unresolvedPlayerIdentity:
      return 'A player in the scoresheet could not be matched to exactly one roster entry.';
    case ingestWarnings.unrecognizedAnswerValue:
      return 'The file scores a point value these tournament rules do not name; points kept, detail unclassified.';
    case ingestWarnings.lateAfterAbandon:
      return 'The room had been marked abandoned when this arrived.';
    case ingestWarnings.transportReviewRequired:
      return 'The transport flagged this result for review.';
    case ingestWarnings.directorAssociation:
      return 'A director explicitly associated this result with the selected scheduled game; verify the matchup before accepting it.';
    case ingestWarnings.winnerRequiredTie:
      return 'This final is tied but the format requires a winner; finish any required overtime and enter a decisive score, or record an explicit administrative forfeit before accepting it.';
    default:
      return code;
  }
}

/** A document that arrived, with everything the pipeline needs and nothing about how it arrived. */
export interface IncomingDocument {
  sourceKind: ArtifactSourceKind;
  /** What a person calls the source: "SanDisk Ultra", "Quiz Bowl Exchange", "Room 101". */
  sourceLabel: string;
  fileName: string;
  originalPath?: string;
  byteLength: number;
  /** Identity of these exact bytes, so the same file is not read twice off the same drive. */
  digest: string;
  qbj: unknown;
  /** The transport's own result id, kept for correlation with its log. Never used for matching. */
  transportResultId?: string;
  sessionId?: string;
  /** Warnings the transport raised on its own terms; folded into this vocabulary. */
  transportWarnings?: string[];
  /** Optional identity carried by the transport when the QBJ itself does not contain it. */
  transportTournamentId?: string;
  transportMatchId?: string;
  /** An explicit assignment identity must not fall back to a weaker match/team guess. */
  scheduledGameId?: DirectorId;
  transportReviewRequired?: boolean;
}

export interface ResultAssessment {
  classification: ArtifactClassification;
  warnings: string[];
  /** One sentence for the director. Always populated. */
  detail: string;
  fingerprint: string;
  identity: QbjIdentity;
  scheduledGameId?: DirectorId;
  scores: TeamGameScore[];
  playerStats: PlayerGameStat[];
  /**
   * Which scoring truth the statistics above were derived under (#671). Present whenever
   * statistics were derived; absent on early returns that derive none.
   */
  definition?: HistoricalDefinition;
  /** The submission this repeats, when it repeats one. */
  duplicateOfSubmissionId?: DirectorId;
  /** The submission this disagrees with, when it disagrees with one. */
  conflictWithSubmissionId?: DirectorId;
  /** The game record the duplicate or conflict refers to. */
  existingGameId?: DirectorId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function namedIdentity(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.$ref === 'string') return value.$ref;
  if (typeof value.id === 'string') return value.id;
  return typeof value.name === 'string' ? value.name : undefined;
}

function namedValue(value: unknown): string | undefined {
  return isRecord(value) && typeof value.name === 'string' ? value.name : undefined;
}

/**
 * Which Director team a `match_teams` entry refers to.
 *
 * Identifiers first, because an assignment Director wrote carries Director's own team ids and the
 * lookup is then exact. A name match is the fallback for a document produced by another tool, and
 * it is deliberately last: two teams from the same school can share most of a name.
 */
function resultTeamId(
  value: unknown,
  state: DirectorState,
  scheduled: DirectorState['scheduledGames'][number] | undefined,
  warnings: string[] = [],
): string | undefined {
  const identity = namedIdentity(value);
  const candidates = [scheduled?.leftTeamId, scheduled?.rightTeamId].filter((entry): entry is string =>
    Boolean(entry),
  );
  if (identity && candidates.includes(identity)) return identity;
  const teams = state.teams.filter(
    (entry) =>
      entry.id === identity || entry.displayName.toLocaleLowerCase() === identity?.toLocaleLowerCase(),
  );
  if (teams.length > 1 && identity) {
    warnings.push(ingestWarnings.ambiguousTeamIdentity);
  }
  return teams.length === 1 ? teams[0]?.id : undefined;
}

/**
 * Answer-type values from the document's own embedded ScoringRules, when it carries one.
 * Used only to resolve which historical truth a result was scored under (#671 source 3);
 * never as a substitute for an issued snapshot. Implemented in the domain module so stored
 * games resolve through the same extractor.
 */
function embeddedAnswerValues(value: unknown): number[] | undefined {
  return embeddedAnswerValuesFromRawQbj(value);
}

function answerAggregate(
  counts: unknown,
  rules: HistoricalBucketValues,
  warnings: string[] = [],
): { superpowers: number; powers: number; gets: number; negs: number; tossupPoints: number } {
  let superpowers = 0;
  let powers = 0;
  let gets = 0;
  let negs = 0;
  let tossupPoints = 0;
  if (!Array.isArray(counts)) return { superpowers, powers, gets, negs, tossupPoints };
  for (const count of counts) {
    if (!isRecord(count)) continue;
    const value = isRecord(count.answer_type) ? finiteNumber(count.answer_type.value) : undefined;
    if (count.number === undefined) continue;
    if (!isCanonicalCount(count.number)) {
      warnings.push(ingestWarnings.invalidStatisticCount);
      continue;
    }
    const number = count.number;
    if (value === undefined || number === 0) continue;
    // Points always reconcile from the document's own values, even for an
    // answer type the tournament rules do not name. Bucketing is where the
    // rules matter — and an unmapped value is a warning, never a silent drop.
    tossupPoints += value * number;
    if (value === (rules.superpowerValue ?? Number.NaN)) superpowers += number;
    else if (value === rules.powerValue) powers += number;
    else if (value === rules.tossupValue) gets += number;
    else if (value < 0) negs += number;
    else warnings.push(ingestWarnings.unrecognizedAnswerValue);
  }
  return { superpowers, powers, gets, negs, tossupPoints };
}

function teamAggregate(
  entry: Record<string, unknown>,
  rules: HistoricalBucketValues,
  warnings: string[] = [],
): Omit<TeamGameScore, 'teamId' | 'score'> {
  let superpowers = 0;
  let powers = 0;
  let gets = 0;
  let negs = 0;
  let tossupPoints = 0;
  if (Array.isArray(entry.match_players)) {
    for (const candidate of entry.match_players) {
      if (!isRecord(candidate)) continue;
      const aggregate = answerAggregate(candidate.answer_counts, rules, warnings);
      superpowers += aggregate.superpowers;
      powers += aggregate.powers;
      gets += aggregate.gets;
      negs += aggregate.negs;
      tossupPoints += aggregate.tossupPoints;
    }
  }
  // A QBJ team without bonus_bounceback_points supplied no bounceback breakdown: the
  // residual bonus-points estimate cannot subtract what was never reported (#748).
  const bouncebacks = finiteNumber(entry.bonus_bounceback_points) ?? null;
  const lightning = finiteNumber(entry.lightning_points) ?? 0;
  const points = finiteNumber(entry.points) ?? tossupPoints;
  return {
    superpowers,
    powers,
    gets,
    negs,
    bonuses: finiteNumber(entry.bonuses_heard) ?? finiteNumber(entry.bonuses) ?? 0,
    bonusPoints:
      finiteNumber(entry.bonus_points) ?? points - tossupPoints - (bouncebacks ?? 0) - lightning,
    bouncebacks,
  };
}

/**
 * The statistical content of a result document.
 *
 * Moved here out of the state controller, where it was reachable only from the QBTCP path. A USB
 * result and a QBTCP result now produce their scores through the same function, which is the point
 * of the whole file.
 */
export function readResultStatistics(
  value: unknown,
  state: DirectorState,
  scheduled: DirectorState['scheduledGames'][number] | undefined,
): {
  scores: TeamGameScore[];
  playerStats: PlayerGameStat[];
  warnings: string[];
  definition: HistoricalDefinition;
} {
  const warnings: string[] = [];
  // Which scoring truth this document was scored under (#671). The echo and the embedded
  // rules come from the document itself; snapshots come from state. Every bucket below uses
  // this triple, never live tournament rules directly.
  const identity = readQbjIdentity(value);
  const definition = resolveHistoricalDefinition(state, scheduled?.id ?? '', {
    ...(identity.definitionDigest ? { echoedDigest: identity.definitionDigest } : {}),
    ...(embeddedAnswerValues(value) ? { embeddedAnswerValues: embeddedAnswerValues(value) } : {}),
  });
  const match = matchObject(value);
  const entries = Array.isArray(match?.match_teams) ? match.match_teams : [];
  const scores = entries
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const teamId = resultTeamId(entry.team, state, scheduled, warnings);
      const score = finiteNumber(entry.points);
      if (!teamId || score === undefined) return null;
      const candidate = { teamId, score, ...teamAggregate(entry, definition, warnings) };
      if (invalidTeamGameScoreCountField(candidate)) warnings.push(ingestWarnings.invalidStatisticCount);
      return candidate;
    })
    .filter((entry): entry is TeamGameScore => entry !== null);
  const playerStats = entries.flatMap((entry): PlayerGameStat[] => {
    if (!isRecord(entry)) return [];
    const teamId = resultTeamId(entry.team, state, scheduled, warnings);
    if (!teamId || !Array.isArray(entry.match_players)) return [];
    return entry.match_players.flatMap((candidate): PlayerGameStat[] => {
      if (!isRecord(candidate)) return [];
      const playerName = namedValue(candidate.player) ?? namedIdentity(candidate.player);
      const players = state.players.filter(
        (record) =>
          record.teamId === teamId &&
          (record.id === playerName || record.name.toLocaleLowerCase() === playerName?.toLocaleLowerCase()),
      );
      if (players.length !== 1) {
        warnings.push(ingestWarnings.unresolvedPlayerIdentity);
        return [];
      }
      const [player] = players;
      const aggregate = answerAggregate(candidate.answer_counts, definition, warnings);
      const stat = {
        playerId: player.id,
        teamId,
        superpowers: aggregate.superpowers,
        powers: aggregate.powers,
        gets: aggregate.gets,
        negs: aggregate.negs,
        bonusPoints: finiteNumber(candidate.bonus_points) ?? 0,
        tossupsHeard:
          finiteNumber(candidate.tossups_heard) ??
          aggregate.superpowers + aggregate.powers + aggregate.gets + aggregate.negs,
      };
      if (invalidPlayerGameStatCountField(stat)) warnings.push(ingestWarnings.invalidStatisticCount);
      return [stat];
    });
  });
  return { scores, playerStats, warnings, definition };
}

/**
 * Re-read a result after a director has selected its scheduled game.
 *
 * Most files carry stable team ids or names and are already fully understood by
 * `readResultStatistics`. A result from an older/offline scorer can instead carry two opaque team
 * references. Once a director explicitly chooses the game, using the two result entries' existing
 * left/right order is the safest available interpretation. It remains a review warning, and the
 * result still needs a separate acceptance click.
 */
export function readResultStatisticsForAssociation(
  value: unknown,
  state: DirectorState,
  scheduled: DirectorState['scheduledGames'][number] | undefined,
): {
  scores: TeamGameScore[];
  playerStats: PlayerGameStat[];
  warnings: string[];
  definition: HistoricalDefinition;
  positionalAssociation: boolean;
} {
  const direct = readResultStatistics(value, state, scheduled);
  if (!scheduled?.rightTeamId || direct.scores.length >= 2) {
    return { ...direct, positionalAssociation: false };
  }
  const match = matchObject(value);
  const entries = Array.isArray(match?.match_teams) ? match.match_teams : [];
  if (entries.length !== 2) return { ...direct, positionalAssociation: false };
  try {
    const remapped = structuredClone(value);
    const remappedMatch = matchObject(remapped);
    if (!remappedMatch || !Array.isArray(remappedMatch.match_teams))
      return { ...direct, positionalAssociation: false };
    const teamIds = [scheduled.leftTeamId, scheduled.rightTeamId];
    remappedMatch.match_teams.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      const teamId = teamIds[index];
      if (teamId) entry.team = { $ref: teamId };
    });
    const reassociated = readResultStatistics(remapped, state, scheduled);
    if (reassociated.scores.length < 2) return { ...direct, positionalAssociation: false };
    return {
      ...reassociated,
      warnings: [
        ...new Set([...direct.warnings, ...reassociated.warnings, ingestWarnings.directorAssociation]),
      ],
      positionalAssociation: true,
    };
  } catch {
    return { ...direct, positionalAssociation: false };
  }
}

/**
 * Find the scheduled game a document is about.
 *
 * Match id first, because that is the identity an assignment preserves and the reason reconciliation
 * is a lookup rather than a guess. Then the match id of a result already recorded, which catches a
 * second copy of a result whose room re-identified the match. Only then the two teams within a
 * round, which is how a document from a tool that assigned its own ids can still land — and which
 * is always flagged, because "these are the same two teams" is a weaker claim than "this is that
 * game" and a director should see which one Director used.
 */
function findScheduledGame(
  state: DirectorState,
  identity: QbjIdentity,
  qbj: unknown,
): { scheduled?: DirectorState['scheduledGames'][number]; matchedByTeams: boolean } {
  if (identity.matchId) {
    const direct = state.scheduledGames.find((game) => game.id === identity.matchId);
    if (direct) return { scheduled: direct, matchedByTeams: false };
    const recorded = state.games.find(
      (game) => game.rawQbj && readQbjIdentity(game.rawQbj).matchId === identity.matchId,
    );
    const scheduled = recorded
      ? state.scheduledGames.find((game) => game.id === recorded.scheduledGameId)
      : undefined;
    if (scheduled) return { scheduled, matchedByTeams: false };
  }
  const match = matchObject(qbj);
  const teamIdentities = (Array.isArray(match?.match_teams) ? match.match_teams : [])
    .map((entry) => (isRecord(entry) ? namedIdentity(entry.team) : undefined))
    .filter((entry): entry is string => Boolean(entry));
  if (teamIdentities.length !== 2) return { matchedByTeams: false };
  const teamIds = teamIdentities.map(
    (candidate) =>
      state.teams.find(
        (team) =>
          team.id === candidate || team.displayName.toLocaleLowerCase() === candidate.toLocaleLowerCase(),
      )?.id,
  );
  if (teamIds.some((entry) => !entry)) return { matchedByTeams: false };
  const [first, second] = teamIds as [string, string];
  const candidates = state.scheduledGames.filter(
    (game) =>
      game.status !== 'cancelled' &&
      ((game.leftTeamId === first && game.rightTeamId === second) ||
        (game.leftTeamId === second && game.rightTeamId === first)),
  );
  const unresolved = candidates.filter((game) => game.status !== 'accepted');
  const chosen =
    unresolved.length === 1 ? unresolved[0] : candidates.length === 1 ? candidates[0] : undefined;
  return chosen ? { scheduled: chosen, matchedByTeams: true } : { matchedByTeams: false };
}

/**
 * Which revisions the current schedule is at for a game.
 *
 * The comparison that makes a stale file detectable. A room that was handed round 5 before the
 * bracket was redrawn returns a document carrying revision 2 against a round now at revision 3, and
 * that difference is the only thing distinguishing it from a current result.
 */
function currentRevisions(
  state: DirectorState,
  scheduled: DirectorState['scheduledGames'][number] | undefined,
): { roundRevision?: number; assignmentRevision?: number } {
  if (!scheduled) return {};
  const round = state.rounds.find((entry) => entry.id === scheduled.roundId);
  return {
    ...(round ? { roundRevision: round.revision } : {}),
    assignmentRevision: scheduled.assignmentRevision,
  };
}

/** Translate a transport's own warning spelling into this vocabulary. */
function foldTransportWarning(code: string): string {
  switch (code) {
    case 'stale-assignment':
      return ingestWarnings.staleRoundRevision;
    case 'match-mismatch':
      return ingestWarnings.unknownMatch;
    default:
      return code;
  }
}

/**
 * Decide what a document is, without changing anything.
 *
 * Pure, so the mixed-transport cases can be tested as a table rather than by driving a UI, and so
 * the same call can preview a drop before the director commits to importing it.
 */
export function assessIncomingDocument(state: DirectorState, document: IncomingDocument): ResultAssessment {
  const parsedIdentity = readQbjIdentity(document.qbj);
  const identity: QbjIdentity = {
    ...parsedIdentity,
    ...(document.transportTournamentId ? { tournamentId: document.transportTournamentId } : {}),
    ...(document.transportMatchId ? { matchId: document.transportMatchId } : {}),
  };
  const fingerprint = resultFingerprint(document.qbj);
  const warnings = new Set<string>((document.transportWarnings ?? []).map(foldTransportWarning));
  if (document.transportReviewRequired) warnings.add(ingestWarnings.transportReviewRequired);
  const match = matchObject(document.qbj);

  if (!match) {
    return {
      classification: 'not-a-result',
      warnings: [...warnings],
      detail: 'The file contains no QBJ match.',
      fingerprint,
      identity,
      scores: [],
      playerStats: [],
    };
  }

  const explicitScheduledGameId = document.scheduledGameId?.trim();
  const { scheduled, matchedByTeams } = explicitScheduledGameId
    ? {
        scheduled: state.scheduledGames.find((game) => game.id === explicitScheduledGameId),
        matchedByTeams: false,
      }
    : findScheduledGame(state, identity, document.qbj);
  const scored = hasScoringContent(document.qbj);

  if (!scored) {
    return {
      classification: 'assignment',
      warnings: [...warnings],
      detail: scheduled
        ? 'This is an unplayed assignment, not a result. It was not imported as a game.'
        : 'This is an unplayed assignment file. It was not imported as a game.',
      fingerprint,
      identity,
      ...(scheduled ? { scheduledGameId: scheduled.id } : {}),
      scores: [],
      playerStats: [],
    };
  }

  if (!identity.tournamentId) warnings.add(ingestWarnings.missingTournamentIdentity);
  else if (state.tournament && identity.tournamentId !== state.tournament.id)
    warnings.add(ingestWarnings.tournamentMismatch);
  if (!identity.matchId) warnings.add(ingestWarnings.missingMatchIdentity);
  if (matchedByTeams) warnings.add(ingestWarnings.matchedByTeams);
  if (!scheduled) warnings.add(ingestWarnings.unknownMatch);

  const revisions = currentRevisions(state, scheduled);
  if (
    identity.roundRevision !== undefined &&
    revisions.roundRevision !== undefined &&
    identity.roundRevision < revisions.roundRevision
  )
    warnings.add(ingestWarnings.staleRoundRevision);
  if (
    identity.assignmentRevision !== undefined &&
    revisions.assignmentRevision !== undefined &&
    identity.assignmentRevision < revisions.assignmentRevision
  )
    warnings.add(ingestWarnings.staleAssignmentRevision);
  // Definition comparison runs before any statistics derivation below: a pairing can be
  // current while the scoring truth differs, so match/round/assignment identity matching
  // alone must never classify a result as current. Any warning here forces needs-review
  // through the classification below.
  const expectedDefinition = scheduled ? activeDefinitionSnapshot(state, scheduled.id) : undefined;
  if (scheduled && expectedDefinition) {
    if (!identity.definitionDigest) {
      // No identity to compare. QBSheet-produced results always echo one; generic third-party
      // QBJ never does. Both stay importable, neither is silently equivalent: #671 proves
      // embedded-rules equivalence for the generic path, until then review decides.
      warnings.add(ingestWarnings.missingDefinitionIdentity);
    } else if (identity.definitionDigest === expectedDefinition.digest) {
      // Exact digest match is the proof; the echoed revision number is informational.
    } else if (
      state.gameDefinitions.some(
        (entry) => entry.scheduledGameId === scheduled.id && entry.digest === identity.definitionDigest,
      )
    ) {
      warnings.add(ingestWarnings.staleDefinitionRevision);
    } else {
      warnings.add(ingestWarnings.definitionMismatch);
    }
  }
  if (scheduled?.status === 'cancelled') warnings.add(ingestWarnings.cancelledGame);

  // Identity rejections (#671). A rejected file is recorded as a failed artifact and is never
  // staged, and `alreadySeen` skips it on every later scan — which is the enforcement the
  // filesystem port allows: the port contract forbids delete/move, so "deleted from the
  // drive" is implemented as "recorded failed and never re-scanned".
  if (scheduled && expectedDefinition && matchedByTeams && !identity.definitionDigest) {
    // Weak team-only match against a game whose truth was issued: without an echo there is no
    // way to prove which issue the room used, and guessing would misread history.
    return {
      classification: 'invalid',
      warnings: [...warnings, ingestWarnings.missingDefinitionIdentity],
      detail:
        'This result only matches by team names, but the game was issued under a pinned ' +
        'competitive definition the result does not name. It was not imported.',
      fingerprint,
      identity,
      scheduledGameId: scheduled.id,
      scores: [],
      playerStats: [],
    };
  }
  if (
    scheduled &&
    expectedDefinition &&
    identity.definitionRevision !== undefined &&
    identity.definitionRevision > expectedDefinition.revision
  ) {
    // The room claims a newer issue than Director ever issued: this result belongs to a
    // future Director does not have (usually a rewound restore). Accepting it would graft a
    // game from a lost timeline onto current standings.
    return {
      classification: 'invalid',
      warnings: [...warnings, ingestWarnings.definitionMismatch],
      detail:
        'This result claims a competitive-definition revision newer than anything issued ' +
        'for this game. It was not imported.',
      fingerprint,
      identity,
      scheduledGameId: scheduled.id,
      scores: [],
      playerStats: [],
    };
  }

  const statistics = readResultStatistics(document.qbj, state, scheduled);
  for (const warning of statistics.warnings) warnings.add(warning);
  if (scheduled && statistics.scores.length === 2) {
    const expected = new Set([scheduled.leftTeamId, scheduled.rightTeamId].filter(Boolean));
    if (statistics.scores.some((score) => !expected.has(score.teamId)))
      warnings.add(ingestWarnings.rosterMismatch);
  }
  if (statistics.scores.length < 2) warnings.add(ingestWarnings.statisticsWarning);
  if (
    scheduled &&
    statistics.scores.length === 2 &&
    resultDecisionIssue(state, scheduled, statistics.scores)
  ) {
    warnings.add(ingestWarnings.winnerRequiredTie);
  }

  // Duplicate and conflict are the same question asked of the same set of prior submissions: does
  // Director already hold a result for this game, and does it say the same thing? Fingerprints are
  // computed here for both sides, never taken from a transport, so the two are comparable.
  const priorForGame = scheduled
    ? state.submissions.filter((submission) => {
        if (submission.status === 'rejected') return false;
        const game = state.games.find((entry) => entry.id === submission.gameId);
        return game?.scheduledGameId === scheduled.id;
      })
    : [];
  const duplicate = priorForGame.find((submission) => submission.fingerprint === fingerprint);
  if (duplicate) {
    return {
      classification: 'duplicate',
      warnings: [...warnings],
      detail: 'Director already has this exact result.',
      fingerprint,
      identity,
      ...(scheduled ? { scheduledGameId: scheduled.id } : {}),
      scores: statistics.scores,
      playerStats: statistics.playerStats,
      definition: statistics.definition,
      duplicateOfSubmissionId: duplicate.id,
      existingGameId: duplicate.gameId,
    };
  }
  const conflict = priorForGame.find((submission) => submission.fingerprint !== fingerprint);
  if (conflict) warnings.add(ingestWarnings.resultConflict);
  if (scheduled?.status === 'accepted' && !conflict) warnings.add(ingestWarnings.alreadyAccepted);

  const classification: ArtifactClassification = warnings.size > 0 ? 'needs-review' : 'ready';
  return {
    classification,
    warnings: [...warnings],
    detail:
      classification === 'ready'
        ? 'Matched current assignment.'
        : [...warnings].map(describeWarning).join(' '),
    fingerprint,
    identity,
    ...(scheduled ? { scheduledGameId: scheduled.id } : {}),
    scores: statistics.scores,
    playerStats: statistics.playerStats,
    definition: statistics.definition,
    ...(conflict ? { conflictWithSubmissionId: conflict.id, existingGameId: conflict.gameId } : {}),
  };
}

export interface StageOutcome {
  artifact: IncomingArtifact;
  submissionId?: DirectorId;
  gameId?: DirectorId;
}

export function recordTransferEvent(
  draft: DirectorState,
  event: {
    kind: TransferEventKind;
    summary: string;
    locationId?: DirectorId;
    count?: number;
    detail?: string;
  },
): void {
  draft.transfers.events.unshift({
    id: newDirectorId('transfer-event'),
    at: isoNow(),
    kind: event.kind,
    summary: event.summary,
    ...(event.locationId ? { locationId: event.locationId } : {}),
    ...(event.count === undefined ? {} : { count: event.count }),
    ...(event.detail ? { detail: event.detail } : {}),
  });
  if (draft.transfers.events.length > maxTransferEvents) draft.transfers.events.length = maxTransferEvents;
}

/**
 * Whether this exact file has been seen before.
 *
 * Digest rather than fingerprint, and path rather than name: the question is "did Director already
 * read this file off this drive", which is what stops a re-scan of a drive that has been plugged in
 * four times from staging the same four results four times each.
 */
export function alreadySeen(
  state: DirectorState,
  digest: string,
  originalPath?: string,
): IncomingArtifact | undefined {
  return state.transfers.artifacts.find((artifact) => {
    if (artifact.digest !== digest) return false;
    // When both sides know where the file came from, the path has to agree too: the same result
    // copied into both the drive's root and its Results folder is two files a director may well
    // want to see accounted for, and the fingerprint check downstream will call the second a
    // duplicate anyway. When either side has no path — a dropped file, a browser download — the
    // digest is all there is, and it is enough.
    if (originalPath === undefined || artifact.originalPath === undefined) return true;
    return artifact.originalPath === originalPath;
  });
}

/**
 * Put a result into the results inbox.
 *
 * Everything staged here lands as a `ResultSubmission` in `received` or `review`, which is exactly
 * where a QBTCP result lands and exactly where a hand-entered paper result lands. There is no
 * transport that can put a game into the standings; only a director can.
 */
export function stageIncomingDocument(
  draft: DirectorState,
  document: IncomingDocument,
  assessment: ResultAssessment,
): StageOutcome {
  const now = isoNow();
  const artifact: IncomingArtifact = {
    id: newDirectorId('artifact'),
    sourceKind: document.sourceKind,
    sourceLabel: document.sourceLabel,
    ...(document.originalPath ? { originalPath: document.originalPath } : {}),
    fileName: document.fileName,
    byteLength: document.byteLength,
    digest: document.digest,
    detectedAt: now,
    ...(assessment.identity.tournamentId ? { parsedTournamentId: assessment.identity.tournamentId } : {}),
    ...(assessment.identity.matchId ? { parsedMatchId: assessment.identity.matchId } : {}),
    ...(assessment.identity.roundRevision === undefined
      ? {}
      : { roundRevision: assessment.identity.roundRevision }),
    ...(assessment.identity.assignmentRevision === undefined
      ? {}
      : { assignmentRevision: assessment.identity.assignmentRevision }),
    ...(assessment.identity.definitionRevision === undefined
      ? {}
      : { definitionRevision: assessment.identity.definitionRevision }),
    ...(assessment.identity.definitionDigest === undefined
      ? {}
      : { definitionDigest: assessment.identity.definitionDigest }),
    classification: assessment.classification,
    warnings: assessment.warnings,
    status: 'detected',
    ...(assessment.scheduledGameId ? { scheduledGameId: assessment.scheduledGameId } : {}),
    detail: assessment.detail,
  };

  if (assessment.classification === 'duplicate') {
    artifact.status = 'ignored';
    // A duplicate is recorded rather than dropped, because "the USB copy of room 101 arrived and
    // agreed" is something a director wants to be able to see. It creates no second game.
    draft.submissions.push({
      id: newDirectorId('submission'),
      gameId: assessment.existingGameId ?? '',
      ...(document.transportResultId ? { transportResultId: document.transportResultId } : {}),
      ...(document.sessionId ? { sessionId: document.sessionId } : {}),
      receivedAt: now,
      fingerprint: assessment.fingerprint,
      status: 'duplicate',
      ...(assessment.identity.definitionRevision === undefined
        ? {}
        : { definitionRevision: assessment.identity.definitionRevision }),
      ...(assessment.identity.definitionDigest === undefined
        ? {}
        : { definitionDigest: assessment.identity.definitionDigest }),
      rawSubmission: { source: document.sourceKind, fileName: document.fileName, qbj: document.qbj },
      warnings: assessment.warnings,
      reason: `Backup copy from ${document.sourceLabel} matches the existing result.`,
      supersedesSubmissionId: assessment.duplicateOfSubmissionId,
    });
    recordTransferEvent(draft, {
      kind: 'duplicate-detected',
      summary: `Duplicate result from ${document.sourceLabel}`,
      detail: document.fileName,
    });
    pushArtifact(draft, artifact);
    return { artifact };
  }

  if (assessment.classification !== 'ready' && assessment.classification !== 'needs-review') {
    artifact.status = assessment.classification === 'invalid' ? 'failed' : 'ignored';
    pushArtifact(draft, artifact);
    return { artifact };
  }

  const gameId = newDirectorId('game-record');
  const game: GameRecord = {
    id: gameId,
    scheduledGameId: assessment.scheduledGameId ?? assessment.identity.matchId ?? `unmatched-${artifact.id}`,
    roundId:
      draft.scheduledGames.find((entry) => entry.id === assessment.scheduledGameId)?.roundId ??
      'unmatched-round',
    packetId: draft.scheduledGames.find((entry) => entry.id === assessment.scheduledGameId)?.packetId ?? null,
    status: 'submitted',
    scores: assessment.scores,
    playerStats: assessment.playerStats,
    source: document.sourceKind === 'qbtcp' ? 'qbtcp' : 'qbj',
    ...(document.transportResultId ? { transportResultId: document.transportResultId } : {}),
    // Provenance echoed by the room; absent on legacy/generic documents (#670). Statistics
    // resolution under the right definition arrives with #671.
    ...(assessment.identity.definitionRevision === undefined
      ? {}
      : { definitionRevision: assessment.identity.definitionRevision }),
    ...(assessment.identity.definitionDigest === undefined
      ? {}
      : { definitionDigest: assessment.identity.definitionDigest }),
    ...(assessment.definition ? { definitionSource: assessment.definition.source } : {}),
    ...(assessment.definition ? { definitionSource: assessment.definition.source } : {}),
    rawQbj: document.qbj,
    finishedAt: now,
  };
  draft.games.push(game);

  const submission: ResultSubmission = {
    id: newDirectorId('submission'),
    gameId,
    ...(document.transportResultId ? { transportResultId: document.transportResultId } : {}),
    ...(document.sessionId ? { sessionId: document.sessionId } : {}),
    receivedAt: now,
    fingerprint: assessment.fingerprint,
    status: assessment.classification === 'ready' ? 'received' : 'review',
    ...(assessment.identity.definitionRevision === undefined
      ? {}
      : { definitionRevision: assessment.identity.definitionRevision }),
    ...(assessment.identity.definitionDigest === undefined
      ? {}
      : { definitionDigest: assessment.identity.definitionDigest }),
    ...(assessment.definition ? { definitionSource: assessment.definition.source } : {}),
    rawSubmission: {
      source: document.sourceKind,
      sourceLabel: document.sourceLabel,
      fileName: document.fileName,
      qbj: document.qbj,
    },
    warnings: assessment.warnings,
    ...(assessment.conflictWithSubmissionId ? { conflictWith: assessment.conflictWithSubmissionId } : {}),
    ...(assessment.classification === 'needs-review' ? { reason: assessment.detail } : {}),
  };
  draft.submissions.push(submission);

  const scheduled = draft.scheduledGames.find((entry) => entry.id === assessment.scheduledGameId);
  if (scheduled && scheduled.status !== 'accepted' && scheduled.status !== 'cancelled')
    scheduled.status = 'submitted';

  artifact.status = 'staged';
  artifact.submissionId = submission.id;
  pushArtifact(draft, artifact);

  draft.audit.push({
    id: newDirectorId('audit'),
    at: now,
    actor: document.sourceKind === 'qbtcp' ? 'QBTCP' : 'Transfers',
    type: 'result-received',
    summary: `Received a result from ${document.sourceLabel}.`,
    entityId: gameId,
    details: {
      transport: document.sourceKind,
      fileName: document.fileName,
      warnings: assessment.warnings,
    },
  });
  recordTransferEvent(draft, {
    kind: 'result-staged',
    summary: `Staged a result from ${document.sourceLabel}`,
    detail: document.fileName,
  });

  return { artifact, submissionId: submission.id, gameId };
}

function pushArtifact(draft: DirectorState, artifact: IncomingArtifact): void {
  draft.transfers.artifacts.unshift(artifact);
  if (draft.transfers.artifacts.length > maxIncomingArtifacts)
    draft.transfers.artifacts.length = maxIncomingArtifacts;
}

/** Record a file that could not be read at all, so a director sees it rather than nothing. */
export function stageInvalidDocument(
  draft: DirectorState,
  input: {
    sourceKind: ArtifactSourceKind;
    sourceLabel: string;
    fileName: string;
    originalPath?: string;
    byteLength: number;
    digest: string;
    reason: string;
  },
): IncomingArtifact {
  const artifact: IncomingArtifact = {
    id: newDirectorId('artifact'),
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel,
    ...(input.originalPath ? { originalPath: input.originalPath } : {}),
    fileName: input.fileName,
    byteLength: input.byteLength,
    digest: input.digest,
    detectedAt: isoNow(),
    classification: 'invalid',
    warnings: [],
    status: 'failed',
    detail: input.reason,
  };
  pushArtifact(draft, artifact);
  return artifact;
}
