/**
 * One shared answer to "what game is this result?".
 *
 * Every surface that shows a received QBJ result — QBBridge's results list today, Scorer and
 * Director wherever they describe a foreign document tomorrow — derives its words here, so a
 * shape understood in one place never degrades to `? vs ?` in another. The function never
 * throws and never invents: what cannot be read is reported as a first-class identification
 * state, and the UI's job is to render that state plainly rather than dress it as a matchup.
 *
 * # The four states
 *
 * - `identified`: both teams named. Scores shown when both sides carry finite numbers.
 * - `partial`: a real game with a hole in it — usually one team name. The headline shows what
 *   is known and names the gap; it never prints a `?` placeholder as if it were a team.
 * - `unidentified`: a Match exists but neither side can be named. The game happened; who played
 *   it did not survive in a readable form.
 * - `unreadable`: not even a Match object. The bytes are preserved somewhere else's problem —
 *   this function's only claim is that there is nothing safe to display.
 *
 * Team names resolve through `$ref` exactly like a QBJ consumer resolves them, and fall back to
 * a referenced id when the Team object itself is absent: an id is evidence, not a name, but it
 * beats a placeholder. Scores are positional (left/right), so they travel with whatever names
 * survived.
 */

export type ResultIdentificationKind = 'identified' | 'partial' | 'unidentified' | 'unreadable';

/** The canonical description of one received result document. */
export interface ResultDescription {
  kind: ResultIdentificationKind;
  matchId: string | null;
  roundName: string | null;
  roundNumber: number | null;
  location: string | null;
  leftName: string | null;
  rightName: string | null;
  leftPoints: number | null;
  rightPoints: number | null;
  /** The one line the UI prints. Never a `?` placeholder posing as a team. */
  headline: string;
  /** What exactly could not be read, or null when the description is complete. */
  detail: string | null;
}

type QbjRecord = Record<string, unknown>;

function isRecord(value: unknown): value is QbjRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function documentObjects(qbj: unknown): QbjRecord[] {
  if (!isRecord(qbj) || !Array.isArray(qbj.objects)) return [];
  return qbj.objects.filter(isRecord);
}

function refId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.$ref === 'string') return value.$ref;
  if (isRecord(value) && typeof value.id === 'string') return value.id;
  return null;
}

function resolve(value: unknown, byId: Map<string, QbjRecord>): QbjRecord | null {
  if (isRecord(value) && typeof value.$ref === 'string') return byId.get(value.$ref) ?? null;
  return isRecord(value) ? value : null;
}

function findMatch(qbj: unknown): { match: QbjRecord | null; list: QbjRecord[] } {
  const list = documentObjects(qbj);
  if (isRecord(qbj) && qbj.type === 'Match') return { match: qbj, list };
  return { match: list.find((entry) => entry.type === 'Match') ?? null, list };
}

const missingSide = 'opponent not identified';

/** Derive the canonical description of one received result document. Total: never throws. */
export function describeResult(qbj: unknown): ResultDescription {
  const unreadable = (detail: string): ResultDescription => ({
    kind: 'unreadable',
    matchId: null,
    roundName: null,
    roundNumber: null,
    location: null,
    leftName: null,
    rightName: null,
    leftPoints: null,
    rightPoints: null,
    headline: 'Received result could not be parsed for display; raw QBJ preserved',
    detail,
  });
  if (!isRecord(qbj)) return unreadable('the document is not a QBJ object');

  const { match, list } = findMatch(qbj);
  if (!match) return unreadable('no Match object found');
  const matchId = typeof match.id === 'string' ? match.id : null;

  const byId = new Map<string, QbjRecord>();
  for (const entry of list) if (typeof entry.id === 'string') byId.set(entry.id, entry);

  let roundName: string | null = null;
  for (const tournament of list.filter((entry) => entry.type === 'Tournament')) {
    for (const phaseRef of Array.isArray(tournament.phases) ? tournament.phases : []) {
      const phase = resolve(phaseRef, byId);
      for (const roundRef of phase && Array.isArray(phase.rounds) ? phase.rounds : []) {
        const round = resolve(roundRef, byId);
        if (!round || !Array.isArray(round.matches)) continue;
        const holdsMatch = round.matches.some((entry) => {
          const resolved = resolve(entry, byId);
          return resolved === match || refId(entry) === match.id;
        });
        if (holdsMatch && typeof round.name === 'string') roundName = round.name;
      }
    }
  }

  // Positional slots: match_teams[0] is the left side and [1] is the right side. A malformed
  // entry must leave a hole in its own slot, never shift the surviving side into the other
  // position (which would attribute the wrong score and name to the wrong team).
  const rawSides = Array.isArray(match.match_teams) ? match.match_teams : [];
  const leftSide = isRecord(rawSides[0]) ? rawSides[0] : undefined;
  const rightSide = isRecord(rawSides[1]) ? rawSides[1] : undefined;
  const nameOf = (side: QbjRecord | undefined): string | null => {
    if (!side) return null;
    const team = resolve(side.team, byId);
    if (team && typeof team.name === 'string') return team.name;
    return refId(side.team);
  };
  const pointsOf = (side: QbjRecord | undefined): number | null =>
    side && typeof side.points === 'number' && Number.isFinite(side.points) ? side.points : null;

  const leftName = nameOf(leftSide);
  const rightName = nameOf(rightSide);
  const leftPoints = pointsOf(leftSide);
  const rightPoints = pointsOf(rightSide);
  const parsedNumber = roundName !== null ? Number.parseInt(roundName, 10) : Number.NaN;
  const base = {
    matchId,
    roundName,
    roundNumber: Number.isSafeInteger(parsedNumber) ? parsedNumber : null,
    location: typeof match.location === 'string' ? match.location : null,
    leftName,
    rightName,
    leftPoints,
    rightPoints,
  };

  const scored = leftPoints !== null && rightPoints !== null;
  if (leftName && rightName) {
    return {
      ...base,
      kind: 'identified',
      headline: scored
        ? `${leftName} ${leftPoints}–${rightPoints} ${rightName}`
        : `${leftName} vs ${rightName}`,
      detail: null,
    };
  }
  const known = leftName ?? rightName;
  if (known) {
    const gap = leftName ? `right side ${missingSide}` : `left side ${missingSide}`;
    // Side-aware headline: the score pair always stays in left–right positional order and the
    // known name stays on its own side, so a right-known team is never paired with the left
    // score (e.g. unknown-left 100 / Greenwood-right 200 must not read `Greenwood 100–200`).
    const scoredHeadline = scored
      ? leftName
        ? `${leftName} ${leftPoints}–${rightPoints} (${gap})`
        : `(${gap}) ${leftPoints}–${rightPoints} ${rightName}`
      : `${known} vs ${missingSide}`;
    return {
      ...base,
      kind: 'partial',
      headline: scoredHeadline,
      detail: `one team name missing (${gap})`,
    };
  }
  return {
    ...base,
    kind: 'unidentified',
    headline: 'Result received — matchup could not be identified',
    detail: 'neither team could be named from the document',
  };
}
