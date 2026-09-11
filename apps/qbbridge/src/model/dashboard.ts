/**
 * Live operations dashboard model (#1012).
 *
 * One screen answers "which room needs attention and why" from signals the protocol
 * already exposes: relay sessions with writer presence, open help requests, the local
 * result ledger, relay health counters, and the folder's last durable write. Anything
 * the protocol cannot know is labeled unknown instead of guessed:
 *
 * - per-room Scorer builds are not tracked by the relay (needs #1010);
 * - LAN transport does not exist yet (needs #1013), so transport reads Internet/local-only;
 * - YellowFruit import state is the operator's local mark, not a verified feed;
 * - free disk space needs a destination probe (needs #1011).
 *
 * Redaction runs at the relay boundary (relay.ts drops operator names, help messages,
 * and device identities) and the diagnostics bundle carries counts, ids, and statuses
 * only — no credentials, codes, QBJ payloads, or team/player names. `dashboard.test.ts`
 * plants hostile values through every input and asserts none survive.
 *
 * Session data is matched to the published game by match id, never by recency: a live
 * heartbeat for another game downgrades the room instead of reading as scoring now.
 */

import type { DirectorHelp, DirectorSession, RelayHealth } from './relay';
import type { RoomStatus } from './rooms';

export type RoomAttentionLevel = 'ok' | 'watch' | 'attention';

export interface DashboardRoomInput {
  roomId: string;
  name: string;
  status: RoomStatus;
  publishedMatchId: string | null;
  relayPublished: boolean;
}

export interface DashboardLedgerInput {
  resultId: string;
  matchId: string | null;
  saved: boolean;
  ackPending: boolean;
}

export interface RoomAttention {
  roomId: string;
  name: string;
  status: RoomStatus;
  level: RoomAttentionLevel;
  headline: string;
  detail: string | null;
  transport: 'internet-relay' | 'local-only';
  /** Last presence heartbeat seen for any session in this room, if any. Never a device id. */
  lastSeen: string | null;
  helpCategories: string[];
  openSession: boolean;
  /** Distinct relay match ids with sessions in this room — ambiguity is display, not a guess. */
  sessionMatchIds: string[];
  sessionCount: number;
  silent: boolean;
}

export interface DashboardQuota {
  meteredRequests: number | null;
  rowsWritten: number | null;
  resultsUnacked: number | null;
  helpOpen: number | null;
}

/**
 * A snapshot older than this reads as stale, not current. The refresh cadence is 30s; three
 * missed intervals means the refresher is wedged or the tab was suspended — either way the
 * rooms below describe the past, and the screen must say so.
 */
export const dashboardSnapshotStaleAfterMs = 90_000;

export interface DashboardGlobal {
  connected: boolean;
  snapshotStale: boolean;
  reachable: boolean | null;
  epoch: number | null;
  revision: number | null;
  protocolVersion: number | null;
  lifecycle: string | null;
  controller: string | null;
  backupProvisioned: boolean | null;
  quota: DashboardQuota | null;
  resultFolder: string | null;
  lastWriteAt: string | null;
  tournament: { name: string; teams: number; rounds: number } | null;
  fetchedAt: string | null;
  operationsError: string | null;
}

export type OperationsEventKind =
  'publish' | 'takeover' | 'transfer' | 'save' | 'reachability' | 'relay-change' | 'forget' | 'reconcile';

export interface OperationsEvent {
  at: string;
  kind: OperationsEventKind;
  /** Pre-redacted by the call site: ids, counts, outcomes. Never secrets or names. */
  detail: string;
}

export interface DiagnosticsBundle {
  bridge: { version: string; exportedAt: string };
  relay: {
    tournamentId: string;
    epoch: number;
    revision: number;
    protocolVersion: number | null;
    lifecycle: string | null;
    controller: string | null;
    backupProvisioned: boolean | null;
    storage: Record<string, number> | null;
    counters: Record<string, number> | null;
  } | null;
  rooms: { roomId: string; name: string; status: RoomStatus; level: RoomAttentionLevel }[];
  ledger: { resultId: string; saved: boolean; ackPending: boolean }[];
  folder: { path: string | null; lastWriteAt: string | null };
  timeline: OperationsEvent[];
}

