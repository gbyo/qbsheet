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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameStore, IStoredGameRecord, isActive, needsHandoff } from '../game/GameStore';
import { IGamePackage, gamePackageIdentity } from '../game/GamePackage';
import { openRecordStore } from '../persistence/GameDatabase';
import { claimGame, IGameClaim, newTabId } from '../persistence/TabClaim';
import { IGameSetup } from '../scoring/deriveGame';
import { clearGame } from '../scorer/GameSession';
import PracticeScreen, { practiceGameKey } from '../practice/PracticeScreen';
import { IConnectedSession, clearConnection, readConnection, writeConnection } from './ConnectedSession';
import useLeaveWarning from './useLeaveWarning';
import WelcomeScreen from './WelcomeScreen';
import ConnectedSetup, { IConnectedStart } from './ConnectedSetup';
import ScoringScreen from './ScoringScreen';
import GameOriginNotice from './GameOriginNotice';
import CompletionScreen from './CompletionScreen';
import DuplicateTabNotice from './DuplicateTabNotice';
import DeviceReadiness from './DeviceReadiness';

type Screen =
  | { kind: 'loading' }
  | { kind: 'home' }
  | { kind: 'connect' }
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
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [connection, setConnection] = useState<IConnectedSession | null>(null);
  const [pendingBaseUrl, setPendingBaseUrl] = useState('');
  const [notice, setNotice] = useState('');
  const tabId = useRef(newTabId());
  const claim = useRef<IGameClaim | null>(null);

  const refresh = useCallback(async (openStore: GameStore) => {
    setRecords(await openStore.list());
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
    async (packageValue: IGamePackage, options: { connected: boolean; gameKey?: string; attempt?: number }) => {
      if (!store) return;
      const identity = gamePackageIdentity(packageValue);
      if (options.attempt === undefined) {
        const existing = (await store.findByIdentity(identity)).find(isActive);
        if (existing) {
          // Offered rather than opened. A scorekeeper who picked the wrong file, or who is checking
          // they have the right one, must not find themselves inside a half-scored game; and the
          // saved copy must not be quietly replaced by a fresh one either. So the unfinished game
          // is named and Resume is one press away.
          await refresh(store);
          setNotice('This game is already saved on this device. Resume it rather than starting again.');
          setScreen({ kind: 'home' });
          return;
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
    },
    [store, openRecord, refresh],
  );

  const onConnected = useCallback(
    async (start: IConnectedStart) => {
      if (!store) return;
      const session: Omit<IConnectedSession, 'version' | 'updatedAt'> = {
        baseUrl: start.baseUrl,
        roomId: start.identity.roomId,
        roomName: start.roomName,
        roomToken: start.identity.token,
        deviceId: start.identity.deviceId ?? '',
        sessionId: start.credentials.sessionId,
        sessionToken: start.credentials.token,
        tournamentKey: start.tournamentKey,
      };
      writeConnection(session);
      setConnection({ ...session, version: 1, updatedAt: new Date().toISOString() });
      // The session id is the game key, so a browser that reloads finds the same history the server
      // would recover, and so two devices in one room cannot collide on a key.
      await startFromPackage(start.package, { connected: true, gameKey: start.credentials.sessionId });
    },
    [store, startFromPackage],
  );

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
        onStart={onConnected}
        onCancel={() => setScreen({ kind: 'home' })}
      />
    );
  }

  if (screen.kind === 'readiness') {
    return (
      <DeviceReadiness
        durable={store.durable}
        rememberedServer={connection?.baseUrl}
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
          onConnectionLost={() => {
            clearConnection();
            setConnection(null);
          }}
        />
      </>
    );
  }

  if (screen.kind === 'completed' && current) {
    return <CompletionScreen record={current} onUpdate={updateRecord} onHome={goHome} />;
  }

  return (
    <WelcomeScreen
      records={records}
      notice={notice}
      durable={store.durable}
      rememberedRoom={connection?.roomName}
      onReadiness={() => setScreen({ kind: 'readiness' })}
      onPractice={() => {
        clearGame(practiceGameKey);
        setScreen({ kind: 'practice' });
      }}
      onConnect={(baseUrl) => {
        setPendingBaseUrl(baseUrl);
        setScreen({ kind: 'connect' });
      }}
      onOpenPackage={(packageValue, attempt) => startFromPackage(packageValue, { connected: false, attempt })}
      onOpenRecord={openRecord}
      onFindExisting={(identity) => store.findByIdentity(identity)}
    />
  );
}
