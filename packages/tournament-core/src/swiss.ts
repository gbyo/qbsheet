import type { EntityId } from './model';

/**
 * The small amount of state a quizbowl power-pairing engine needs.
 *
 * This is intentionally not the chess/FIDE model: quizbowl has no colour balance, and its useful
 * primary grouping is the win/loss record.  The Director adapts its canonical standings and game
 * history into this shape, while the core owns the deterministic constraint search.
 */
export interface QuizbowlSwissTeam {
  readonly id: EntityId;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly pointsFor: number;
  readonly margin: number;
  readonly seed?: number | null;
  readonly organizationId?: EntityId | null;
  readonly previousOpponentIds: readonly EntityId[];
  readonly byeCount: number;
  /** A dropped team is retained in history but is not paired again. */
  readonly dropped?: boolean;
  /** A record with an unresolved/incomplete result cannot safely drive a dependent round. */
  readonly incomplete?: boolean;
}

export interface QuizbowlSwissPairing {
  readonly leftTeamId: EntityId;
  readonly rightTeamId: EntityId | null;
}

export type QuizbowlSwissConflictCode =
  | 'invalid-team'
  | 'duplicate-team'
  | 'unknown-team'
  | 'dropped-team'
  | 'incomplete-standings'
  | 'no-bye-allowed'
  | 'rematch'
  | 'same-organization'
  | 'record-float'
  | 'bye'
  | 'manual-override'
  | 'no-complete-pairing';

export interface QuizbowlSwissConflict {
  readonly code: QuizbowlSwissConflictCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly teamIds?: readonly EntityId[];
}

export interface QuizbowlSwissOptions {
  readonly avoidRematches?: boolean;
  readonly avoidSameOrganization?: boolean;
  readonly allowByes?: boolean;
  /** Used by the Director when a human has explicitly approved a non-generated pairing. */
  readonly manualPairings?: readonly QuizbowlSwissPairing[];
  /** Tests/import recovery can opt into a clearly reported provisional pairing. */
  readonly allowIncomplete?: boolean;
}

export interface QuizbowlSwissResult {
  readonly pairings: readonly QuizbowlSwissPairing[];
  readonly byeTeamId: EntityId | null;
  readonly orderedTeamIds: readonly EntityId[];
  readonly conflicts: readonly QuizbowlSwissConflict[];
  readonly hardFailure: boolean;
}

const REMATCH_PENALTY = 1_000_000_000;
const SAME_ORGANIZATION_PENALTY = 1_000_000;
const RECORD_FLOAT_PENALTY = 10_000;

function recordValue(team: QuizbowlSwissTeam): number {
  return team.wins + team.ties * 0.5;
}

