/**
 * The whole application: a welcome screen, a scoresheet, and a completion screen.
 *
 * # There is no router, deliberately
 *
 * This is a static site with no server behind it. On GitHub Pages a reload of `/repo/game/42` is a
 * 404, because there is nothing there to rewrite it onto `index.html`, and a room that reloads
 * mid-round must never meet a 404. So there are no URLs to reload into: the application has one
 * address, and which screen it shows is decided from what is in local storage. A reload always
 * lands somewhere valid and then finds the game.
 *
 * That also makes the back button harmless, which matters more here than it looks: the single most
 * likely accidental gesture on a Chromebook mid-game is a two-finger swipe.
 *
 * # State transitions never come from the network
 *
 * Every transition in this file is caused by somebody pressing something. The connected runtime
 * produces connection state and alerts; it cannot cause a screen change. See `useConnectedRuntime`.
 *
 * # A paired room outlives the game it was paired for
 *
 * The connection in storage is two things joined: a room capability, which is good for the whole
 * tournament, and a session, which is good for one game. This file keeps them at their own
 * lifetimes. Pairing writes the room half immediately, starting a game adds the session half, and
 * finishing a game returns to the room rather than to the front door — because a Chromebook that
 * spent the morning as Room 204 is still Room 204 after the buzzer.
 *
 * # This file is the only thing that says an update may be applied
 *
 * It is also the only thing that knows, because "is a game on screen" is precisely the state it holds.
 * The declaration is made from the screen union below rather than from anything a component reports
 * about itself, so a new screen is safe by default: it does not permit updates until somebody adds it
 * to the list that does. See `AppUpdate`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameStore, IStoredGameRecord, isActive, needsHandoff } from '../game/GameStore';
import { IUnreadableRecord } from '../game/GameRecordUpgrade';
import { IGamePackage, gamePackageIdentity } from '../game/GamePackage';
import { openRecordStore } from '../persistence/GameDatabase';
import { claimGame, IGameClaim, newTabId } from '../persistence/TabClaim';
import { IGameSetup } from '../scoring/deriveGame';
import { loadGame } from '../scorer/GameSession';
import PracticeScreen, { practiceGameKey } from '../practice/PracticeScreen';
import {
  IConnectedSession,
  IPairedRoom,
  clearConnection,
  connectionVersion,
  pairedRoomOf,
  readConnection,
  writeConnection,
} from './ConnectedSession';
import useLeaveWarning from './useLeaveWarning';
import WelcomeScreen from './WelcomeScreen';
import ConnectedSetup, { IConnectedStart } from './ConnectedSetup';
import ScoringScreen from './ScoringScreen';
import GameOriginNotice from './GameOriginNotice';
import CompletionScreen from './CompletionScreen';
import DuplicateTabNotice from './DuplicateTabNotice';
import DeviceReadiness from './DeviceReadiness';
import { useReplaceable } from '../pwa/useAppUpdate';

/**
 * Whether the application may be replaced by a newer build while this screen is up.
 *
 * An allow-list, so the answer for a screen nobody has thought about is no.
 *
 * `scoring` is the screen this exists to protect. `practice` is refused too, because a half-finished
 * practice game is somebody learning the software and restarting it under them teaches the wrong
 * lesson. `duplicate` holds no game itself, but the tab that does is elsewhere on this device and a
 * worker swap is origin-wide, so it also says no. `completed` is refused for a different reason: the
 * result is safe, but that screen is where the QBJ backup and the handoff confirmation are asked for,
 * and a reload sends the scorekeeper looking through Recent Games for a job they were halfway through.
 *
 * What is left is the front door, the room screen between rounds, and the readiness screen — which is
 * exactly where somebody checking versions is standing anyway.
 */
export function updatesAllowedOn(screen: Screen): boolean {
  return screen.kind === 'home' || screen.kind === 'connect' || screen.kind === 'readiness';
}

