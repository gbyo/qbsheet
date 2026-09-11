/**
 * Live operations dashboard (#1012): which room needs attention and why, on one screen.
 *
 * Room attention comes from relay sessions with writer presence, open help requests,
 * and the local result ledger; the global strip adds relay epoch/revision, quota
 * counters, the result folder's last durable write, and recovery posture. Anything the
 * protocol cannot know reads as unknown, never as a guess. The diagnostics bundle is
 * redacted by construction (see dashboard.ts) and can be copied for support.
 */

import { useMemo, useState } from 'react';
import { Button } from '@qbsheet/ui';
import { buildOperationsDashboard } from '../model/dashboard';
import { resultMatchId } from '../model/results';
import type { BridgeApi } from '../model/useBridge';
import packageJson from '../../package.json';

const levelOrder = { attention: 0, watch: 1, ok: 2 } as const;

export default function OperationsView({ bridge }: { bridge: BridgeApi }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  const dashboard = useMemo(
    () =>
      buildOperationsDashboard({
        nowMs,
        rooms: bridge.state.rooms.map((room) => ({
          roomId: room.id,
          name: room.name,
          status: bridge.roomStatus(room),
          publishedMatchId: room.publishedMatchId,
          relayPublished: room.relayPublished,
        })),
        sessions: bridge.operations?.sessions ?? [],
        openHelp: bridge.operations?.help ?? [],
        ledger: bridge.state.results.map((entry) => ({
          resultId: entry.resultId,
          matchId: resultMatchId(entry.qbj),
          saved: entry.savedPath !== undefined,
          ackPending: entry.ackPending === true,
        })),
        relayConnected: bridge.state.relay !== null,
        relayReachable: bridge.relayReachable,
        health: bridge.operations?.health ?? null,
        operationsError: bridge.operations?.error ?? null,
        fetchedAt: bridge.operations?.fetchedAt ?? null,
        resultFolder: bridge.state.resultFolder,
        lastWriteAt: bridge.lastWriteAt,
        tournament: bridge.tournament
          ? {
              name: bridge.tournament.name,
              teams: bridge.tournament.teams.length,
              rounds: bridge.tournament.rounds.length,
            }
          : null,
        timeline: bridge.operationsTimeline,
        bridgeVersion: typeof packageJson.version === 'string' ? packageJson.version : 'unknown',
      }),
    [bridge, nowMs],
  );

  const rooms = useMemo(
    () =>
      [...dashboard.rooms].sort(
        (left, right) =>
          levelOrder[left.level] - levelOrder[right.level] || left.name.localeCompare(right.name),
      ),
    [dashboard],
  );

  const refresh = () => {
    setNowMs(Date.now());
    void bridge.refreshOperations();
  };

  const copyBundle = async () => {
    const text = JSON.stringify(dashboard.diagnostics, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const { global } = dashboard;

  return (
    <div>
      <section className="panel">
        <div className="row">
          <h2>Operations</h2>
          <span style={{ flex: 1 }} />
          <Button
            onPress={refresh}
            isDisabled={bridge.busy || bridge.operationsRunning || !bridge.state.relay}
          >
            {bridge.operationsRunning ? 'Refreshing…' : 'Refresh now'}
          </Button>
        </div>
        <p className="muted">
          {dashboard.attentionCount === 0
            ? 'No room needs attention.'
            : `${dashboard.attentionCount} room(s) need attention.`}{' '}
          {global.fetchedAt ? (
            <span className="faint">Relay snapshot {new Date(global.fetchedAt).toLocaleTimeString()}</span>
          ) : (
            <span className="faint">No relay snapshot yet — connect a relay.</span>
          )}{' '}
          {global.operationsError ? (
            <span className="faint">Last snapshot failed: {global.operationsError}</span>
          ) : null}
        </p>
      </section>

      <section className="panel">
        <h2>Relay and destination</h2>
        <dl className="facts">
          <dt>Relay</dt>
          <dd>
            {!global.connected
              ? 'Not connected'
              : global.reachable === false
                ? `Unreachable — rooms read local-only (epoch ${global.epoch ?? '?'})`
                : `epoch ${global.epoch ?? '?'}, revision ${global.revision ?? '?'}`}
          </dd>
          <dt>Quota</dt>
          <dd>
            {global.quota
              ? `${global.quota.meteredRequests ?? '?'} metered requests · ` +
                `${global.quota.rowsWritten ?? '?'} rows written · ` +
                `${global.quota.resultsUnacked ?? '?'} unacked · ` +
                `${global.quota.helpOpen ?? '?'} help open`
              : 'No counters yet'}
          </dd>
          <dt>Controller</dt>
          <dd>
            {global.controller
              ? `acting as ${global.controller}${global.backupProvisioned ? ', backup provisioned' : ', no backup provisioned'}`
              : 'Unknown'}
          </dd>
          <dt>Result folder</dt>
          <dd>
            {global.resultFolder ?? 'Not chosen'}
            {global.lastWriteAt
              ? ` · last durable write ${new Date(global.lastWriteAt).toLocaleTimeString()}`
              : ''}
          </dd>
        </dl>
        <p className="faint">
          Snapshots refresh every 30s plus manual refreshes, so this screen cannot materially move relay quota
          itself. Per-room Scorer builds are not tracked by the relay protocol yet; free disk space needs a
          destination probe.
        </p>
      </section>

      <section className="panel">
        <h2>Rooms</h2>
        {rooms.length === 0 ? <p className="muted">No rooms yet.</p> : null}
        <ul className="plain">
          {rooms.map((room) => (
            <li key={room.roomId}>
              <strong>{room.level === 'ok' ? 'OK' : room.level === 'watch' ? 'Watch' : 'Attention'}:</strong>{' '}
              {room.name} — {room.headline}
              {room.detail ? <span className="muted"> · {room.detail}</span> : null}{' '}
              <span className="faint">
                ({room.status}; {room.transport === 'internet-relay' ? 'relay' : 'local-only'}
                {room.writerDevice ? `; writer ${room.writerDevice}` : ''}
                {room.helpCategories.length > 0 ? `; help: ${room.helpCategories.join(', ')}` : ''})
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Diagnostics bundle</h2>
        <p className="muted">
          Redacted operational facts for support: versions, relay health, per-room levels, result ledger
          statuses, folder health, and the recent timeline. No credentials, codes, QBJ payloads, or names.
        </p>
        <div className="row">
          <Button onPress={() => void copyBundle()}>{copied ? 'Copied' : 'Copy bundle'}</Button>
        </div>
        <details>
          <summary>Show bundle</summary>
          <pre>{JSON.stringify(dashboard.diagnostics, null, 2)}</pre>
        </details>
        {bridge.operationsTimeline.length > 0 ? (
          <>
            <h3>Recent timeline</h3>
            <ul className="plain faint">
              {bridge.operationsTimeline.slice(-8).map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  {new Date(entry.at).toLocaleTimeString()} · {entry.kind} · {entry.detail}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  );
}
