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
import { connectionTimeline } from './ConnectionTimeline';
import { useAppUpdate } from '../pwa/useAppUpdate';
import { updateDeferredAlert } from '../pwa/UpdateNotice';
import { ResultDeliveryService } from './ResultDelivery';
import { IScoringRulesCorrection, ScoringRulesCorrectionRefusal } from '../scorer/ScoringRulesCorrectionDialog';

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
  /** Shared completed-result delivery boundary, including the private retry capability. */
  resultDelivery: ResultDeliveryService;
  connection: IConnectedSession | null;
  durable: boolean;
  /** Optional device identity included in the portable result and connected presence headers. */
  operatorName?: string;
  /** True when the record store is currently healthy as well as backed by IndexedDB. */
  storageDegraded?: boolean;
  /** `acceptedJustNow` is a transient presentation fact, never persisted as game state. */
  onComplete: (recordId: string, acceptedJustNow?: boolean) => void | Promise<void>;
  /** Re-read the stored record, after something outside the scorer's own event history changed it. */
  onRecordChanged: () => void | Promise<void>;
  /** A repair produced new credentials for the same game. Persist them; nothing else changes. */
  onConnectionRepaired: (change: Partial<IConnectedSession>) => void;
  /** The room gave up on tournament control for this game. The game continues, offline. */
  onConnectionLost: () => void;
}) {
  const {
    record,
    store,
    resultDelivery,
    connection,
    durable,
    operatorName,
    storageDegraded = false,
    onComplete,
    onRecordChanged,
    onConnectionRepaired,
    onConnectionLost,
  } = props;
  const [downloadedAt, setDownloadedAt] = useState<string | undefined>(record.qbjDownloadedAt);
  /**
   * How many times the rules have been corrected in this sitting. Part of the scorer's key.
   *
   * A correction changes the format and, when an answer type moved position, the events that point
   * at it. Those two have to take effect together or the scoresheet spends a render pricing buzzes
   * against the wrong buttons — a render that `onProgress` could sample and send to tournament
   * control. Remounting the scorer makes it re-read both from the journal in one pass, which is the
   * only place the pair is atomic.
   *
   * The cost is the undo stack, which does not survive the remount. That is the right thing to lose:
   * "undo" across a rules change would have to mean undoing the change or undoing a question priced
   * under rules that no longer apply, and neither is what anybody would press it for.
   */
  const [ruleRevision, setRuleRevision] = useState(0);
  const [recordDurablyStored, setRecordDurablyStored] = useState(durable && !storageDegraded);
  const [repairing, setRepairing] = useState(false);
  const update = useAppUpdate();

  // A store that has stopped being durable cannot still be holding this game durably. Applied when
  // the answer changes rather than on every render, so a write that reports success against the
  // store's own view is not overruled by a prop that has not caught up yet.
  const [durability, setDurability] = useState({ durable, storageDegraded });
  if (durability.durable !== durable || durability.storageDegraded !== storageDegraded) {
    setDurability({ durable, storageDegraded });
    if (!durable || storageDegraded) setRecordDurablyStored(false);
  }

  /**
   * Whether this screen is still on the page.
   *
   * The durable writes below are deliberately unwaited, so one can land after the room has ended the
   * game and moved on and this screen is gone. Reporting durability into a tree that is no longer
   * mounted is at best a no-op; under a test runner it is an unhandled rejection that fails a run
   * where every assertion passed. The `cancelled` flag in `App` guards the same hazard from an
   * effect; these writes start from callbacks, so the flag has to outlive a render.
   */
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

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
        operatorName: operatorName?.trim() || undefined,
        roomName: connection.roomName,
      },
      credentials: { sessionId: connection.sessionId as string, token: connection.sessionToken as string },
      tournamentKey: connection.tournamentKey,
    };
  }, [record, connection, operatorName]);

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
      void store.update(record.id, { events, setup }).then((updated) => {
        if (!onScreen.current) return;
        setRecordDurablyStored(updated !== null && store.durable && !store.storageDegraded);
      }).catch(() => {
        if (onScreen.current) setRecordDurablyStored(false);
      });
    },
    [record.id, store],
  );

  const write = useCallback(
    (qbj: object) => {
      const written = downloadQbj(qbj, record.package);
      if (written) {
        const at = new Date().toISOString();
        setDownloadedAt(at);
        void store.update(record.id, { qbjDownloadedAt: at }).then((updated) => {
          if (!onScreen.current) return;
          if (updated === null || !store.durable || store.storageDegraded) setRecordDurablyStored(false);
        }).catch(() => {
          if (onScreen.current) setRecordDurablyStored(false);
        });
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
        if (onScreen.current) setRecordDurablyStored(false);
        return {
          ok: false,
          message:
            'This device could not save the finished result. Do not close this tab. Download the QBJ backup now.',
        };
      }
      if (onScreen.current) setRecordDurablyStored(store.durable && !store.storageDegraded);

      let acceptedByTournamentControl = false;
      if (live) {
        // The capability is device-only. If this write is refused, the live send still happens and
        // the completed QBJ remains safe; only a post-reload retry cannot be promised.
        resultDelivery.remember(record.id, {
          baseUrl: live.client.baseUrl,
          sessionId: live.credentials.sessionId,
          sessionToken: live.credentials.token,
        }, completedAt);

        // Send exactly the object just committed as `finalQbj`. The internal scorer recovery layer
        // is for this device and must not be a second version of the portable QBTCP/file result.
        const delivered = await runtime.submitFinal(portable);
        await resultDelivery.recordOutcome(record.id, delivered);
        acceptedByTournamentControl = delivered.delivery === 'sent';
      }

      await onComplete(record.id, acceptedByTournamentControl);
      return {
        ok: true,
        message: acceptedByTournamentControl
          ? 'Tournament control accepted the result.'
          : 'The result is saved on this device.',
      };
    },
    [record.id, record.package, store, resultDelivery, live, runtime, onComplete],
  );

  /**
   * Apply corrected scoring rules to this game.
   *
   * The order matters and is the same order every other write on this screen follows: the copy that
   * survives a reload goes first. `saveEvents` writes the synchronous journal before it queues the
   * durable mirror. The reverse order would leave a reload holding a format the events no longer
   * match.
   *
   * See `formatCorrection` for what has already been checked by the time this runs: the correction
   * itself is known to be applicable. What is not known is whether this device will accept it, and
   * both writes can refuse -- a locked-down profile, a full quota, a database that has gone away.
   *
   * # Half of a correction is worse than none of it
   *
   * Neither order is safe on its own, which is why there is a rollback here rather than a comment
   * explaining why one order is fine. A correction that adds an answer type moves every index below
   * it, so `saveEvents` has already re-pointed every recorded buzz at positions that exist only in
   * the format the next line is about to be refused. Leaving that behind is not a correction that
   * did not happen; it is a game whose powers are priced as tossups from the next reload onwards,
   * silently, with the correction's own note sitting in the history claiming the rules were fixed.
   *
   * Retrying does not undo it either. `correctFormat` remaps from wherever the indices currently
   * sit, so a second attempt walks the same buzz one position further along.
   *
   * So the history goes back the way it came. `previousEvents` travels on the correction for that
   * purpose; see the note on it. It is the same synchronous journal write in the other direction, on
   * a smaller array than the one that has just been accepted, so the only way it fails is a browser
   * that withdrew storage between the two lines -- which is told apart from an ordinary refusal,
   * because "nothing has changed" would then be the second false thing the room had been told.
   *
   * A refusal is reported rather than absorbed. The screen stops claiming the record is durably
   * stored, the scorer is *not* remounted, and the throw reaches the dialog, which stays open with
   * the reason on it. Bumping `ruleRevision` on a failed write would be the worst outcome available:
   * the scoresheet would redraw under rules that exist only in memory, and the next reload would
   * silently undo scores the room had already been shown.
   */
  const correctScoringRules = useCallback(
    async ({ format, events, previousEvents }: IScoringRulesCorrection) => {
      const refuse = (message: string) => {
        if (onScreen.current) setRecordDurablyStored(false);
        throw new ScoringRulesCorrectionRefusal(message);
      };
      const nothingWritten = 'Those rules could not be saved on this device. Nothing has changed; try again.';
      // The history first, and no format written at all if it was refused. A format the events do
      // not match is the one combination neither this dialog nor a reload can recover from.
      if (!store.saveEvents(record.id, events)) refuse(nothingWritten);
      const updated = await store.update(record.id, {
        package: { ...record.package, scorekeeperFormat: format },
      });
      if (updated === null) {
        const restored = store.saveEvents(record.id, previousEvents);
        refuse(
          restored
            ? nothingWritten
            : 'Those rules could not be saved, and this device would not put the scoresheet back either. Download the QBJ backup from the Game menu before scoring anything else.',
        );
      }
      await onRecordChanged();
      setRuleRevision((revision) => revision + 1);
    },
    [record.id, record.package, store, onRecordChanged],
  );

  /**
   * The banner strip's contents.
   *
   * The update line goes last because it is the only thing here that is not about this game: every
   * connected alert above it is something the room may have to act on now, and a waiting build is
   * something it can act on when the round is over.
   */
  const alerts = useMemo(
    () => [...(live ? runtime.alerts : []), ...(update.available ? [updateDeferredAlert()] : [])],
    [live, runtime.alerts, update.available],
  );

  return (
    <>
      <ScorerHost
        key={`${record.gameKey}:${ruleRevision}`}
        /*
         * The remount above is deliberate, so the scoresheet must not greet it as a recovery. See
         * the note on `ruleRevision`, and `openingNotice` in `Scorer`.
         */
        openingNotice={
          ruleRevision > 0 ? 'Scoring rules corrected. Every question has been recalculated.' : undefined
        }
        gameKey={record.gameKey}
        format={record.package.scorekeeperFormat}
        leftTeam={record.package.left}
        rightTeam={record.package.right}
        tournamentName={record.package.tournament.name}
        roundName={record.package.round.name}
        roomName={record.package.room?.name}
        packetName={record.package.round.packetName}
        operatorName={operatorName}
        procedure={record.package.procedure}
        connection={live ? runtime.connection : RoomConnectionState.Connected}
        /*
         * A game opened from a file, or typed in on this device, has no tournament control behind
         * it — so the one word the header spends on status must not be "Connected". It was never a
         * fact about this game: the value above is a placeholder that exists only because the pill
         * is always rendered, and a green "Connected" over a game whose result has to be carried
         * out on a USB stick is the single most expensive thing this screen could get wrong. The
         * practice screen already says "Practice" here for exactly this reason.
         */
        statusLabel={live ? undefined : 'On this device'}
        recordDurablyStored={recordDurablyStored}
        degradedMessage={live ? runtime.degradedMessage : undefined}
        onSubmit={submit}
        onCorrectScoringRules={correctScoringRules}
        onDownload={write}
        onDownloadForm={(game, form) => downloadForm(game, form)}
        onProgress={live ? (qbj) => runtime.reportProgress(qbjWithSourceMetadata(qbj, record.package)) : undefined}
        onEventsChanged={mirror}
        qbjMeta={{
          round: record.package.round.number,
          location: record.package.room?.name,
        }}
        onRequestControl={live ? runtime.requestControl : undefined}
        controlRequest={live ? runtime.controlRequest : undefined}
        onRetryControlRequest={live ? runtime.retryControlRequest : undefined}
        onCancelControlRequest={live ? runtime.cancelControlRequest : undefined}
        onSyncRosterPlayer={live ? runtime.syncRosterPlayer : undefined}
        onRecoverFromServer={live ? runtime.recoverFromServer : undefined}
        alerts={alerts}
        recovery={{
          serverSnapshotAt: live ? runtime.serverSnapshotAt : undefined,
          snapshotError: live ? runtime.snapshotError : undefined,
          // A file game is not waiting for anything and must never be told a result will be sent.
          automaticDelivery: live !== null && runtime.automaticDelivery,
          tournamentControl: live !== null,
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
            connectionTimeline.record('room-repaired');
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
