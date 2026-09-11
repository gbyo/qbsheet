/**
 * Pinned Scorer builds: the tournament runs the build it validated, provably.
 *
 * Production deploys move (see `pages.yml`: promotion is explicit, but it still moves), and a
 * room that reloads mid-tournament loads whatever production serves at that moment. The pin is
 * what makes that visible instead of silent: before Round 1 the operator records the production
 * build they validated, every result arrives stamped with the build that scored it, and anything
 * that is not the pin is named on screen.
 *
 * # Where the two ends come from
 *
 * The pin comes from production's own `scorer-build.json` manifest, fetched at pin time — the
 * same commit-derived identity the bundle and the service worker carry. Room builds come out of
 * result documents (`Match._qbtcp.scorer_build`), which the scorer stamps on every game it
 * writes, so USB-carried results verify without any network at all.
 *
 * # What this deliberately does not do
 *
 * It does not block publication or pairing on a mismatch. A room running an older build is not
 * necessarily running an incompatible one — wire incompatibility is refused in the room itself
 * (unknown procedure versions) — and refusing to publish to it would hold the tournament
 * hostage to a warning. What it does is make the mismatch impossible to miss, and the upgrade
 * an explicit re-pin.
 */

import { readQbtcpExtension } from '../../../../src/qbj/QbtcpExtension';
import { resultMatchId } from './results';
import type { Room } from './rooms';
import type { StoredResult } from './persistence';

/** A Scorer build: release number plus the short source commit. Echoed, never compared here. */
export interface ScorerBuild {
  version: string;
  commit: string;
}

/** The build this tournament validated, and when the operator pinned it. */
export interface ScorerBuildPin extends ScorerBuild {
  pinnedAt: string;
}

/** One line per room: which build its latest result says scored it, if any result says. */
export interface RoomScorerBuild {
  roomId: string;
  roomName: string;
  matchId: string | null;
  /** True when at least one result exists for the published match. Absence of a result is the
   * thing to display: a room with an assignment but no result is not-yet-observed, never a
   * scored game with a missing stamp. */
  hasResult: boolean;
  build: ScorerBuild | null;
}

/** Production serves this at `scorer-build.json`. Anything larger is not a manifest. */
export const maxBuildManifestBytes = 8192;

/** Parse an untrusted build manifest. Shape-checked; the pin decision is the caller's. */
export function parseBuildManifest(
  text: string,
): { ok: true; build: ScorerBuild } | { ok: false; error: string } {
  if (text.length > maxBuildManifestBytes) {
    return { ok: false, error: 'The production build manifest is implausibly large.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Production did not answer with a readable build manifest.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Production did not answer with a readable build manifest.' };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.version !== 'string' || record.version.trim() === '') {
    return { ok: false, error: 'The production build manifest has no release version.' };
  }
  if (typeof record.commit !== 'string' || record.commit.trim() === '') {
    return { ok: false, error: 'The production build manifest has no source commit.' };
  }
  return { ok: true, build: { version: record.version, commit: record.commit } };
}

/** Persisted pins are a trust boundary; keep only well-formed ones. */
export function normalizeScorerBuildPin(value: unknown): ScorerBuildPin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'string' || record.version.trim() === '') return null;
  if (typeof record.commit !== 'string' || record.commit.trim() === '') return null;
  if (typeof record.pinnedAt !== 'string' || record.pinnedAt.trim() === '') return null;
  return { version: record.version, commit: record.commit, pinnedAt: record.pinnedAt };
}

/** True when two room→build snapshots agree, so a refresh that changed nothing keeps state identity. */
export function sameScorerBuilds(
  left: ReadonlyMap<string, ScorerBuild>,
  right: ReadonlyMap<string, ScorerBuild>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [roomId, build] of left) {
    const other = right.get(roomId);
    if (!other || other.version !== build.version || other.commit !== build.commit) return false;
  }
  return true;
}

/** `version · commit`, the same one-line identifier the scorer prints about itself. */
export function scorerBuildLabel(build: ScorerBuild): string {
  if (build.commit === '' || build.commit === 'unknown' || build.commit === 'dev') return build.version;
  return `${build.version} · ${build.commit}`;
}

