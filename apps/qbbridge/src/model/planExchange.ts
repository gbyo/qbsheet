/**
 * Portable round plans: prepare prelims elsewhere, load them here, prove they match.
 *
 * Typing many rounds by hand on tournament morning is itself a reliability risk, so a plan
 * can be prepared on another machine and carried over as a file. The format is deliberately
 * narrow: room ids and names, round pairings by stable id, and bye/inactive lists — plus the
 * fingerprint of the YellowFruit file it was prepared against. It never contains relay
 * credentials, pairing codes, publication state, results, or anything else that could move
 * authority or identity by file copy.
 *
 * # Import never guesses
 *
 * Matching is by stable id only. A plan that names a team, room, or round this setup does not
 * know is refused with the exact unknown ids — never repaired by name, because two teams from
 * one school share most of their name and a wrong repair sends the wrong teenagers to a room.
 * The one exception is an explicit operator-supplied map from planned ids to local ids, which
 * is a decision on the record, not a guess.
 *
 * A plan prepared against a different YellowFruit file is not refused outright — prelims are
 * routinely re-seeded — but applying it requires an explicit confirmation after showing the
 * fingerprint diff. What is refused is applying it blind.
 *
 * # CSV is the same plan in duller clothing
 *
 * The CSV path carries the same content for prelim schedules prepared in a spreadsheet:
 * `round,room,left_team,right_team`, one row per game, with bye/inactive rows naming the team
 * and the keyword `BYE`/`INACTIVE` instead of a room. Names in CSV resolve against the loaded
 * file and the configured rooms, and must resolve to exactly one id — an ambiguous or unknown
 * name is an error naming the cell, never a closest match.
 */

import type { PlannedPairing, RoundPlan } from './roundPlans';
import type { RoundDisposition } from './roundAccountability';

/** The one portable format this build reads and writes. */
export const roundPlanFormat = 'qbbridge-round-plan';
export const roundPlanFormatVersion = 1;

/** One round in a portable plan. Ids only, like `RoundPlan`, plus the stated dispositions. */
export interface PortableRound {
  roundId: string;
  pairings: { roomId: string; leftTeamId: string | null; rightTeamId: string | null }[];
  byes: string[];
  inactive: string[];
}

/** A plan file: intent plus the fingerprint it was prepared against. Nothing else. */
export interface PortableRoundPlan {
  format: typeof roundPlanFormat;
  formatVersion: typeof roundPlanFormatVersion;
  exportedAt: string;
  /** Fingerprint of the YellowFruit bytes the plan was prepared against. Null if unknown. */
  yftFingerprint: string | null;
  tournamentName: string;
  rooms: { id: string; name: string }[];
  rounds: PortableRound[];
}

/** Build the exportable plan from current local state. */
export function exportPortablePlan(input: {
  tournamentName: string;
  yftFingerprint: string | null;
  exportedAt: string;
  rooms: readonly { id: string; name: string }[];
  plans: readonly RoundPlan[];
  dispositions: readonly RoundDisposition[];
}): PortableRoundPlan {
  return {
    format: roundPlanFormat,
    formatVersion: roundPlanFormatVersion,
    exportedAt: input.exportedAt,
    yftFingerprint: input.yftFingerprint,
    tournamentName: input.tournamentName,
    rooms: input.rooms.map((room) => ({ id: room.id, name: room.name })),
    rounds: input.plans.map((plan) => {
      const stated = input.dispositions.find((entry) => entry.roundId === plan.roundId);
      return {
        roundId: plan.roundId,
        pairings: plan.pairings.map((pairing) => ({
          roomId: pairing.roomId,
          leftTeamId: pairing.leftTeamId,
          rightTeamId: pairing.rightTeamId,
        })),
        byes: stated ? [...stated.byes] : [],
        inactive: stated ? [...stated.inactive] : [],
      };
    }),
  };
}

export type ParsePlanResult = { ok: true; plan: PortableRoundPlan } | { ok: false; error: string };

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string');
}

