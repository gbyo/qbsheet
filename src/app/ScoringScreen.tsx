/**
 * The scoresheet, wired to this device and — if there is one — to tournament control.
 *
 * # What this file is allowed to decide
 *
 * Which callbacks the scorer gets. Nothing else. It does not decide what a tossup is worth, when a
 * lineup may change, or whether a game is over; all of that is `deriveGame` and the format. And it
 * does not decide whether the scoresheet is on screen: the only transition out of here is a
 * scorekeeper submitting a finished game, and even that happens only once the result is durably
 * recorded locally.
 *
 * # The order of a submission
 *
 *   1. Build the portable result and write it to the local record, with the completion time.
 *   2. If that write failed, say so and stay. Nothing else happens.
 *   3. Only then, try to deliver it to tournament control.
 *   4. Whatever became of step 3, move to the completion screen, which asks for the backup.
 *
 * Step 3 cannot fail in a way that costs the room anything, because step 1 already happened. That
 * is the whole design.
 */
import { useCallback, useMemo, useState } from 'react';
import ScorerHost from '../scorer/ScorerHost';
import { IScorerSubmitResult } from '../scorer/Scorer';
import { IStoredGameRecord, GameStore } from '../game/GameStore';
import { portableQbj } from '../game/PortableQbj';
import { downloadQbj } from '../integrations/file/QbjDownload';
import { RoomConnectionState } from './ConnectionState';
import { IConnectedSession } from './ConnectedSession';
import FruityServerClient from '../integrations/fruity/FruityServerClient';
import useConnectedRuntime from './useConnectedRuntime';

/** The two totals, read back out of the payload rather than derived a second time. */
export function scoreFromQbj(qbj: object): { left: number; right: number } | undefined {
  const teams = (qbj as { match_teams?: { points?: unknown }[] }).match_teams;
  if (!Array.isArray(teams) || teams.length < 2) return undefined;
  const left = teams[0]?.points;
  const right = teams[1]?.points;
  if (typeof left !== 'number' || typeof right !== 'number') return undefined;
  return { left, right };
}

export default function ScoringScreen(props: {
  record: IStoredGameRecord;
  store: GameStore;
  connection: IConnectedSession | null;
  durable: boolean;
  onComplete: (recordId: string) => void | Promise<void>;
  onConnectionLost: () => void;
}) {
  const { record, store, connection, onComplete } = props;
  const [downloadedAt, setDownloadedAt] = useState<string | undefined>(record.qbjDownloadedAt);

  /**
   * Whether this game has tournament control behind it.
   *
   * A game is connected because it was *started* connected, and the stored connection has to still
   * be the one that started it. A room that pairs again for the next game must not have the
   * previous game's credentials pointed at it.
   */
  const live = useMemo(() => {
    if (!record.connected || !connection?.sessionId || !connection.sessionToken) return null;
    if (connection.sessionId !== record.gameKey) return null;
    return {
      client: new FruityServerClient(connection.baseUrl),
      identity: {
        roomId: connection.roomId,
        token: connection.roomToken,
        deviceId: connection.deviceId,
      },
      credentials: { sessionId: connection.sessionId, token: connection.sessionToken },
      tournamentKey: connection.tournamentKey,
    };
  }, [record.connected, record.gameKey, connection]);

  const runtime = useConnectedRuntime({
    // A file game still constructs a runtime, pointed at a client it never calls, because hooks may
    // not be conditional. `enabled` is what actually decides whether anything is polled.
    client: live?.client ?? new FruityServerClient(''),
    identity: live?.identity ?? { roomId: '', token: '' },
    credentials: live?.credentials ?? { sessionId: '', token: '' },
    scheduledMatchId: record.package.scheduledMatchId,
    tournamentKey: live?.tournamentKey,
    enabled: live !== null,
  });

  const write = useCallback(
    (qbj: object) => {
      const written = downloadQbj(qbj, record.package);
      if (written) {
        const at = new Date().toISOString();
        setDownloadedAt(at);
        void store.update(record.id, { qbjDownloadedAt: at });
      }
      return written;
    },
    [record.id, record.package, store],
  );

  const submit = useCallback(
    async (qbj: object): Promise<IScorerSubmitResult> => {
      const portable = portableQbj(qbj, record.package);
      const completedAt = new Date().toISOString();
      const saved = await store.update(record.id, {
        completedAt,
        finalQbj: portable,
        finalScore: scoreFromQbj(portable),
      });
      if (!saved) {
        return {
          ok: false,
          message:
            'This device could not save the finished result. Do not close this tab. Download the QBJ backup now.',
        };
      }

      if (live) {
        const delivered = await runtime.submitFinal(qbj);
        await store.update(record.id, {
          serverDelivery: delivered.ok ? 'sent' : delivered.status === undefined ? 'pending' : 'rejected',
          serverDeliveryDetail: delivered.ok ? undefined : delivered.detail ?? delivered.error,
        });
      }

      await onComplete(record.id);
      return { ok: true, message: 'The result is saved on this device.' };
    },
    [record.id, record.package, store, live, runtime, onComplete],
  );

  return (
    <ScorerHost
      key={record.gameKey}
      gameKey={record.gameKey}
      format={record.package.scorekeeperFormat}
      leftTeam={record.package.left}
      rightTeam={record.package.right}
      tournamentName={record.package.tournament.name}
      roundName={record.package.round.name}
      roomName={record.package.room?.name}
      packetName={record.package.round.packetName}
      procedure={record.package.procedure}
      connection={live ? runtime.connection : RoomConnectionState.Connected}
      degradedMessage={live ? runtime.degradedMessage : undefined}
      onSubmit={submit}
      onDownload={write}
      onProgress={live ? (qbj) => runtime.reportProgress(qbj) : undefined}
      qbjMeta={{
        round: record.package.round.number,
        location: record.package.room?.name,
      }}
      onRequestControl={live ? runtime.requestControl : undefined}
      controlRequestPending={runtime.controlRequestPending}
      onSyncRosterPlayer={live ? runtime.syncRosterPlayer : undefined}
      onRecoverFromServer={live ? runtime.recoverFromServer : undefined}
      alerts={live ? runtime.alerts : []}
      recovery={{
        serverSnapshotAt: live ? runtime.serverSnapshotAt : undefined,
        snapshotError: live ? runtime.snapshotError : undefined,
        // A file game is not waiting for anything and must never be told a result will be sent.
        automaticDelivery: live !== null && runtime.automaticDelivery,
        delivery: downloadedAt ? 'hand-over' : undefined,
      }}
    />
  );
}
