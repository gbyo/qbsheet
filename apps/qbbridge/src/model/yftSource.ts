/**
 * YellowFruit as the authority: source identity, game verification, and corrections.
 *
 * QBBridge never writes standings or the schedule — YellowFruit owns those — but every
 * assignment it publishes and every result it saves is only meaningful against the exact
 * `.yft` those bytes came from. This module is the pure core of that boundary:
 *
 * - `sha256Hex` identifies source bytes. Synchronous on purpose: file loads, package
 *   creation, and publication all run on synchronous paths, and the hash answers "which
 *   exact bytes?" rather than making any authenticity claim.
 * - `extractYftGames` reads the played games out of a canonical QBJ document with the same
 *   nested-spine walk stock YellowFruit's own importer uses, so verification asks "would
 *   YellowFruit see this game?" instead of inventing a second matching rule.
 * - `verifyGameInIndex` matches on stable identities plus score content — round number,
 *   team ids, points, tossups read — never on display names, which the game records do not
 *   even carry here.
 * - `groupResultsByMatch` collects relay finals (originals plus corrections) by logical
 *   game so the operator handles one current result per game, never original + correction
 *   as two unrelated imports.
 */

const sha256Rounds = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
];

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** SHA-256 over the UTF-8 bytes, as lowercase hex. Pure and synchronous. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  // Append 0x80 then zero-pad so the length lands 64 bits short of a 512-bit block.
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // 64-bit big-endian bit length; YFT files stay far below 2^32 bits.
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32));

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const schedule = new Array<number>(64);

  for (let block = 0; block < paddedLength; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(block + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotr(schedule[index - 15], 7) ^ rotr(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
      const s1 = rotr(schedule[index - 2], 17) ^ rotr(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + sha256Rounds[index] + schedule[index]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((part) => (part >>> 0).toString(16).padStart(8, '0')).join('');
}

type QbjRecord = Record<string, unknown>;

function isRecord(value: unknown): value is QbjRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One played game, as identities and score content. No display names anywhere. */
export interface YftGame {
  /** parseInt over the round name, the way YellowFruit itself resolves rounds. Null when absent. */
  roundNumber: number | null;
  roundName: string;
  matchId: string | null;
  leftTeamId: string | null;
  rightTeamId: string | null;
  leftPoints: number | null;
  rightPoints: number | null;
  tossupsRead: number | null;
}

function teamId(side: unknown): string | null {
  if (!isRecord(side)) return null;
  const team = side.team;
  if (typeof team === 'string') return team;
  if (!isRecord(team)) return null;
  if (typeof team.$ref === 'string') return team.$ref;
  if (typeof team.id === 'string') return team.id;
  return null;
}

function pointsOf(side: unknown): number | null {
  if (!isRecord(side) || typeof side.points !== 'number' || !Number.isFinite(side.points)) return null;
  return side.points;
}

function gameOf(roundName: unknown, match: QbjRecord): YftGame | null {
  if (match.type !== 'Match') return null;
  const sides = Array.isArray(match.match_teams) ? match.match_teams.filter(isRecord) : [];
  if (sides.length !== 2) return null;
  const name = typeof roundName === 'string' ? roundName : '';
  const parsed = Number.parseInt(name, 10);
  return {
    roundNumber: name !== '' && !Number.isNaN(parsed) ? parsed : null,
    roundName: name,
    matchId: typeof match.id === 'string' ? match.id : null,
    leftTeamId: teamId(sides[0]),
    rightTeamId: teamId(sides[1]),
    leftPoints: pointsOf(sides[0]),
    rightPoints: pointsOf(sides[1]),
    tossupsRead:
      typeof match.tossups_read === 'number' && Number.isFinite(match.tossups_read)
        ? match.tossups_read
        : null,
  };
}

/**
 * Every two-sided game in a canonical QBJ document, via the nested phase/round spine.
 *
 * The same walk stock YellowFruit's importer uses: phases and rounds inline, only the match
 * link followed. Unplayed or malformed entries are skipped — verification matches on score
 * content, so a game with no scores can never false-verify a result.
 */
export function extractYftGames(objects: readonly unknown[]): YftGame[] {
  const byId = new Map<string, QbjRecord>();
  for (const object of objects) {
    if (isRecord(object) && object.type === 'Match' && typeof object.id === 'string') {
      byId.set(object.id, object);
    }
  }
  const tournament = objects.find(
    (entry): entry is QbjRecord => isRecord(entry) && entry.type === 'Tournament',
  );
  if (!tournament) return [];
  const games: YftGame[] = [];
  const phases = Array.isArray(tournament.phases) ? tournament.phases : [];
  for (const phase of phases) {
    if (!isRecord(phase)) continue;
    const rounds = Array.isArray(phase.rounds) ? phase.rounds : [];
    for (const round of rounds) {
      if (!isRecord(round)) continue;
      const matches = Array.isArray(round.matches) ? round.matches : [];
      for (const entry of matches) {
        let match: QbjRecord | null = null;
        if (isRecord(entry) && typeof entry.$ref === 'string') {
          match = byId.get(entry.$ref) ?? null;
        } else if (isRecord(entry)) {
          match = entry;
        }
        if (!match) continue;
        const game = gameOf(round.name, match);
        if (game) games.push(game);
      }
    }
  }
  return games;
}

export type GameVerification = 'verified' | 'unverified' | 'conflict';

/**
 * Whether one scored game is provably represented in the authoritative games.
 *
 * Exact equality on round number, both team ids, both point totals, and tossups read —
 * the same content YellowFruit shows for the game. Team ids must resolve to the currently
 * loaded roster: a renamed or deleted team makes proof impossible, and the answer is
 * "cannot prove", never a guess. Multiple identical games in the file are the file's own
 * ambiguity, and the answer is likewise "cannot prove".
 */
export function verifyGameInIndex(
  game: YftGame,
  games: readonly YftGame[],
  teamIds: ReadonlySet<string>,
): GameVerification {
  if (
    game.roundNumber === null ||
    game.leftTeamId === null ||
    game.rightTeamId === null ||
    !teamIds.has(game.leftTeamId) ||
    !teamIds.has(game.rightTeamId)
  ) {
    return 'conflict';
  }
  const matches = games.filter(
    (candidate) =>
      candidate.roundNumber === game.roundNumber &&
      candidate.leftTeamId === game.leftTeamId &&
      candidate.rightTeamId === game.rightTeamId &&
      candidate.leftPoints === game.leftPoints &&
      candidate.rightPoints === game.rightPoints &&
      candidate.tossupsRead === game.tossupsRead,
  );
  if (matches.length === 1) return 'verified';
  return matches.length === 0 ? 'unverified' : 'conflict';
}

/** The logical game one or more relay finals belong to. */
export interface CorrectionGroup {
  /**
   * The QBJ match id shared by original and corrections — the only proof two finals are
   * the same game — or a per-result identity when no match id exists. Round-plus-teams
   * tuples are deliberately never used: phases reuse round names and teams meet again,
   * so inferring correction identity from them would mark a legitimate game superseded.
   */
  key: string;
  /** Every result id in the group, oldest first. */
  resultIds: string[];
  /** The newest arrival: the only candidate for the authoritative handoff. */
  latestResultId: string;
}

interface GroupableResult {
  resultId: string;
  receivedAt: string;
  qbj: unknown;
}

function resultMatchId(qbj: unknown): string | null {
  if (!isRecord(qbj) || !Array.isArray(qbj.objects)) return null;
  const match = qbj.objects.find((entry): entry is QbjRecord => isRecord(entry) && entry.type === 'Match');
  return match && typeof match.id === 'string' ? match.id : null;
}

function fallbackGroupKey(result: GroupableResult): string {
  // No match id, no proven identity. A correction re-scores the same assignment document,
  // so it always carries its original's match id; anything without one is either a legacy
  // row or a different game, and both cases must stand alone for operator review rather
  // than collapse into a false correction pair.
  return `unmatched:${result.resultId}`;
}

/**
 * Group relay finals by logical game. A correction re-scores the same assignment document,
 * so it carries the same match id as its original; anything without one stands alone in
 * its own group and is never automatically marked as another result's correction.
 */
export function groupResultsByMatch(results: readonly GroupableResult[]): CorrectionGroup[] {
  const groups = new Map<string, { resultIds: string[]; latestAt: string; latestResultId: string }>();
  for (const result of results) {
    const key = resultMatchId(result.qbj) ?? fallbackGroupKey(result);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        resultIds: [result.resultId],
        latestAt: result.receivedAt,
        latestResultId: result.resultId,
      });
      continue;
    }
    group.resultIds.push(result.resultId);
    if (result.receivedAt >= group.latestAt) {
      group.latestAt = result.receivedAt;
      group.latestResultId = result.resultId;
    }
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    resultIds: group.resultIds,
    latestResultId: group.latestResultId,
  }));
}