function compareStandings(left: QuizbowlSwissTeam, right: QuizbowlSwissTeam): number {
  return (
    recordValue(right) - recordValue(left) ||
    right.wins - left.wins ||
    right.pointsFor - left.pointsFor ||
    right.margin - left.margin ||
    (left.seed ?? Number.MAX_SAFE_INTEGER) - (right.seed ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  );
}

function compareByeCandidates(left: QuizbowlSwissTeam, right: QuizbowlSwissTeam): number {
  return (
    left.byeCount - right.byeCount ||
    recordValue(left) - recordValue(right) ||
    left.wins - right.wins ||
    left.pointsFor - right.pointsFor ||
    left.margin - right.margin ||
    (right.seed ?? Number.MIN_SAFE_INTEGER) - (left.seed ?? Number.MIN_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  );
}

function previousOpponents(team: QuizbowlSwissTeam): Set<EntityId> {
  return new Set(team.previousOpponentIds);
}

function hasPlayed(left: QuizbowlSwissTeam, right: QuizbowlSwissTeam): boolean {
  return previousOpponents(left).has(right.id) || previousOpponents(right).has(left.id);
}

function sameOrganization(left: QuizbowlSwissTeam, right: QuizbowlSwissTeam): boolean {
  return Boolean(left.organizationId && right.organizationId && left.organizationId === right.organizationId);
}

function pairingCost(
  left: QuizbowlSwissTeam,
  right: QuizbowlSwissTeam,
  options: QuizbowlSwissOptions,
): number {
  const recordDistance = Math.abs(recordValue(left) - recordValue(right));
  const rematch = options.avoidRematches !== false && hasPlayed(left, right);
  const sameSchool = options.avoidSameOrganization !== false && sameOrganization(left, right);
  return (
    recordDistance * RECORD_FLOAT_PENALTY +
    (sameSchool ? SAME_ORGANIZATION_PENALTY : 0) +
    (rematch ? REMATCH_PENALTY : 0)
  );
}

function pairingSort(
  left: QuizbowlSwissTeam,
  right: QuizbowlSwissTeam,
  anchor: QuizbowlSwissTeam,
  options: QuizbowlSwissOptions,
): number {
  return (
    pairingCost(anchor, left, options) - pairingCost(anchor, right, options) || compareStandings(left, right)
  );
}

interface SearchResult {
  readonly pairings: QuizbowlSwissPairing[];
  readonly cost: number;
}

/**
 * Find the lowest-cost complete matching.  The cost order is deliberate: rematches are only used
 * when every complete matching would require one, same-school pairings are next, and only then do
 * we float teams between record bands.  Every tie is resolved by the stable team id ordering.
 */
function findCompletePairing(
  teams: readonly QuizbowlSwissTeam[],
  options: QuizbowlSwissOptions,
): SearchResult | null {
  if (teams.length === 0) return { pairings: [], cost: 0 };
  const byId = new Map(teams.map((team) => [team.id, team]));
  let best: SearchResult | null = null;
  let visited = 0;

  const search = (remaining: QuizbowlSwissTeam[], pairings: QuizbowlSwissPairing[], cost: number): void => {
    visited += 1;
    // The cap prevents a pathological imported history from freezing Director. The deterministic
    // greedy path is always visited first, so this is a safety valve, not normal pairing logic.
    if (visited > 250_000) return;
    if (remaining.length === 0) {
      if (
        !best ||
        cost < best.cost ||
        (cost === best.cost && pairingKey(pairings) < pairingKey(best.pairings))
      ) {
        best = { pairings: [...pairings], cost };
      }
      return;
    }
    if (best && cost >= best.cost) return;
    const anchor = remaining[0]!;
    const candidates = remaining
      .slice(1)
      .filter((candidate) => byId.has(candidate.id))
      .sort((left, right) => pairingSort(left, right, anchor, options));
    for (const candidate of candidates) {
      const nextCost = cost + pairingCost(anchor, candidate, options);
      if (best && nextCost >= best.cost) continue;
      const rest = remaining.filter((team) => team.id !== anchor.id && team.id !== candidate.id);
      search(rest, [...pairings, { leftTeamId: anchor.id, rightTeamId: candidate.id }], nextCost);
    }
  };

  search([...teams].sort(compareStandings), [], 0);
  return best;
}

function pairingKey(pairings: readonly QuizbowlSwissPairing[]): string {
  return pairings
    .map((pairing) => [pairing.leftTeamId, pairing.rightTeamId ?? ''].sort().join('~'))
    .sort()
    .join('|');
}

function validateManualPairings(
  activeTeams: readonly QuizbowlSwissTeam[],
  pairings: readonly QuizbowlSwissPairing[],
  allowByes: boolean,
): QuizbowlSwissConflict[] {
  const activeIds = new Set(activeTeams.map((team) => team.id));
  const seen = new Set<EntityId>();
  const conflicts: QuizbowlSwissConflict[] = [];
  let byes = 0;
  for (const pairing of pairings) {
    if (!activeIds.has(pairing.leftTeamId)) {
      conflicts.push({
        code: 'unknown-team',
        severity: 'error',
        message: `Manual Swiss pairing references unknown team ${pairing.leftTeamId}.`,
        teamIds: [pairing.leftTeamId],
      });
      continue;
    }
    if (seen.has(pairing.leftTeamId)) {
      conflicts.push({
        code: 'duplicate-team',
        severity: 'error',
        message: `Manual Swiss pairing uses team ${pairing.leftTeamId} more than once.`,
        teamIds: [pairing.leftTeamId],
      });
    }
    seen.add(pairing.leftTeamId);
    if (pairing.rightTeamId === null) {
      byes += 1;
      continue;
    }
    if (!activeIds.has(pairing.rightTeamId)) {
      conflicts.push({
        code: 'unknown-team',
        severity: 'error',
        message: `Manual Swiss pairing references unknown team ${pairing.rightTeamId}.`,
        teamIds: [pairing.rightTeamId],
      });
      continue;
    }
    if (pairing.leftTeamId === pairing.rightTeamId) {
      conflicts.push({
        code: 'invalid-team',
        severity: 'error',
        message: `Team ${pairing.leftTeamId} cannot play itself.`,
        teamIds: [pairing.leftTeamId],
      });
    }
    if (seen.has(pairing.rightTeamId)) {
      conflicts.push({
        code: 'duplicate-team',
        severity: 'error',
        message: `Manual Swiss pairing uses team ${pairing.rightTeamId} more than once.`,
        teamIds: [pairing.rightTeamId],
      });
    }
    seen.add(pairing.rightTeamId);
  }
  const missing = activeTeams.filter((team) => !seen.has(team.id)).map((team) => team.id);
  if (missing.length > 0) {
    conflicts.push({
      code: 'manual-override',
      severity: 'error',
      message: `Manual Swiss override does not place every active team: ${missing.join(', ')}.`,
      teamIds: missing,
    });
  }
  if (byes > 1 || (!allowByes && byes > 0) || (activeTeams.length % 2 === 0 && byes > 0)) {
    conflicts.push({
      code: 'no-bye-allowed',
      severity: 'error',
      message: 'A Swiss round may contain at most one bye, and only an odd active field requires one.',
    });
  }
  if (activeTeams.length % 2 === 1 && byes !== 1) {
    conflicts.push({
      code: 'manual-override',
      severity: 'error',
      message: 'An odd Swiss field needs exactly one explicit bye in a manual override.',
    });
  }
  return conflicts;
}

function pairingConflicts(
  pairings: readonly QuizbowlSwissPairing[],
  byId: ReadonlyMap<EntityId, QuizbowlSwissTeam>,
  options: QuizbowlSwissOptions,
): QuizbowlSwissConflict[] {
  const conflicts: QuizbowlSwissConflict[] = [];
  for (const pairing of pairings) {
    if (pairing.rightTeamId === null) {
      const team = byId.get(pairing.leftTeamId);
      if (team && team.byeCount > 0) {
        conflicts.push({
          code: 'bye',
          severity: 'warning',
          message: `${pairing.leftTeamId} is receiving a repeat bye because every complete pairing required it.`,
          teamIds: [pairing.leftTeamId],
        });
      }
      continue;
    }
    const left = byId.get(pairing.leftTeamId);
    const right = byId.get(pairing.rightTeamId);
    if (!left || !right) continue;
    if (options.avoidRematches !== false && hasPlayed(left, right)) {
      conflicts.push({
        code: 'rematch',
        severity: 'warning',
        message: `Swiss pairing ${left.id}–${right.id} is an unavoidable rematch.`,
        teamIds: [left.id, right.id],
      });
    }
    if (options.avoidSameOrganization !== false && sameOrganization(left, right)) {
      conflicts.push({
        code: 'same-organization',
        severity: 'warning',
        message: `Swiss pairing ${left.id}–${right.id} keeps teams from the same school together because no cleaner complete matching was available.`,
        teamIds: [left.id, right.id],
      });
    }
    if (recordValue(left) !== recordValue(right)) {
      conflicts.push({
        code: 'record-float',
        severity: 'warning',
        message: `Swiss pairing ${left.id}–${right.id} floats across records ${recordValue(left)} and ${recordValue(right)}.`,
        teamIds: [left.id, right.id],
      });
    }
  }
  return conflicts;
}

/** Generate or validate one quizbowl power-paired round. */
export function pairQuizbowlSwiss(
  inputTeams: readonly QuizbowlSwissTeam[],
  options: QuizbowlSwissOptions = {},
): QuizbowlSwissResult {
  const conflicts: QuizbowlSwissConflict[] = [];
  const byId = new Map<EntityId, QuizbowlSwissTeam>();
  for (const team of inputTeams) {
    if (!team.id || byId.has(team.id)) {
      conflicts.push({
        code: byId.has(team.id) ? 'duplicate-team' : 'invalid-team',
        severity: 'error',
        message: team.id ? `Team ${team.id} appears more than once.` : 'Every Swiss team needs an id.',
        teamIds: team.id ? [team.id] : [],
      });
      continue;
    }
    byId.set(team.id, team);
  }
  const dropped = [...byId.values()].filter((team) => team.dropped);
  if (dropped.length > 0) {
    conflicts.push({
      code: 'dropped-team',
      severity: 'warning',
      message: `Dropped teams are excluded from this Swiss round: ${dropped.map((team) => team.id).join(', ')}.`,
      teamIds: dropped.map((team) => team.id),
    });
  }
  const activeTeams = [...byId.values()].filter((team) => !team.dropped).sort(compareStandings);
  const incomplete = activeTeams.filter((team) => team.incomplete);
  if (incomplete.length > 0 && !options.allowIncomplete) {
    conflicts.push({
      code: 'incomplete-standings',
      severity: 'error',
      message: `Swiss generation is blocked until these records are resolved: ${incomplete.map((team) => team.id).join(', ')}.`,
      teamIds: incomplete.map((team) => team.id),
    });
  } else if (incomplete.length > 0) {
    conflicts.push({
      code: 'incomplete-standings',
      severity: 'warning',
      message: `This Swiss round uses provisional records for: ${incomplete.map((team) => team.id).join(', ')}.`,
      teamIds: incomplete.map((team) => team.id),
    });
  }
  if (activeTeams.length < 2) {
    conflicts.push({
      code: 'no-complete-pairing',
      severity: 'error',
      message: 'A Swiss round needs at least two active teams.',
    });
  }
  const allowByes = options.allowByes !== false;
  const expectedBye = activeTeams.length % 2 === 1;
  if (expectedBye && !allowByes && !options.manualPairings) {
    conflicts.push({
      code: 'no-bye-allowed',
      severity: 'error',
      message: 'The active Swiss field is odd, but byes are disabled.',
    });
  }
  if (conflicts.some((conflict) => conflict.severity === 'error')) {
    return {
      pairings: [],
      byeTeamId: null,
      orderedTeamIds: activeTeams.map((team) => team.id),
      conflicts,
      hardFailure: true,
    };
  }

  if (options.manualPairings) {
    const manualConflicts = validateManualPairings(activeTeams, options.manualPairings, allowByes);
    const allConflicts = [...conflicts, ...manualConflicts];
    if (manualConflicts.some((conflict) => conflict.severity === 'error')) {
      return {
        pairings: [],
        byeTeamId: null,
        orderedTeamIds: activeTeams.map((team) => team.id),
        conflicts: allConflicts,
        hardFailure: true,
      };
    }
    const manualById = new Map(activeTeams.map((team) => [team.id, team]));
    const manualPairingConflicts = pairingConflicts(options.manualPairings, manualById, options);
    return {
      pairings: options.manualPairings,
      byeTeamId: options.manualPairings.find((pairing) => pairing.rightTeamId === null)?.leftTeamId ?? null,
      orderedTeamIds: activeTeams.map((team) => team.id),
      conflicts: [...allConflicts, ...manualPairingConflicts],
      hardFailure: false,
    };
  }

  const byeCandidates = expectedBye ? [...activeTeams].sort(compareByeCandidates) : [null];
  let chosen: { bye: QuizbowlSwissTeam | null; search: SearchResult } | null = null;
  for (const bye of byeCandidates) {
    if (bye === null && expectedBye) continue;
    const remaining = bye ? activeTeams.filter((team) => team.id !== bye.id) : activeTeams;
    const search = findCompletePairing(remaining, options);
    if (!search) continue;
    const byeCost = bye ? bye.byeCount * SAME_ORGANIZATION_PENALTY + recordValue(bye) : 0;
    const candidate = { bye, search: { ...search, cost: search.cost + byeCost } };
    if (
      !chosen ||
      candidate.search.cost < chosen.search.cost ||
      (candidate.search.cost === chosen.search.cost &&
        (bye === null
          ? chosen.bye !== null
          : chosen.bye === null || compareByeCandidates(bye, chosen.bye) < 0))
    ) {
      chosen = candidate;
    }
    // The first candidate is the fairest bye (fewest prior byes, then lowest record). A later
    // candidate is only worth considering when it enables a cleaner overall matching.
  }
  if (!chosen) {
    return {
      pairings: [],
      byeTeamId: null,
      orderedTeamIds: activeTeams.map((team) => team.id),
      conflicts: [
        ...conflicts,
        {
          code: 'no-complete-pairing',
          severity: 'error',
          message:
            'No complete Swiss pairing satisfies the current field; choose a manual override or repair the records.',
        },
      ],
      hardFailure: true,
    };
  }
  const pairings = [
    ...chosen.search.pairings,
    ...(chosen.bye ? [{ leftTeamId: chosen.bye.id, rightTeamId: null } satisfies QuizbowlSwissPairing] : []),
  ];
  const selectedConflicts = pairingConflicts(pairings, byId, options);
  if (chosen.bye) {
    selectedConflicts.push({
      code: 'bye',
      severity: 'warning',
      message: `${chosen.bye.id} receives the Swiss bye (fewest prior byes, then lowest current record).`,
      teamIds: [chosen.bye.id],
    });
  }
  return {
    pairings,
    byeTeamId: chosen.bye?.id ?? null,
    orderedTeamIds: activeTeams.map((team) => team.id),
    conflicts: [...conflicts, ...selectedConflicts],
    hardFailure: false,
  };
}