export type Screen =
  | { kind: 'loading' }
  | { kind: 'home' }
  /**
   * The connected room.
   *
   * `fresh` means start at the address box even though a pairing is stored — the scorekeeper is
   * moving this device to a different tournament, which is the one case where the remembered room
   * is the wrong answer.
   */
  | { kind: 'connect'; fresh: boolean }
  | { kind: 'readiness' }
  | { kind: 'practice' }
  | { kind: 'scoring'; recordId: string }
  | { kind: 'completed'; recordId: string }
  /** Another live tab on this device is already scoring the game that was asked for. */
  | { kind: 'duplicate'; recordId: string };

/** The starting lineup a package named, turned into the engine's setup. */
export function setupFromPackage(packageValue: IGamePackage): IGameSetup {
  const side = (team: IGamePackage['left']) => ({
    name: team.name,
    players: team.players.map((player) => player.name),
    ...(team.startingLineup ? { startingLineup: [...team.startingLineup] } : {}),
  });
  return { left: side(packageValue.left), right: side(packageValue.right) };
}

export default function App() {
  const [store, setStore] = useState<GameStore | null>(null);
  const [records, setRecords] = useState<IStoredGameRecord[]>([]);
  const [unreadable, setUnreadable] = useState<IUnreadableRecord[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [connection, setConnection] = useState<IConnectedSession | null>(null);
  const [pendingBaseUrl, setPendingBaseUrl] = useState('');
  const [notice, setNotice] = useState('');
  const tabId = useRef(newTabId());
  const claim = useRef<IGameClaim | null>(null);

  const refresh = useCallback(async (openStore: GameStore) => {
    setRecords(await openStore.list());
    // Read after `list`, which is what populates it. A game this build cannot open is a fact the room
    // has to be told, because the alternative — an unfinished game that is simply not on the screen
    // any more — is indistinguishable from having lost it. See `GameRecordUpgrade`.
    setUnreadable(openStore.unreadable);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const opened = new GameStore(await openRecordStore<IStoredGameRecord>());
      if (cancelled) return;
      await opened.prune();
      const listed = await opened.list();
      if (cancelled) return;
      setStore(opened);
      setRecords(listed);
      setUnreadable(opened.unreadable);
      setConnection(readConnection());
      setScreen({ kind: 'home' });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      claim.current?.release();
    },
    [],
  );

  const current = useMemo(
    () =>
      'recordId' in screen ? (records.find((record) => record.id === screen.recordId) ?? null) : null,
    [screen, records],
  );

  const handoffOutstanding = records.some(needsHandoff);
  const localSaveFailed =
    store !== null && !store.durable && records.some((record) => isActive(record) || needsHandoff(record));

  useLeaveWarning({
    gameInProgress: screen.kind === 'scoring' && current !== null && isActive(current),
    localSaveFailed,
    handoffOutstanding,
  });

  useReplaceable(updatesAllowedOn(screen));

  /** Take the tab claim for a game, and say whether we got it. */
  const takeClaim = useCallback(async (recordId: string): Promise<boolean> => {
    claim.current?.release();
    const taken = await claimGame(recordId, tabId.current);
    claim.current = taken;
    return taken.held;
  }, []);

  const openRecord = useCallback(
    async (record: IStoredGameRecord) => {
      if (!isActive(record)) {
        setScreen({ kind: 'completed', recordId: record.id });
        return;
      }
      const held = await takeClaim(record.id);
      setScreen(held ? { kind: 'scoring', recordId: record.id } : { kind: 'duplicate', recordId: record.id });
    },
    [takeClaim],
  );

  /**
   * Start a game from a package, or resume the one this device already has for it.
   *
   * Opening the same file twice is an ordinary thing to do — a scorekeeper checks they have the
   * right game, or the file is opened again after a reload — and it must not produce a second copy
   * with half the questions in it.
   */
  const startFromPackage = useCallback(
    async (
      packageValue: IGamePackage,
      options: { connected: boolean; gameKey?: string; attempt?: number; resumeExisting?: boolean },
    ): Promise<IStoredGameRecord | null> => {
      if (!store) return null;
      const identity = gamePackageIdentity(packageValue);
      if (options.attempt === undefined) {
        const existing = (await store.findByIdentity(identity)).find(isActive);
        if (existing) {
          // The connected path asked for this game by name and tournament control confirmed the
          // session, so the unfinished copy *is* the answer and opening it is the resume.
          if (options.resumeExisting) {
            await refresh(store);
            setNotice('');
            await openRecord(existing);
            return existing;
          }
          // Otherwise it is offered rather than opened. A scorekeeper who picked the wrong file, or
          // who is checking they have the right one, must not find themselves inside a half-scored
          // game; and the saved copy must not be quietly replaced by a fresh one either. So the
          // unfinished game is named and Resume is one press away.
          await refresh(store);
          setNotice('This game is already saved on this device. Resume it rather than starting again.');
          setScreen({ kind: 'home' });
          return null;
        }
      }
      const created = await store.create({
        package: packageValue,
        setup: setupFromPackage(packageValue),
        connected: options.connected,
        gameKey: options.gameKey,
        attempt: options.attempt,
      });
      await refresh(store);
      setNotice('');
      await openRecord(created);
      return created;
    },
    [store, openRecord, refresh],
  );

  /**
   * Persist a change to the live connection, keeping the two halves in one record.
   *
   * The ref rather than a state updater because writing to storage is a side effect and a state
   * updater is not a place to have one. It is also updated first, so two repairs arriving in the
   * same tick — a reopened session and a re-paired room — do not lose the earlier of the two.
   */
  const connectionRef = useRef<IConnectedSession | null>(null);
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  const mergeConnection = useCallback((change: Partial<IConnectedSession>) => {
    const previous = connectionRef.current;
    if (!previous) return;
    const next: IConnectedSession = { ...previous, ...change, updatedAt: new Date().toISOString() };
    // The version and the timestamp are the writer's to set, so they are not passed back to it.
    writeConnection({
      baseUrl: next.baseUrl,
      roomId: next.roomId,
      roomName: next.roomName,
      roomToken: next.roomToken,
      deviceId: next.deviceId,
      sessionId: next.sessionId,
      sessionToken: next.sessionToken,
      gameRecordId: next.gameRecordId,
      tournamentKey: next.tournamentKey,
      progressSequence: next.progressSequence,
    });
    connectionRef.current = next;
    setConnection(next);
  }, []);

  /**
   * A room paired.
   *
   * Written before any game exists, and that is the point: the capability is what makes this device
   * Room 204 for the rest of the day, and a tab that closed between pairing and kickoff must not
   * cost somebody the code again.
   */
  const onPaired = useCallback((room: IPairedRoom) => {
    const stored: Omit<IConnectedSession, 'version' | 'updatedAt'> = { ...room };
    writeConnection(stored);
    setConnection({ ...stored, version: connectionVersion, updatedAt: new Date().toISOString() });
  }, []);

  const onConnected = useCallback(
    async (start: IConnectedStart) => {
      if (!store) return;
      // The session id is the game key for a new game, so a browser that reloads finds the same
      // history the server would recover, and so two devices in one room cannot collide on a key.
      const record = await startFromPackage(start.definition, {
        connected: true,
        gameKey: start.credentials.sessionId,
        resumeExisting: true,
      });
      if (!record) return;
      const stored: Omit<IConnectedSession, 'version' | 'updatedAt'> = {
        ...start.room,
        sessionId: start.credentials.sessionId,
        sessionToken: start.credentials.token,
        gameRecordId: record.id,
        tournamentKey: start.tournamentKey,
      };
      writeConnection(stored);
      setConnection({ ...stored, version: connectionVersion, updatedAt: new Date().toISOString() });
    },
    [store, startFromPackage],
  );

  /** The room this device is paired with, if the pairing is still held. */
  const pairedRoom = useMemo(() => pairedRoomOf(connection), [connection]);

  const onComplete = useCallback(
    async (recordId: string) => {
      if (!store) return;
      await refresh(store);
      claim.current?.release();
      claim.current = null;
      setScreen({ kind: 'completed', recordId });
    },
    [store, refresh],
  );

  const goHome = useCallback(async () => {
    claim.current?.release();
    claim.current = null;
    if (store) await refresh(store);
    setScreen({ kind: 'home' });
  }, [store, refresh]);

  const updateRecord = useCallback(
    async (recordId: string, change: Partial<IStoredGameRecord>) => {
      if (!store) return;
      await store.update(recordId, change);
      await refresh(store);
    },
    [store, refresh],
  );

  if (screen.kind === 'loading' || !store) {
    return (
      <main className="shell shell-centered">
        <p className="shell-loading">Opening the scoresheet…</p>
      </main>
    );
  }

  if (screen.kind === 'connect') {
    return (
      <ConnectedSetup
        initialBaseUrl={pendingBaseUrl || (connection?.baseUrl ?? '')}
        pairedRoom={screen.fresh ? null : pairedRoom}
        onPaired={onPaired}
        onStart={onConnected}
        onRoomLost={() => {
          clearConnection();
          setConnection(null);
        }}
        onCancel={() => setScreen({ kind: 'home' })}
      />
    );
  }

  if (screen.kind === 'readiness') {
    return (
      <DeviceReadiness
        durable={store.durable}
        rememberedServer={connection?.baseUrl}
        roomName={pairedRoom?.roomName}
        games={{
          saved: records.length,
          unfinished: records.filter(isActive).length,
          unreadable,
        }}
        // Named one by one, so a field added to the stored connection later does not silently become
        // something the diagnostics file is checked against — or worse, is not. See `findLeaks`.
        liveSecrets={[
          connection?.roomToken,
          connection?.sessionToken,
          connection?.sessionId,
          connection?.roomId,
          connection?.deviceId,
        ].filter((value): value is string => typeof value === 'string' && value !== '')}
        onBack={() => setScreen({ kind: 'home' })}
      />
    );
  }

  if (screen.kind === 'practice') {
    return <PracticeScreen onHome={goHome} />;
  }

  if (screen.kind === 'duplicate' && current) {
    return <DuplicateTabNotice record={current} onHome={goHome} />;
  }

  if (screen.kind === 'scoring' && current) {
    return (
      <>
        <GameOriginNotice packageValue={current.package} />
        <ScoringScreen
          record={current}
          store={store}
          connection={connection}
          durable={store.durable}
          onComplete={onComplete}
          onConnectionRepaired={mergeConnection}
          onConnectionLost={() => {
            clearConnection();
            setConnection(null);
          }}
        />
      </>
    );
  }

  if (screen.kind === 'completed' && current) {
    // A connected room goes back to its room, not to the front door. The next assignment appears
    // there on its own, and nobody has to find an address or a pairing code between rounds.
    const backToRoom = current.connected && pairedRoom !== null;
    return (
      <CompletionScreen
        record={current}
        onUpdate={updateRecord}
        continueLabel={backToRoom ? `Next game in ${pairedRoom.roomName}` : 'Done'}
        onHome={async () => {
          claim.current?.release();
          claim.current = null;
          await refresh(store);
          setScreen(backToRoom ? { kind: 'connect', fresh: false } : { kind: 'home' });
        }}
      />
    );
  }

  return (
    <WelcomeScreen
      records={records}
      unreadable={unreadable}
      notice={notice}
      durable={store.durable}
      pairedRoom={pairedRoom}
      practiceInProgress={(loadGame(practiceGameKey)?.events.length ?? 0) > 0}
      onReadiness={() => setScreen({ kind: 'readiness' })}
      onPractice={() => {
        setScreen({ kind: 'practice' });
      }}
      onOpenRoom={() => setScreen({ kind: 'connect', fresh: false })}
      onConnect={(baseUrl) => {
        setPendingBaseUrl(baseUrl);
        setScreen({ kind: 'connect', fresh: true });
      }}
      onOpenPackage={async (packageValue, attempt) => {
        await startFromPackage(packageValue, { connected: false, attempt });
      }}
      onOpenRecord={openRecord}
      onFindExisting={(identity) => store.findByIdentity(identity)}
    />
  );
}