/** Parse an untrusted plan file. Shape-checked; identity is the diff's job, not the parser's. */
export function parsePortablePlan(text: string): ParsePlanResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This is not a QBBridge round-plan file.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'This is not a QBBridge round-plan file.' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.format !== roundPlanFormat) {
    return { ok: false, error: 'This file is not a QBBridge round plan.' };
  }
  if (record.formatVersion !== roundPlanFormatVersion) {
    return {
      ok: false,
      error: `This plan was written by format version ${String(record.formatVersion)}; this build reads version ${roundPlanFormatVersion}.`,
    };
  }
  if (
    !Array.isArray(record.rooms) ||
    !record.rooms.every(
      (room): room is { id: string; name: string } =>
        !!room &&
        typeof room === 'object' &&
        typeof (room as { id: unknown }).id === 'string' &&
        typeof (room as { name: unknown }).name === 'string',
    )
  ) {
    return { ok: false, error: 'This plan file has a damaged room list.' };
  }
  if (!Array.isArray(record.rounds)) {
    return { ok: false, error: 'This plan file has a damaged round list.' };
  }
  const rounds: PortableRound[] = [];
  for (const entry of record.rounds) {
    if (!entry || typeof entry !== 'object' || typeof (entry as { roundId: unknown }).roundId !== 'string') {
      return { ok: false, error: 'This plan file has a damaged round entry.' };
    }
    const round = entry as {
      roundId: string;
      pairings: unknown;
      byes: unknown;
      inactive: unknown;
    };
    if (!Array.isArray(round.pairings)) {
      return { ok: false, error: `Round ${round.roundId} has a damaged pairing list.` };
    }
    const pairings: PortableRound['pairings'] = [];
    for (const pairing of round.pairings) {
      if (
        !pairing ||
        typeof pairing !== 'object' ||
        typeof (pairing as { roomId: unknown }).roomId !== 'string' ||
        !('leftTeamId' in (pairing as object)) ||
        !('rightTeamId' in (pairing as object))
      ) {
        return { ok: false, error: `Round ${round.roundId} has a damaged pairing.` };
      }
      const sides = pairing as { roomId: string; leftTeamId: unknown; rightTeamId: unknown };
      if (
        (sides.leftTeamId !== null && typeof sides.leftTeamId !== 'string') ||
        (sides.rightTeamId !== null && typeof sides.rightTeamId !== 'string')
      ) {
        return { ok: false, error: `Round ${round.roundId} has a damaged pairing.` };
      }
      pairings.push({ roomId: sides.roomId, leftTeamId: sides.leftTeamId, rightTeamId: sides.rightTeamId });
    }
    if (!isStringList(round.byes) || !isStringList(round.inactive)) {
      return { ok: false, error: `Round ${round.roundId} has a damaged bye list.` };
    }
    rounds.push({ roundId: round.roundId, pairings, byes: round.byes, inactive: round.inactive });
  }
  return {
    ok: true,
    plan: {
      format: roundPlanFormat,
      formatVersion: roundPlanFormatVersion,
      exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : '',
      yftFingerprint: typeof record.yftFingerprint === 'string' ? record.yftFingerprint : null,
      tournamentName: typeof record.tournamentName === 'string' ? record.tournamentName : '',
      rooms: record.rooms as { id: string; name: string }[],
      rounds,
    },
  };
}

/** What the operator must see before a plan file touches local state. */
export interface PlanImportDiff {
  /** False when the plan was prepared against different YellowFruit bytes. */
  fingerprintMatch: boolean;
  planFingerprint: string | null;
  currentFingerprint: string | null;
  planTournamentName: string;
  roundCount: number;
  pairingCount: number;
  byeCount: number;
  unknownRoundIds: string[];
  unknownRoomIds: { id: string; name: string }[];
  unknownTeamIds: string[];
  /** True when every id resolves and only the fingerprint question remains. */
  clean: boolean;
}

