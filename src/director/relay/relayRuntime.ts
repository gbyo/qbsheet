import { useCallback, useEffect, useRef } from 'react';
import type { DirectorState } from '../domain';
import type { NativeRoomPairingInvitation } from '../platform/native';
import { buildAssignment } from '../transfers/assignment';
import { currentOperationalRound } from '../transfers/deliveryStatus';
import type { AnnounceInput } from '../notices';
import type { RelayConfig } from './relayConfig';
import { readRelayCredential } from './relayCredentials';
import { fetchRelayManagementHealth } from './relayStatus';
import {
  acknowledgeRelayItems,
  buildRelayMirrorDocument,
  fetchOpenRelayHelp,
  fetchRelaySessionSnapshot,
  fetchUnackedRelayResults,
  publishRelayMirror,
  summarizeRelayReconnect,
  type RelayMirrorBuildResult,
  type RelayMirrorRoomInput,
  type RelaySessionSnapshot,
  type RelaySyncConnection,
  type RelaySyncHelp,
} from './relaySync';
import type { RelayIngestInput, RelayIngestSummary } from '../state/useDirectorController';

export const relaySyncIntervalMs = 5_000;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildDirectorRelayMirror(
  state: DirectorState,
  invitations: NativeRoomPairingInvitation[],
  revision: number,
  now = Date.now(),
): Promise<RelayMirrorBuildResult> {
  const round = currentOperationalRound(state);
  const games = round
    ? state.scheduledGames.filter(
        (game) =>
          game.roundId === round.id &&
          !game.bye &&
          game.roomId &&
          game.status !== 'accepted' &&
          game.status !== 'cancelled',
      )
    : [];
  const gamesByRoom = new Map<string, (typeof games)[number]>();
  for (const game of games) {
    if (!game.roomId || gamesByRoom.has(game.roomId)) {
      return { ok: false, error: 'The operational round assigns more than one game to a room.' };
    }
    gamesByRoom.set(game.roomId, game);
  }
  const invitationsByRoom = new Map(
    invitations
      .filter((invitation) => {
        const expiresAt = Date.parse(invitation.expiresAt);
        return Number.isFinite(expiresAt) && expiresAt > now;
      })
      .map((invitation) => [invitation.roomId, invitation]),
  );
  let rooms: RelayMirrorRoomInput[];
  try {
    rooms = await Promise.all(
      state.rooms.map(async (room) => {
        const invitation = invitationsByRoom.get(room.id);
        const game = gamesByRoom.get(room.id);
        const built = game ? buildAssignment(state, game.id) : null;
        if (built && !built.ok) throw new Error(built.failure.reason);
        return {
          roomId: room.id,
          name: room.name,
          ...(invitation
            ? {
                pairingCodeHash: await sha256Hex(invitation.pairingCode),
                pairingExpiresAt: invitation.expiresAt,
              }
            : {}),
          ...(built?.ok
            ? {
                assignmentQbj: built.assignment.document,
                matchId: built.assignment.matchId,
                roundRevision: built.assignment.roundRevision,
                assignmentRevision: built.assignment.assignmentRevision,
              }
            : {}),
        };
      }),
    );
  } catch (reason) {
    return { ok: false, error: reason instanceof Error ? reason.message : 'The relay mirror is invalid.' };
  }
  const knownRooms = new Set(state.rooms.map((room) => room.id));
  const sessions = state.qbtcpSessions.flatMap((session) => {
    if (!knownRooms.has(session.roomId) || !session.matchId) return [];
    return [
      {
        sessionId: session.sessionId,
        roomId: session.roomId,
        matchId: session.matchId,
        status:
          session.state === 'result-received'
            ? ('final-received' as const)
            : session.state === 'abandoned'
              ? ('abandoned' as const)
              : ('open' as const),
        ...(session.deviceId ? { activeWriterDeviceId: session.deviceId } : {}),
      },
    ];
  });
  return buildRelayMirrorDocument({
    directorEpoch: 1,
    revision,
    tournamentName: state.tournament?.name,
    rooms,
    sessions,
  });
}

function mirrorDigest(document: Record<string, unknown>): string {
  const content = { ...document };
  delete content.revision;
  return JSON.stringify(content);
}

export interface RelayRuntimeIngestor {
  ingestRelayItems(input: RelayIngestInput): Promise<RelayIngestSummary>;
}

export interface RelaySyncCycleInput {
  config: RelayConfig;
  managementToken: string;
  state: DirectorState;
  invitations: NativeRoomPairingInvitation[];
  ingestor: RelayRuntimeIngestor;
  previousMirrorDigest: string | null;
  fetchImpl?: typeof fetch;
}

export interface RelaySyncCycleResult {
  mirrorDigest: string | null;
  ingest: RelayIngestSummary;
  warning: Error | null;
}