/**
 * What the operator should believe about one result, for handoff to YellowFruit.
 *
 * - `unknown`: no authoritative games are loaded, so there is nothing to prove against.
 * - `superseded`: a newer final exists for the same game. Hand the newest, and if the older
 *   one was already verified, the YellowFruit tournament now needs the correction — not
 *   another copy of the old file.
 * - `verified`: exactly one authoritative game matches on identity and score content.
 * - `needs-import`: nothing matches yet. The ordinary state for a result YellowFruit has
 *   not seen.
 * - `conflict`: proof is impossible — ambiguous games, an unresolvable roster, or an
 *   operator marker claiming an import no game can account for.
 */
export type ResultVerification = 'unknown' | 'verified' | 'needs-import' | 'superseded' | 'conflict';

export function verificationForResult(
  result: GroupableResult & { importStatus?: string },
  groups: readonly CorrectionGroup[],
  games: readonly YftGame[] | null,
  teamIds: ReadonlySet<string>,
): ResultVerification {
  if (!games) return 'unknown';
  const group = groups.find((entry) => entry.resultIds.includes(result.resultId));
  if (group && group.latestResultId !== result.resultId) return 'superseded';
  const objects = isRecord(result.qbj) && Array.isArray(result.qbj.objects) ? result.qbj.objects : [];
  const game = extractYftGames(objects)[0];
  if (!game) return 'conflict';
  const verdict = verifyGameInIndex(game, games, teamIds);
  if (verdict === 'verified') return 'verified';
  if (verdict === 'conflict') return 'conflict';
  return result.importStatus === 'imported' ? 'conflict' : 'needs-import';
}