export interface PlanImportKnown {
  yftFingerprint: string | null;
  roundIds: ReadonlySet<string>;
  roomIds: ReadonlySet<string>;
  teamIds: ReadonlySet<string>;
}

/**
 * Validate a parsed plan against the loaded file and configured rooms.
 *
 * Unknown ids are listed, never mapped. Name similarity is not consulted at all: the diff
 * carries the plan's room names for display only, so the operator can recognize what to create
 * or map explicitly.
 */
export function diffPortablePlan(plan: PortableRoundPlan, known: PlanImportKnown): PlanImportDiff {
  const unknownRoundIds: string[] = [];
  const unknownRoomIds: { id: string; name: string }[] = [];
  const unknownTeams = new Set<string>();
  const seenRooms = new Set<string>();
  let pairingCount = 0;
  let byeCount = 0;

  for (const round of plan.rounds) {
    if (!known.roundIds.has(round.roundId) && !unknownRoundIds.includes(round.roundId)) {
      unknownRoundIds.push(round.roundId);
    }
    for (const pairing of round.pairings) {
      pairingCount += 1;
      if (!known.roomIds.has(pairing.roomId) && !seenRooms.has(pairing.roomId)) {
        seenRooms.add(pairing.roomId);
        const planned = plan.rooms.find((room) => room.id === pairing.roomId);
        unknownRoomIds.push({ id: pairing.roomId, name: planned?.name ?? pairing.roomId });
      }
      for (const teamId of [pairing.leftTeamId, pairing.rightTeamId]) {
        if (teamId !== null && !known.teamIds.has(teamId)) unknownTeams.add(teamId);
      }
    }
    for (const teamId of [...round.byes, ...round.inactive]) {
      byeCount += 1;
      if (!known.teamIds.has(teamId)) unknownTeams.add(teamId);
    }
  }

  const fingerprintMatch =
    plan.yftFingerprint !== null &&
    known.yftFingerprint !== null &&
    plan.yftFingerprint === known.yftFingerprint;
  const unknownTeamIds = [...unknownTeams];
  return {
    fingerprintMatch,
    planFingerprint: plan.yftFingerprint,
    currentFingerprint: known.yftFingerprint,
    planTournamentName: plan.tournamentName,
    roundCount: plan.rounds.length,
    pairingCount,
    byeCount,
    unknownRoundIds,
    unknownRoomIds,
    unknownTeamIds,
    clean: unknownRoundIds.length === 0 && unknownRoomIds.length === 0 && unknownTeamIds.length === 0,
  };
}

/** Explicit operator id mappings, decided on the record. Never inferred from names. */
export interface PlanIdMap {
  rooms?: Record<string, string>;
  teams?: Record<string, string>;
}

export type ApplyPlanResult =
  { ok: true; plans: RoundPlan[]; dispositions: RoundDisposition[] } | { ok: false; error: string };

/**
 * Apply a validated plan to local state.
 *
 * Refuses unknown ids unless the explicit map resolves every one of them. The map translates
 * planned ids to local ids; anything still unknown after mapping is an error naming the ids,
 * and nothing is partially applied. Replacing whole rounds (not merging pairings) keeps the
 * import an explicit snapshot: a pairing deleted from the plan file disappears locally rather
 * than lingering as a ghost the operator cannot see.
 */