export interface DashboardInput {
  nowMs: number;
  rooms: DashboardRoomInput[];
  sessions: DirectorSession[];
  openHelp: DirectorHelp[];
  ledger: DashboardLedgerInput[];
  relayConnected: boolean;
  relayReachable: boolean | null;
  health: RelayHealth | null;
  operationsError: string | null;
  fetchedAt: string | null;
  resultFolder: string | null;
  lastWriteAt: string | null;
  tournament: { name: string; teams: number; rounds: number } | null;
  timeline: OperationsEvent[];
  bridgeVersion: string;
}

/** A room with an open session but no activity this long reads as quiet, not broken. */
export const dashboardQuietAfterMs = 15 * 60 * 1000;

function ageString(nowMs: number, at: string): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return 'unknown';
  const minutes = Math.max(0, Math.round((nowMs - ms) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function lastActivityMs(session: DirectorSession): number {
  const stamps = [session.updatedAt, ...session.presence.map((item) => item.updatedAt)]
    .map((at) => Date.parse(at))
    .filter((ms) => !Number.isNaN(ms));
  return stamps.length === 0 ? Number.NaN : Math.max(...stamps);
}

function attendRoom(
  room: DashboardRoomInput,
  sessions: DirectorSession[],
  help: DirectorHelp[],
  ledger: DashboardLedgerInput[],
  transport: 'internet-relay' | 'local-only',
  nowMs: number,
): RoomAttention {
  const roomSessions = sessions.filter((session) => session.roomId === room.roomId);
  const openSession = roomSessions.some((session) => session.status === 'open');
  const livePresence = roomSessions
    .flatMap((session) => session.presence)
    .filter((item) => Date.parse(item.expiresAt) > nowMs);
  const lastSeen =
    roomSessions
      .flatMap((session) => session.presence.map((item) => item.updatedAt))
      .filter((at) => !Number.isNaN(Date.parse(at)))
      .sort()
      .at(-1) ?? null;
  const sessionMatchIds = [...new Set(roomSessions.map((session) => session.matchId))];
  // A heartbeat for another game must never read as scoring this one: the room's live
  // presence only speaks for the published match when a session actually names it.
  const matchesPublished = room.publishedMatchId !== null && sessionMatchIds.includes(room.publishedMatchId);
  const helpCategories = [...new Set(help.map((entry) => entry.category))];
  const matchLedger = room.publishedMatchId
    ? ledger.filter((entry) => entry.matchId === room.publishedMatchId)
    : [];
  const unsavedFinal = matchLedger.some((entry) => !entry.saved);
  const ackPendingFinal = matchLedger.some((entry) => entry.saved && entry.ackPending);
  const activity = roomSessions.map(lastActivityMs).filter((ms) => !Number.isNaN(ms));
  const silent = openSession && activity.length > 0 && nowMs - Math.max(...activity) > dashboardQuietAfterMs;

  let level: RoomAttentionLevel = 'ok';
  let headline = 'Idle';
  let detail: string | null = null;
  if (help.length > 0) {
    level = 'attention';
    headline = `Help requested (${helpCategories.join(', ')})`;
    detail = 'Answer in the room, then reconcile through the help flow.';
  } else if (unsavedFinal) {
    level = 'attention';
    headline = 'Final received, not saved';
    detail = 'Save the result before anything else can acknowledge it.';
  } else if (ackPendingFinal) {
    level = 'attention';
    headline = 'Saved, ACK pending';
    detail = 'The relay still lists this final as unacknowledged; the next poll retries.';
  } else if (!room.relayPublished) {
    headline = 'Not published yet';
  } else if (roomSessions.length === 0) {
    level = 'watch';
    headline = 'Published, no scorer session';
    detail = 'Nobody has paired or scored in this room since the publish.';
  } else if (room.publishedMatchId !== null && openSession && !matchesPublished) {
    // The dangerous ambiguity: live heartbeats exist, but every open session names a
    // different game than the published one. This downgrades 'Scoring now', never feeds it.
    level = 'watch';
    headline = 'Session for a different game';
    detail =
      `The relay holds open session(s) for ${sessionMatchIds.join(', ')}, but this room published ` +
      `${room.publishedMatchId}. Confirm which game the room should score before trusting activity here.`;
  } else if (openSession && livePresence.length === 0) {
    level = 'watch';
    headline = lastSeen
      ? `Scorer offline (last seen ${ageString(nowMs, lastSeen)})`
      : 'Paired, no heartbeat yet';
    detail = 'The game state is safe on the relay; no live heartbeat is refreshing presence.';
  } else if (silent) {
    level = 'watch';
    headline = 'Quiet for a while';
    detail = 'An open session with no activity past the quiet threshold.';
  } else if (livePresence.length > 0 && (room.publishedMatchId === null || matchesPublished)) {
    headline = 'Scoring now';
  } else if (room.status === 'result-received') {
    headline = 'Final received';
  } else {
    headline = 'Waiting';
  }

  return {
    roomId: room.roomId,
    name: room.name,
    status: room.status,
    level,
    headline,
    detail,
    transport,
    lastSeen,
    helpCategories,
    openSession,
    sessionMatchIds,
    sessionCount: roomSessions.length,
    silent,
  };
}

export interface OperationsDashboard {
  rooms: RoomAttention[];
  attentionCount: number;
  global: DashboardGlobal;
  diagnostics: DiagnosticsBundle;
}

/**
 * Build the whole dashboard from already-fetched state. Pure: every signal arrives as
 * data, so the attention matrix, silence rules, quota strip, and the redacted bundle
 * are all unit-testable with no relay and no clock beyond the injected now.
 */
export function buildOperationsDashboard(input: DashboardInput): OperationsDashboard {
  const transport: 'internet-relay' | 'local-only' =
    input.relayConnected && input.relayReachable !== false ? 'internet-relay' : 'local-only';
  const rooms = input.rooms.map((room) =>
    attendRoom(
      room,
      input.sessions,
      input.openHelp.filter((entry) => entry.roomId === room.roomId),
      input.ledger,
      transport,
      input.nowMs,
    ),
  );
  const attentionCount = rooms.filter((room) => room.level === 'attention').length;

  const quota: DashboardQuota | null = input.health
    ? {
        meteredRequests:
          input.health.counters?.metered_requests_estimate ?? input.health.counters?.meteredRequests ?? null,
        rowsWritten: input.health.counters?.rows_written_estimate ?? null,
        resultsUnacked: input.health.storage?.results_unacked ?? null,
        helpOpen: input.health.storage?.help_open ?? null,
      }
    : null;

  const fetchedMs = input.fetchedAt === null ? Number.NaN : Date.parse(input.fetchedAt);
  const global: DashboardGlobal = {
    connected: input.relayConnected,
    // No snapshot at all is "not yet", not stale — the view already says that.
    snapshotStale:
      input.fetchedAt !== null &&
      (Number.isNaN(fetchedMs) || input.nowMs - fetchedMs > dashboardSnapshotStaleAfterMs),
    reachable: input.relayReachable,
    epoch: input.health?.directorEpoch ?? null,
    revision: input.health?.revision ?? null,
    protocolVersion: input.health?.protocolVersion ?? null,
    lifecycle: input.health?.lifecycle ?? null,
    controller: input.health ? input.health.authenticatedAs : null,
    backupProvisioned: input.health?.backupProvisioned ?? null,
    quota,
    resultFolder: input.resultFolder,
    lastWriteAt: input.lastWriteAt,
    tournament: input.tournament,
    fetchedAt: input.fetchedAt,
    operationsError: input.operationsError,
  };

  const diagnostics: DiagnosticsBundle = {
    bridge: { version: input.bridgeVersion, exportedAt: new Date(input.nowMs).toISOString() },
    relay: input.health
      ? {
          tournamentId: input.health.tournamentId,
          epoch: input.health.directorEpoch,
          revision: input.health.revision,
          protocolVersion: input.health.protocolVersion,
          lifecycle: input.health.lifecycle,
          controller: input.health.authenticatedAs,
          backupProvisioned: input.health.backupProvisioned,
          storage: input.health.storage,
          counters: input.health.counters,
        }
      : null,
    rooms: rooms.map((room) => ({
      roomId: room.roomId,
      name: room.name,
      status: room.status,
      level: room.level,
    })),
    ledger: input.ledger.map((entry) => ({
      resultId: entry.resultId,
      saved: entry.saved,
      ackPending: entry.ackPending,
    })),
    folder: { path: input.resultFolder, lastWriteAt: input.lastWriteAt },
    timeline: input.timeline.slice(-20),
  };

  return { rooms, attentionCount, global, diagnostics };
}