/** A dev or checkout-less stamp proves nothing about the release: it is honest, not pinned. */
export function isPlaceholderBuild(build: ScorerBuild): boolean {
  return build.commit === 'dev' || build.commit === 'unknown' || build.commit === '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectsOf(qbj: unknown): Record<string, unknown>[] {
  if (!isRecord(qbj) || !Array.isArray(qbj.objects)) return [];
  return qbj.objects.filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

/** The build stamp on one result document, or null when it predates stamps. */
export function scorerBuildFromResult(qbj: unknown): ScorerBuild | null {
  const bare = isRecord(qbj) && qbj.type === 'Match' ? qbj : null;
  const match = bare ?? objectsOf(qbj).find((entry) => entry.type === 'Match') ?? null;
  if (!match) return null;
  return readQbtcpExtension(match)?.scorerBuild ?? null;
}

/**
 * Which build each room's latest result reports.
 *
 * Rooms are matched to results by match id through what the relay currently holds
 * (`publishedMatchId`): the question is which build scored the game the relay is serving, not
 * which build the room ran last Tuesday. Rooms with no result yet read as unverified, never as
 * matching — the absence of evidence is the thing to display.
 */
export function roomScorerBuilds(
  results: readonly StoredResult[],
  rooms: readonly Pick<Room, 'id' | 'name' | 'publishedMatchId'>[],
): RoomScorerBuild[] {
  const byMatch = new Map<string, StoredResult[]>();
  for (const result of results) {
    const matchId = resultMatchId(result.qbj);
    if (matchId === null) continue;
    byMatch.set(matchId, [...(byMatch.get(matchId) ?? []), result]);
  }
  return rooms.map((room) => {
    const candidates = room.publishedMatchId !== null ? (byMatch.get(room.publishedMatchId) ?? []) : [];
    // Corrections supersede: the newest received result is the room's current statement.
    const latest = [...candidates].sort((left, right) =>
      left.receivedAt < right.receivedAt ? 1 : left.receivedAt > right.receivedAt ? -1 : 0,
    )[0];
    return {
      roomId: room.id,
      roomName: room.name,
      matchId: room.publishedMatchId,
      hasResult: candidates.length > 0,
      build: latest ? scorerBuildFromResult(latest.qbj) : null,
    };
  });
}

/**
 * The one line the setup UI prints per room. Three states, three messages: a stamped build, a
 * scored game whose stamp predates stamps (legacy/unverifiable), and an assignment with no
 * result yet (not-yet-observed — the room may not even have started scoring).
 */
export function roomScorerBuildStatus(entry: RoomScorerBuild): string {
  if (entry.build) return scorerBuildLabel(entry.build);
  if (entry.matchId !== null && entry.hasResult) return 'scored game has no build stamp — unverifiable';
  if (entry.matchId !== null) return 'no scored game yet — build not yet observed';
  return 'no published game — unverified';
}

/**
 * Name every build divergence between the pin and the rooms.
 *
 * Three distinct states, three distinct messages: rooms with a scored game but no stamp
 * (legacy/unverifiable), rooms verifiably off the pin, and a fleet running more than one build
 * at once. A room with an assignment but no result yet is not-yet-observed and stays out of
 * the warnings (the per-room list names it); a placeholder stamp (`dev`, `unknown`) is
 * unverifiable, not mismatched — it says the room runs a build outside any release, which is
 * its own warning.
 */
export function scorerBuildWarnings(input: {
  pin: ScorerBuildPin | null;
  rooms: readonly RoomScorerBuild[];
  /**
   * Live heartbeat builds by room id, from relay presence. Advisory only: result stamps stay
   * authoritative. Present so a room that reloaded onto the wrong build mid-tournament warns
   * before it finishes scoring instead of after.
   */
  liveBuilds?: ReadonlyMap<string, ScorerBuild>;
}): string[] {
  const warnings: string[] = [];
  if (input.pin && input.liveBuilds) {
    for (const room of input.rooms) {
      const live = input.liveBuilds.get(room.roomId);
      if (!live) continue;
      // The result stamp already speaks for builds it agrees with; warn on the live build only
      // when it says something new. That covers both the pre-game room (no result yet) and the
      // room that reloaded after submitting (result says pin, heartbeat says otherwise).
      if (room.build !== null && room.build.version === live.version && room.build.commit === live.commit)
        continue;
      if (isPlaceholderBuild(live)) {
        warnings.push(
          `Room “${room.roomName}” currently reports a non-release build (${scorerBuildLabel(live)}). Re-pair it from production before it scores.`,
        );
      } else if (live.version !== input.pin.version || live.commit !== input.pin.commit) {
        warnings.push(
          `Room “${room.roomName}” currently runs ${scorerBuildLabel(live)} but this tournament pinned ${scorerBuildLabel(input.pin)}. Reload the room from production before it scores.`,
        );
      }
    }
  }
  // Only rooms with an actual result can claim "a scored game with no stamp". A published
  // assignment with no result yet is not-yet-observed (shown in the per-room list, not warned):
  // scoring may not have started, and crying legacy here would train operators to ignore it.
  const unverified = input.rooms.filter(
    (room) => room.matchId !== null && room.hasResult && room.build === null,
  );
  for (const room of unverified) {
    warnings.push(
      `Room “${room.roomName}” has a scored game with no build stamp, so its build cannot be verified against the pin.`,
    );
  }
  const placeholders = input.rooms.filter((room) => room.build !== null && isPlaceholderBuild(room.build));
  for (const room of placeholders) {
    warnings.push(
      `Room “${room.roomName}” reports a non-release build (${scorerBuildLabel(room.build as ScorerBuild)}). Re-pair it from production or accept it explicitly.`,
    );
  }
  if (input.pin) {
    const offPin = input.rooms.filter(
      (room) =>
        room.build !== null &&
        !isPlaceholderBuild(room.build) &&
        (room.build.version !== input.pin!.version || room.build.commit !== input.pin!.commit),
    );
    for (const room of offPin) {
      warnings.push(
        `Room “${room.roomName}” runs ${scorerBuildLabel(room.build as ScorerBuild)} but this tournament pinned ${scorerBuildLabel(input.pin)}. Reload the room from production or re-pin explicitly.`,
      );
    }
  }
  const distinct = new Map<string, string[]>();
  for (const room of input.rooms) {
    if (room.build === null || isPlaceholderBuild(room.build)) continue;
    const key = `${room.build.version} · ${room.build.commit}`;
    distinct.set(key, [...(distinct.get(key) ?? []), room.roomName]);
  }
  if (distinct.size > 1) {
    const fleets = [...distinct].map(([build, names]) => `${build} (${names.join(', ')})`);
    warnings.push(`Rooms are running ${distinct.size} different Scorer builds: ${fleets.join('; ')}.`);
  }
  return warnings;
}