export async function runRelaySyncCycle(input: RelaySyncCycleInput): Promise<RelaySyncCycleResult> {
  const connection: RelaySyncConnection = {
    baseUrl: input.config.baseUrl,
    tournamentId: input.config.tournamentId,
    managementToken: input.managementToken,
    fetchImpl: input.fetchImpl,
  };
  let nextMirrorDigest = input.previousMirrorDigest;
  let warning: Error | null = null;
  try {
    const health = await fetchRelayManagementHealth(
      input.config.baseUrl,
      input.config.tournamentId,
      input.managementToken,
      input.fetchImpl,
    );
    const built = await buildDirectorRelayMirror(
      input.state,
      input.invitations,
      (health.mirrorRevision ?? 0) + 1,
    );
    if (!built.ok) throw new Error(built.error);
    const digest = mirrorDigest(built.document);
    if (digest !== input.previousMirrorDigest) {
      await publishRelayMirror(connection, built.document);
      nextMirrorDigest = digest;
    }
  } catch (reason) {
    warning = reason instanceof Error ? reason : new Error('The relay mirror could not be updated.');
  }

  const results = await fetchUnackedRelayResults(connection);
  let help: RelaySyncHelp[] = [];
  let sessions: RelaySessionSnapshot[] = [];
  try {
    help = await fetchOpenRelayHelp(connection);
  } catch (reason) {
    warning ??= reason instanceof Error ? reason : new Error('Relay help could not be synchronized.');
  }
  try {
    sessions = (await fetchRelaySessionSnapshot(connection)).sessions;
  } catch (reason) {
    warning ??= reason instanceof Error ? reason : new Error('Relay sessions could not be synchronized.');
  }
  const ingest = await input.ingestor.ingestRelayItems({
    tournamentId: input.config.tournamentId,
    results,
    help,
    sessions,
  });
  if (!ingest.durable) {
    throw new Error('Relay items could not be acknowledged because Director storage is not durable.');
  }
  await acknowledgeRelayItems(connection, { results: ingest.resultIds, help: ingest.helpIds });
  return { mirrorDigest: nextMirrorDigest, ingest, warning };
}

export function useRelaySyncRuntime(options: {
  active: boolean;
  config: RelayConfig | null;
  state: DirectorState;
  invitations: NativeRoomPairingInvitation[];
  ingestor: RelayRuntimeIngestor;
  onAnnounce: (announcement: AnnounceInput) => void;
}): void {
  const latest = useRef(options);
  const inFlight = useRef<Promise<void> | null>(null);
  const mirror = useRef<{ key: string; digest: string | null }>({ key: '', digest: null });
  const lastWarning = useRef<string | null>(null);
  useEffect(() => {
    latest.current = options;
  }, [options]);

  const synchronize = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const current = latest.current;
    const config = current.config;
    if (!current.active || !config?.enabled) return Promise.resolve();
    const key = `${config.baseUrl}|${config.tournamentId}`;
    if (mirror.current.key !== key) {
      mirror.current = { key, digest: null };
      lastWarning.current = null;
    }
    const task = (async () => {
      const token = await readRelayCredential(config.tournamentId);
      if (!token) throw new Error('The Internet QBTCP management credential is unavailable.');
      const result = await runRelaySyncCycle({
        config,
        managementToken: token,
        state: current.state,
        invitations: current.invitations,
        ingestor: current.ingestor,
        previousMirrorDigest: mirror.current.digest,
      });
      mirror.current = { key, digest: result.mirrorDigest };
      const message = summarizeRelayReconnect({
        results: result.ingest.resultsAdded,
        help: result.ingest.helpAdded,
      });
      if (message) current.onAnnounce({ tone: 'success', message });
      if (result.warning) throw result.warning;
      lastWarning.current = null;
    })().catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : 'Internet QBTCP synchronization failed.';
      if (lastWarning.current !== message) {
        current.onAnnounce({ tone: 'warning', message });
        lastWarning.current = message;
      }
    });
    inFlight.current = task;
    void task.finally(() => {
      if (inFlight.current === task) inFlight.current = null;
    });
    return task;
  }, []);

  useEffect(() => {
    if (!options.active || !options.config?.enabled) return;
    void synchronize();
    const interval = window.setInterval(() => void synchronize(), relaySyncIntervalMs);
    return () => window.clearInterval(interval);
  }, [
    options.active,
    options.config?.baseUrl,
    options.config?.enabled,
    options.config?.tournamentId,
    synchronize,
  ]);

  useEffect(() => {
    if (options.active && options.config?.enabled) void synchronize();
  }, [options.active, options.config?.enabled, options.state, options.invitations, synchronize]);
}