export function applyPortablePlan(
  plan: PortableRoundPlan,
  known: PlanImportKnown,
  map: PlanIdMap = {},
): ApplyPlanResult {
  const diff = diffPortablePlan(plan, known);
  const roomMap = map.rooms ?? {};
  const teamMap = map.teams ?? {};

  const unresolvedRounds = diff.unknownRoundIds;
  if (unresolvedRounds.length > 0) {
    return {
      ok: false,
      error: `This plan names rounds this setup does not have: ${unresolvedRounds.join(', ')}.`,
    };
  }
  const unresolvedRooms = diff.unknownRoomIds
    .map((room) => room.id)
    .filter((id) => typeof roomMap[id] !== 'string' || !known.roomIds.has(roomMap[id] as string));
  if (unresolvedRooms.length > 0) {
    return {
      ok: false,
      error: `This plan names rooms this setup does not have: ${unresolvedRooms.join(', ')}. Add the rooms or map them explicitly first.`,
    };
  }
  const unresolvedTeams = diff.unknownTeamIds.filter(
    (id) => typeof teamMap[id] !== 'string' || !known.teamIds.has(teamMap[id] as string),
  );
  if (unresolvedTeams.length > 0) {
    return {
      ok: false,
      error: `This plan names teams the loaded file does not have: ${unresolvedTeams.join(', ')}. Reload the matching file or map them explicitly first.`,
    };
  }

  const translateTeam = (teamId: string | null): string | null => {
    if (teamId === null) return null;
    return teamMap[teamId] ?? teamId;
  };
  const plans: RoundPlan[] = plan.rounds.map((round) => ({
    roundId: round.roundId,
    pairings: round.pairings
      .map((pairing): PlannedPairing => ({
        roomId: roomMap[pairing.roomId] ?? pairing.roomId,
        leftTeamId: translateTeam(pairing.leftTeamId),
        rightTeamId: translateTeam(pairing.rightTeamId),
      }))
      .filter((pairing) => pairing.leftTeamId !== null || pairing.rightTeamId !== null),
  }));
  const dispositions: RoundDisposition[] = plan.rounds.flatMap((round) => {
    const byes = round.byes.map((teamId) => teamMap[teamId] ?? teamId);
    const inactive = round.inactive.map((teamId) => teamMap[teamId] ?? teamId);
    return byes.length === 0 && inactive.length === 0 ? [] : [{ roundId: round.roundId, byes, inactive }];
  });
  return { ok: true, plans, dispositions };
}

const csvHeader = 'round,room,left_team,right_team';
const byeKeyword = 'BYE';
const inactiveKeyword = 'INACTIVE';

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function parseCsvLine(line: string): string[] | null {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quoted) return null;
  cells.push(current);
  return cells;
}

