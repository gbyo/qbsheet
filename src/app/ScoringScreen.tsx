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
 * # Repair is a dialog, never a screen change
 *
 * When tournament control stops recognizing the room, the fix is a pairing code — and the one place
 * it must not be typed is a setup screen that replaced the scoresheet, because reaching that screen
 * means the game in progress was unmounted to ask a question about credentials. So the repair is a
 * dialog over a live scoresheet: the room can score a tossup mid-repair, and abandoning the repair
 * costs nothing. The same rule holds for the two repairs that need no code at all; those are
 * offered as actions on an alert and handled by the runtime without anything appearing on screen.
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
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ScorerHost from '../scorer/ScorerHost';
import ScorerDialog from '../scorer/ScorerDialog';
import { IScorerSubmitResult } from '../scorer/Scorer';
import { IStoredGameRecord, GameStore } from '../game/GameStore';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { IGameSetup } from '../scoring/deriveGame';
import { portableQbj, qbjWithSourceMetadata } from '../game/PortableQbj';
import { downloadQbj, downloadLegacyMatchOnly, downloadQbjDocument } from '../integrations/file/QbjDownload';
import { IGameDefinition } from '../game/GameDefinition';
import { buildLegacyMatchOnly, buildResultDocument } from '../qbj/QbjResult';
import { IDerivedGame } from '../scoring/deriveGame';
import { RoomConnectionState } from './ConnectionState';
import { IConnectedSession } from './ConnectedSession';
import FruityServerClient from '../integrations/fruity/FruityServerClient';
import useConnectedRuntime, { ICredentialRepair } from './useConnectedRuntime';

/** The two totals, read back out of the payload rather than derived a second time. */
export function scoreFromQbj(qbj: object): { left: number; right: number } | undefined {
  const teams = (qbj as { match_teams?: { points?: unknown }[] }).match_teams;
  if (!Array.isArray(teams) || teams.length < 2) return undefined;
  const left = teams[0]?.points;
  const right = teams[1]?.points;
  if (typeof left !== 'number' || typeof right !== 'number') return undefined;
  return { left, right };
}

/**
 * Whether a stored connection belongs to the game on screen.
 *
 * `gameRecordId` is the link, and it is checked rather than the session id because a repair may
 * legitimately reopen a game under a new session — a restarted server does that — and the record it
 * belongs to has not changed. A connection written before that field existed is matched the old
 * way, on the session id the record was keyed by, so an upgrade mid-tournament resumes rather than
 * silently dropping to offline scoring.
 */
export function connectionBelongsTo(connection: IConnectedSession | null, record: IStoredGameRecord): boolean {
  if (!connection?.sessionId || !connection.sessionToken) return false;
  if (connection.gameRecordId !== undefined) return connection.gameRecordId === record.id;
  return connection.sessionId === record.gameKey;
}