/** Serialize rounds to the spreadsheet CSV shape. Names, because humans prepare these. */
export function exportPrelimCsv(input: {
  rounds: readonly { id: string; displayName: string }[];
  plans: readonly RoundPlan[];
  dispositions: readonly RoundDisposition[];
  roomName: (roomId: string) => string;
  teamName: (teamId: string) => string;
}): string {
  const lines = [csvHeader];
  for (const round of input.rounds) {
    const plan = input.plans.find((entry) => entry.roundId === round.id);
    for (const pairing of plan?.pairings ?? []) {
      lines.push(
        [
          round.displayName,
          input.roomName(pairing.roomId),
          pairing.leftTeamId === null ? '' : input.teamName(pairing.leftTeamId),
          pairing.rightTeamId === null ? '' : input.teamName(pairing.rightTeamId),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const stated = input.dispositions.find((entry) => entry.roundId === round.id);
    for (const teamId of stated?.byes ?? []) {
      lines.push([round.displayName, '', input.teamName(teamId), byeKeyword].map(csvCell).join(','));
    }
    for (const teamId of stated?.inactive ?? []) {
      lines.push([round.displayName, '', input.teamName(teamId), inactiveKeyword].map(csvCell).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface CsvImportKnown extends PlanImportKnown {
  roundNameToId: (name: string) => string[];
  roomNameToId: (name: string) => string[];
  teamNameToId: (name: string) => string[];
}

export type ImportCsvResult =
  { ok: true; plans: RoundPlan[]; dispositions: RoundDisposition[] } | { ok: false; error: string };

/**
 * The single id behind a CSV name, or null when the name resolves to zero or many.
 *
 * Both directions are errors. Callers report the row; this function only refuses to choose.
 */
function resolveCsvName(candidates: string[]): string | null {
  if (candidates.length === 1) return candidates[0] as string;
  return null;
}

/**
 * Parse spreadsheet CSV back into plans.
 *
 * Every name must resolve to exactly one id in the current setup. Zero matches and multiple
 * matches are both errors naming the row — the importer never picks a closest match, because
 * the closest match to "St. John's A" in a three-school field is a coin flip with teenagers.
 */
export function importPrelimCsv(text: string, known: CsvImportKnown): ImportCsvResult {
  const rows = text.split(/\r?\n/);
  if (rows.length === 0 || (rows[0] as string).trim().toLowerCase() !== csvHeader) {
    return { ok: false, error: 'This CSV needs the header: round,room,left_team,right_team.' };
  }
  const plans = new Map<string, Map<string, PlannedPairing>>();
  const byes = new Map<string, Set<string>>();
  const inactive = new Map<string, Set<string>>();

  const planFor = (roundId: string): Map<string, PlannedPairing> => {
    let plan = plans.get(roundId);
    if (!plan) {
      plan = new Map();
      plans.set(roundId, plan);
    }
    return plan;
  };

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const line = rows[rowIndex] as string;
    if (line.trim() === '') continue;
    const rowNumber = rowIndex + 1;
    const cells = parseCsvLine(line);
    if (!cells || cells.length !== 4) {
      return { ok: false, error: `Row ${rowNumber} does not have exactly 4 columns.` };
    }
    const [roundRaw, roomRaw, leftRaw, rightRaw] = cells.map((cell) => cell.trim());
    const roundId = known.roundIds.has(roundRaw as string)
      ? (roundRaw as string)
      : resolveCsvName(known.roundNameToId(roundRaw as string));
    if (roundId === null) {
      return { ok: false, error: `Row ${rowNumber}: round “${roundRaw}” is unknown or ambiguous.` };
    }
    const keyword = (rightRaw as string).toUpperCase();
    if ((roomRaw as string) === '' && (keyword === byeKeyword || keyword === inactiveKeyword)) {
      const teamId = resolveCsvName(known.teamNameToId(leftRaw as string));
      if (teamId === null) {
        return { ok: false, error: `Row ${rowNumber}: team “${leftRaw}” is unknown or ambiguous.` };
      }
      const bucket = keyword === byeKeyword ? byes : inactive;
      let set = bucket.get(roundId);
      if (!set) {
        set = new Set();
        bucket.set(roundId, set);
      }
      set.add(teamId);
      continue;
    }
    const roomId = known.roomIds.has(roomRaw as string)
      ? (roomRaw as string)
      : resolveCsvName(known.roomNameToId(roomRaw as string));
    if (roomId === null) {
      return { ok: false, error: `Row ${rowNumber}: room “${roomRaw}” is unknown or ambiguous.` };
    }
    const leftTeamId =
      (leftRaw as string) === '' ? null : resolveCsvName(known.teamNameToId(leftRaw as string));
    if ((leftRaw as string) !== '' && leftTeamId === null) {
      return { ok: false, error: `Row ${rowNumber}: team “${leftRaw}” is unknown or ambiguous.` };
    }
    const rightTeamId =
      (rightRaw as string) === '' ? null : resolveCsvName(known.teamNameToId(rightRaw as string));
    if ((rightRaw as string) !== '' && rightTeamId === null) {
      return { ok: false, error: `Row ${rowNumber}: team “${rightRaw}” is unknown or ambiguous.` };
    }
    const plan = planFor(roundId);
    const existing = plan.get(roomId);
    if (existing) {
      return { ok: false, error: `Row ${rowNumber}: room “${roomRaw}” already has a game this round.` };
    }
    if (leftTeamId === null && rightTeamId === null) continue;
    plan.set(roomId, { roomId, leftTeamId, rightTeamId });
  }

  return {
    ok: true,
    plans: [...plans].map(([roundId, pairings]) => ({ roundId, pairings: [...pairings.values()] })),
    dispositions: [...new Set([...byes.keys(), ...inactive.keys()])].map((roundId) => ({
      roundId,
      byes: [...(byes.get(roundId) ?? [])],
      inactive: [...(inactive.get(roundId) ?? [])],
    })),
  };
}