export default function ScoringScreen(props: {
  record: IStoredGameRecord;
  store: GameStore;
  connection: IConnectedSession | null;
  durable: boolean;
  onComplete: (recordId: string) => void | Promise<void>;
  /** A repair produced new credentials for the same game. Persist them; nothing else changes. */
  onConnectionRepaired: (change: Partial<IConnectedSession>) => void;
  /** The room gave up on tournament control for this game. The game continues, offline. */
  onConnectionLost: () => void;
}) {
  const { record, store, connection, onComplete, onConnectionRepaired, onConnectionLost } = props;
  const [downloadedAt, setDownloadedAt] = useState<string | undefined>(record.qbjDownloadedAt);
  const [repairing, setRepairing] = useState(false);

  /**
   * Whether this game has tournament control behind it.
   *
   * A game is connected because it was *started* connected, and the stored connection has to still
   * be the one that started it. A room that pairs again for the next game must not have the
   * previous game's credentials pointed at it.
   */
  const live = useMemo(() => {
    if (!record.connected || !connection || !connectionBelongsTo(connection, record)) return null;
    return {
      client: new FruityServerClient(connection.baseUrl),
      identity: {
        roomId: connection.roomId,
        token: connection.roomToken,
        deviceId: connection.deviceId,
        roomName: connection.roomName,
      },
      credentials: { sessionId: connection.sessionId as string, token: connection.sessionToken as string },
      tournamentKey: connection.tournamentKey,
    };
  }, [record, connection]);

  /**
   * Only the fields a repair actually produced.
   *
   * A change carrying `sessionToken: undefined` is indistinguishable from one deliberately clearing
   * it once it is spread over the stored connection, and clearing a session credential a repair
   * never touched is how a repaired game ends up with no connection at all.
   */
  const onCredentialsRepaired = useCallback(
    (repair: ICredentialRepair) => {
      onConnectionRepaired({
        ...(repair.sessionId !== undefined ? { sessionId: repair.sessionId } : {}),
        ...(repair.sessionToken !== undefined ? { sessionToken: repair.sessionToken } : {}),
      });
    },
    [onConnectionRepaired],
  );

  const onProgressSequence = useCallback(
    (sequence: number) => onConnectionRepaired({ progressSequence: sequence }),
    [onConnectionRepaired],
  );

  const runtime = useConnectedRuntime({
    // A file game still constructs a runtime, pointed at a client it never calls, because hooks may
    // not be conditional. `enabled` is what actually decides whether anything is polled.
    client: live?.client ?? new FruityServerClient(''),
    identity: live?.identity ?? { roomId: '', token: '' },
    credentials: live?.credentials ?? { sessionId: '', token: '' },
    scheduledMatchId: record.package.scheduledMatchId,
    tournamentKey: live?.tournamentKey,
    enabled: live !== null,
    onRepairConnection: live ? () => setRepairing(true) : undefined,
    onCredentialsRepaired,
    progressSequence: connection?.progressSequence,
    onProgressSequence,
  });

  /**
   * The second copy.
   *
   * The scorer has already written this to its own synchronous journal by the time this runs; this
   * puts the same history into the durable store, where it is not competing for a five-megabyte
   * quota and where it survives the journal being cleared. Nothing waits on it.
   */
  const mirror = useCallback(
    (events: ScoreEvent[], setup: IGameSetup) => {
      void store.update(record.id, { events, setup });
    },
    [record.id, store],
  );

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

  /**
   * The portable copies offered from the game menu.
   *
   * Deliberately not recorded as "the QBJ was downloaded": a mid-game partial is a lifeboat, not the
   * backup a finished game still has to produce, and marking it as one would let a room finish
   * without ever writing the result out. Only `write` sets that.
   */
  const downloadForm = useCallback(
    (game: IDerivedGame, form: 'partial' | 'legacy-match') => {
      const definition = record.package as IGameDefinition;
      const format = record.package.scorekeeperFormat;
      const meta = { round: record.package.round.number, location: record.package.room?.name };
      if (form === 'legacy-match') {
        return downloadLegacyMatchOnly(buildLegacyMatchOnly({ definition, format, game, meta }), definition);
      }
      return downloadQbjDocument(
        buildResultDocument({ definition, format, game, meta, partial: true }),
        definition,
        'partial',
      );
    },
    [record.package],
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
        const delivered = await runtime.submitFinal(qbjWithSourceMetadata(qbj, record.package));
        await store.update(record.id, {
          serverDelivery: delivered.delivery,
          // A duplicate is the correct answer to a retry, not a problem, but a room that sees
          // nothing about it has no way to know its earlier attempt had already landed.
          serverDeliveryDetail: delivered.duplicate
            ? 'Tournament control already had this result on record.'
            : delivered.detail,
        });
      }

      await onComplete(record.id);
      return { ok: true, message: 'The result is saved on this device.' };
    },
    [record.id, record.package, store, live, runtime, onComplete],
  );

  return (
    <>
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
        onDownloadForm={(game, form) => downloadForm(game, form)}
        onProgress={live ? (qbj) => runtime.reportProgress(qbjWithSourceMetadata(qbj, record.package)) : undefined}
        onEventsChanged={mirror}
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
      {repairing && live && (
        <RepairConnectionDialog
          client={live.client}
          roomId={live.identity.roomId}
          roomName={connection?.roomName ?? live.identity.roomId}
          onRepaired={(roomToken) => {
            onConnectionRepaired({ roomToken });
            setRepairing(false);
          }}
          onDisconnect={() => {
            onConnectionLost();
            setRepairing(false);
          }}
          onClose={() => setRepairing(false)}
        />
      )}
    </>
  );
}

/**
 * Pair this room again without leaving the game.
 *
 * The room is named and fixed: a repair is not an opportunity to move this Chromebook to a
 * different room mid-game, and a picker here would make that a one-tap mistake. Only the code is
 * asked for, because only the code is what expired.
 */
function RepairConnectionDialog(props: {
  client: FruityServerClient;
  roomId: string;
  roomName: string;
  onRepaired: (roomToken: string) => void;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  const { client, roomId, roomName, onRepaired, onDisconnect, onClose } = props;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const codeField = useRef<HTMLInputElement>(null);

  /**
   * Start in the field this dialog exists for.
   *
   * Here rather than through React's `autoFocus`, and the ordering is the reason. `autoFocus` moves
   * focus during the commit, before the shell it is inside has opened itself; the shell's own effect
   * then calls `showModal`, which re-runs the platform's focusing steps and lands on the first
   * control it finds, which is Close. Effects run children first, so the shell is already open by
   * the time this runs and this is the last word. Opening a dialog only to make somebody find its
   * one input is a step in the middle of a round that buys nothing.
   */
  useEffect(() => {
    codeField.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const joined = await client.join(code.trim(), roomId);
    setBusy(false);
    if (!joined.ok) {
      setError(joined.error);
      return;
    }
    onRepaired(joined.value.accessToken);
  };

  return (
    // The same shell every other dialog over this scoresheet uses, which is where Escape, the focus
    // trap and the inertness of the page behind come from. A hand-rolled box claiming `aria-modal`
    // would have none of the three, and this one asks a scorekeeper to type — with a game live
    // behind it — so Tab reaching the tossup buttons is a real way to lose a question.
    <ScorerDialog title={`Repair the connection for ${roomName}`} onClose={onClose}>
      <p className="scorer-dialog-note">
        Tournament control no longer recognizes this room. Ask for this room&apos;s pairing code and enter
        it here. The game on screen is not affected, and scoring continues either way.
      </p>
      <form className="connect-form" onSubmit={(event) => void submit(event)}>
        <label className="shell-label" htmlFor="repair-code">
          Pairing code
        </label>
        <input
          id="repair-code"
          className="shell-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          ref={codeField}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button type="submit" className="shell-button is-primary" disabled={busy || code.trim() === ''}>
          {busy ? 'Pairing…' : 'Pair this room again'}
        </button>
      </form>
      {error !== '' && (
        <p className="scorer-problem" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="scorer-choice" onClick={onDisconnect}>
        Finish this game offline
      </button>
    </ScorerDialog>
  );
}
