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
 * There is one exception, and it is deliberately not navigation. A QBTCP pairing launch link carries
 * an address and a short pairing code in the URL *fragment*, which `main.tsx` reads and removes
 * before this file renders anything. It is a bootstrap message, consumed once, and by the time the
 * application is on screen the URL is the ordinary QBSheet address again. No screen, no game and no
 * connection state is ever addressable, and a reload still lands somewhere valid and finds the game.
 * See `PairingLaunch`.
 *
 * # State transitions never come from the network
 *
 * After startup has restored durable local state, every transition in this file is caused by somebody
 * pressing something. The connected room produces assignment state, but it cannot open a session or
 * create a record until its Start action is pressed. The live runtime produces alerts; it cannot move
 * a scorer off screen.
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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { GameStore, IStoredGameRecord, isActive, needsHandoff } from '../game/GameStore';
import { IUnreadableRecord } from '../game/GameRecordUpgrade';
import { IGamePackage, gamePackageIdentity, gamePackageLabel } from '../game/GamePackage';
import { IGameDefinition, isManualGame } from '../game/GameDefinition';
import { newManualRecordIdentity } from '../game/ManualGame';
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
import { ControlOpenResult, IControlConnection, openControl } from './ControlPairing';
import { IPairingLaunchIntent, PairingLaunchResult, takePairingLaunch } from './PairingLaunch';
import useLeaveWarning from './useLeaveWarning';
import WelcomeScreen from './WelcomeScreen';
import ConnectedSetup from './ConnectedSetup';
import ConnectedRoom, { ConnectedStartResult, IConnectedStart } from './ConnectedRoom';
import ManualGameSetup from './ManualGameSetup';
import ScoringScreen from './ScoringScreen';
import GameOriginNotice from './GameOriginNotice';
import CompletionScreen from './CompletionScreen';
import DuplicateTabNotice from './DuplicateTabNotice';
import DeviceReadiness from './DeviceReadiness';
import { useReplaceable } from '../pwa/useAppUpdate';
import { ResultDeliveryCapabilityStore } from './ResultDeliveryCapability';
import { ResultDeliveryService } from './ResultDelivery';
import useAutomaticResultDelivery from './useAutomaticResultDelivery';
import { clearOperatorIdentity, readOperatorName, writeOperatorName } from './OperatorIdentity';
import { clearKeyboardPreference } from '../scorer/keyboardPreference';
import { clearDisplayPreferences } from './displayPreference';
import { safeAddress } from './Diagnostics';

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
 * `create` is refused because it holds unsaved work and nothing else: two typed rosters that exist
 * nowhere but in that form, which a worker swap would discard mid-sentence.
 *
 * What is left is the front door, the room screen between rounds, and the readiness screen — which is
 * exactly where somebody checking versions is standing anyway.
 */
export function updatesAllowedOn(screen: Screen): boolean {
  return (
    screen.kind === 'home' ||
    screen.kind === 'pairing' ||
    screen.kind === 'room' ||
    screen.kind === 'readiness'
  );
}

/**
 * Whether removing the current pairing would take credentials away from an unfinished game.
 *
 * New connections name the record directly and older stored connections use the session id as the
 * record's game key. The room and tournament are a conservative fallback: a long-lived room token
 * may still be needed to repair another unfinished game from that same room even when the most
 * recently stored session points at a different record.
 */
export function unfinishedGameDependsOnConnection(
  connection: IConnectedSession | null,
  record: IStoredGameRecord,
): boolean {
  if (!connection || !record.connected || !isActive(record)) return false;
  if (connection.gameRecordId === record.id || connection.sessionId === record.gameKey) return true;
  if (record.package.room?.id !== connection.roomId) return false;
  return connection.tournamentKey === undefined || record.package.tournament.key === connection.tournamentKey;
}

/**
 * Select the one unfinished game this connection may safely resume.
 *
 * Pairing protection is intentionally broader than resumption: it may keep a room credential while
 * any unfinished game from that room still needs it. Resume, however, must not guess between those
 * games. New connections name the record, legacy connections name the session key, and only a
 * single room/tournament fallback is safe when neither exact link is available.
 */
export function resumeRecordForConnection(
  connection: IConnectedSession | null,
  records: IStoredGameRecord[],
): IStoredGameRecord | null {
  if (!connection) return null;
  const unfinished = records.filter((record) => record.connected && isActive(record));

  if (connection.gameRecordId !== undefined) {
    const exact = unfinished.find((record) => record.id === connection.gameRecordId);
    if (exact) return exact;
  }

  if (connection.sessionId !== undefined) {
    const legacy = unfinished.find((record) => record.gameKey === connection.sessionId);
    if (legacy) return legacy;
  }

  const fallback = unfinished.filter((record) => {
    if (record.package.room?.id !== connection.roomId) return false;
    return (
      connection.tournamentKey === undefined || record.package.tournament.key === connection.tournamentKey
    );
  });
  return fallback.length === 1 ? fallback[0] : null;
}

/** An unreadable record can still be the game whose room capability is in use. */
export function unreadableGameDependsOnConnection(
  connection: IConnectedSession | null,
  unreadable: readonly IUnreadableRecord[],
): IUnreadableRecord | null {
  if (!connection?.gameRecordId) return null;
  return unreadable.find((record) => record.id === connection.gameRecordId) ?? null;
}

export type Screen =
  | { kind: 'loading' }
  | { kind: 'home' }
  /**
   * Pairing/setup only. An established room has its own screen and no address/back loop.
   *
   * `returnTo` is only for Back while pairing. It never changes the lifetime of the existing pairing.
   */
  | {
      kind: 'pairing';
      launch?: IPairingLaunchIntent;
      launchKey?: number;
      initialConnection?: IControlConnection;
      returnTo: 'home' | 'room';
    }
  | { kind: 'room' }
  | { kind: 'readiness' }
  | { kind: 'practice' }
  /**
   * Describing a game by hand, for a practice or anything else nobody scheduled.
   *
   * Holds no record. Nothing is created until the form validates and Start game is pressed, at which
   * point what it produces is an ordinary definition and this screen is done. See `ManualGameSetup`.
   */
  | { kind: 'create' }
  | { kind: 'scoring'; recordId: string }
  | { kind: 'completed'; recordId: string; acceptedJustNow?: boolean }
  /** Another live tab on this device is already scoring the game that was asked for. */
  | { kind: 'duplicate'; recordId: string };

/**
 * Where durable local state puts the application after its loading screen.
 *
 * A connected unfinished game remains a deliberate Resume, but the Resume lives in its room. An
 * unfinished file/manual game remains on Home. A completed connected result whose handoff is still
 * outstanding returns to the completion screen that owns that safety gate.
 */
export function screenAfterLoad(
  connection: IConnectedSession | null,
  records: IStoredGameRecord[],
  unreadable: readonly IUnreadableRecord[] = [],
): Screen {
  const connectedRecord = connection?.gameRecordId
    ? records.find((record) => record.id === connection.gameRecordId)
    : undefined;
  if (connectedRecord && needsHandoff(connectedRecord)) {
    return { kind: 'completed', recordId: connectedRecord.id };
  }
  if (unreadableGameDependsOnConnection(connection, unreadable)) {
    return { kind: 'home' };
  }
  if (connection && resumeRecordForConnection(connection, records)) {
    return { kind: 'room' };
  }
  if (!connection || records.some(isActive)) return { kind: 'home' };
  return { kind: 'room' };
}

/**
 * Why a pairing link is being refused, said without saying anything it contained.
 *
 * A device holding an unfinished game that still depends on its pairing cannot be moved to another
 * tournament, and a link is not an exception to that: the link arrived from across the room, the
 * game did not, and replacing a room capability the scoresheet on this device is still using would
 * strand a game somebody is in the middle of. The link is discarded rather than queued, because a
 * pairing code that sat in memory until the round ended would be a secret kept for no good reason —
 * scanning it again afterwards costs one press.
 */
export function pairingLaunchBlockedNotice(roomName: string | undefined, gameLabel: string): string {
  return `This device cannot switch tournament control while ${gameLabel} is unfinished and still uses the pairing for ${roomName ?? 'the current room'}. Finish that game, then open the pairing link again.`;
}

export function unreadablePairingLaunchBlockedNotice(roomName: string | undefined): string {
  return `This device cannot switch tournament control while a saved game this version cannot open may still depend on the pairing for ${roomName ?? 'the current room'}. Update QBSheet or open that game on the device that saved it first.`;
}

/**
 * Where a pairing launch link puts the application, and what it says about it.
 *
 * Separate from `screenAfterLoad` and layered on top of it, so every path that does not involve a
 * link is provably the behaviour that shipped before there were links. A valid link on a device with
 * nothing to protect goes straight to the ready-to-connect card; everything else falls back to the
 * ordinary startup screen with a sentence explaining why.
 */
export function screenAfterLaunch(
  launch: PairingLaunchResult,
  connection: IConnectedSession | null,
  records: IStoredGameRecord[],
  unreadable: readonly IUnreadableRecord[] = [],
): { screen: Screen; notice: string } {
  const ordinary = screenAfterLoad(connection, records, unreadable);
  if (launch.kind === 'problem') return { screen: ordinary, notice: launch.message };
  if (launch.kind === 'none') return { screen: ordinary, notice: '' };
  if (unreadableGameDependsOnConnection(connection, unreadable)) {
    return { screen: ordinary, notice: unreadablePairingLaunchBlockedNotice(connection?.roomName) };
  }
  const dependent = records.find((record) => unfinishedGameDependsOnConnection(connection, record));
  if (dependent) {
    return {
      screen: ordinary,
      notice: pairingLaunchBlockedNotice(connection?.roomName, gamePackageLabel(dependent.package)),
    };
  }
  return {
    screen: {
      kind: 'pairing',
      launch: launch.intent,
      returnTo: connection ? 'room' : 'home',
    },
    notice: '',
  };
}

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
  const [operatorName, setOperatorName] = useState(() => readOperatorName());
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [connection, setConnection] = useState<IConnectedSession | null>(null);
  const [pendingBaseUrl, setPendingBaseUrl] = useState('');
  const [notice, setNotice] = useState('');
  /**
   * The pairing link this page was opened with, read exactly once.
   *
   * The fragment itself is already gone — `main.tsx` removed it before this component existed — and
   * this is the in-memory answer it left behind. Read in a state initializer rather than an effect
   * so it cannot be read twice by a re-render, and so nothing else can arrive first and act on a
   * device whose situation has not been decided yet.
   */
  const [launched] = useState<PairingLaunchResult>(() => takePairingLaunch());
  const tabId = useRef(newTabId());
  const pairingLaunchSequence = useRef(0);
  const claim = useRef<IGameClaim | null>(null);
  const resultDeliveryCapabilities = useMemo(() => new ResultDeliveryCapabilityStore(), []);
  const resultDelivery = useMemo(
    () => (store ? new ResultDeliveryService(store, resultDeliveryCapabilities) : null),
    [store, resultDeliveryCapabilities],
  );

  const refresh = useCallback(
    async (openStore: GameStore) => {
      const listed = await openStore.list();
      resultDeliveryCapabilities.prune(new Set(listed.map((record) => record.id)));
      setRecords(listed);
      // Read after `list`, which is what populates it. A game this build cannot open is a fact the room
      // has to be told, because the alternative — an unfinished game that is simply not on the screen
      // any more — is indistinguishable from having lost it. See `GameRecordUpgrade`.
      setUnreadable(openStore.unreadable);
    },
    [resultDeliveryCapabilities],
  );

  const refreshCurrentStore = useCallback(async () => {
    if (store) await refresh(store);
  }, [store, refresh]);

  useAutomaticResultDelivery({
    records,
    service: resultDelivery,
    onAttemptFinished: refreshCurrentStore,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const opened = new GameStore(await openRecordStore<IStoredGameRecord>());
      if (cancelled) return;
      await opened.prune();
      const listed = await opened.list();
      resultDeliveryCapabilities.prune(new Set(listed.map((record) => record.id)));
      if (cancelled) return;
      const restoredConnection = readConnection();
      setStore(opened);
      setRecords(listed);
      setUnreadable(opened.unreadable);
      setConnection(restoredConnection);
      // A launch link is only allowed to decide this once durable local state has been read, because
      // the questions it has to answer — is this device already paired, is there an unfinished game
      // depending on that pairing — are questions about storage. Nothing has touched the network yet.
      const start = screenAfterLaunch(launched, restoredConnection, listed, opened.unreadable);
      setScreen(
        start.screen.kind === 'pairing' && start.screen.launch
          ? { ...start.screen, launchKey: ++pairingLaunchSequence.current }
          : start.screen,
      );
      if (start.notice !== '') setNotice(start.notice);
    })();
    return () => {
      cancelled = true;
    };
    // `launched` is read once at mount and never changes; it is deliberately not a dependency of a
    // startup effect that must run exactly one time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultDeliveryCapabilities]);

  useEffect(
    () => () => {
      claim.current?.release();
    },
    [],
  );

  /*
   * Storage health is the store's, read from the store as the screens that report it render.
   *
   * It used to be copied into state by an effect, which meant re-reading on subscribe to cover the
   * gap between the first render and that effect, and clearing the copy by hand whenever the store
   * went away. Reading through leaves nothing to keep in step: no store is not degraded, and a
   * store that becomes degraded says so on the next render.
   */
  const subscribeStorageStatus = useCallback(
    (listener: () => void) => (store ? store.subscribeToStorageStatus(listener) : () => {}),
    [store],
  );
  const storageDegraded = useSyncExternalStore(subscribeStorageStatus, () => store?.storageDegraded ?? false);
  const storageError = useSyncExternalStore(subscribeStorageStatus, () => store?.storageError);

  const current = useMemo(
    () => ('recordId' in screen ? (records.find((record) => record.id === screen.recordId) ?? null) : null),
    [screen, records],
  );

  const handoffOutstanding = records.some(needsHandoff);
  const localSaveFailed =
    store !== null &&
    (!store.durable || storageDegraded) &&
    records.some((record) => isActive(record) || needsHandoff(record));

  useLeaveWarning({
    gameInProgress: screen.kind === 'scoring' && current !== null && isActive(current),
    localSaveFailed,
    handoffOutstanding,
  });

  useReplaceable(updatesAllowedOn(screen));

  const updateOperatorName = useCallback((value: string) => {
    setOperatorName(value);
    void writeOperatorName(value);
  }, []);

  /** Take the tab claim for a game, and say whether we got it. */
  const takeClaim = useCallback(async (recordId: string): Promise<boolean> => {
    claim.current?.release();
    const taken = await claimGame(recordId, tabId.current);
    claim.current = taken;
    if (taken.held) {
      const disableScoring = () => {
        // A released or superseded claim cannot move a later game off screen.
        if (claim.current !== taken) return;
        claim.current = null;
        setScreen({ kind: 'duplicate', recordId });
      };
      taken.lost.addEventListener('abort', disableScoring, { once: true });
      // A channel event normally cannot run between claimGame resolving and this listener being
      // attached, but checking closes that boundary for synchronous channel-like test doubles and
      // unusual implementations.
      if (taken.lost.aborted) disableScoring();
    }
    return taken.held && !taken.lost.aborted;
  }, []);

  /** Put a saved game on screen after its record is already authoritative. */
  const openRecord = useCallback(
    async (record: IStoredGameRecord, isCurrent: () => boolean = () => true): Promise<boolean> => {
      if (!isCurrent()) return false;
      if (!isActive(record)) {
        setScreen({ kind: 'completed', recordId: record.id });
        return true;
      }
      const held = await takeClaim(record.id);
      if (!isCurrent()) {
        if (held) {
          claim.current?.release();
          claim.current = null;
        }
        return false;
      }
      if (!held) {
        setScreen({ kind: 'duplicate', recordId: record.id });
        return false;
      }
      setScreen({ kind: 'scoring', recordId: record.id });
      return true;
    },
    [takeClaim],
  );

  /**
   * Create or locate one local record. The connected and file workflows share this boundary so
   * GameStore.create is not reimplemented in a component. The caller decides where a failure should
   * leave the user; connected start failures stay in the room, while a file failure returns Home.
   */
  const ensureRecord = useCallback(
    async (
      packageValue: IGamePackage,
      options: {
        connected: boolean;
        gameKey?: string;
        attempt?: number;
        recordIdentity?: string;
        resumeExisting?: boolean;
        isCurrent?: () => boolean;
        failureScreen?: Screen;
        failureNotice?: string;
      },
    ): Promise<IStoredGameRecord | null> => {
      if (!store) return null;
      const failureScreen = options.failureScreen ?? { kind: 'home' as const };
      const failureNotice =
        options.failureNotice ?? 'This game could not be committed to local storage. No scoring has started.';
      const identity = gamePackageIdentity(packageValue);
      const stale = () => options.isCurrent !== undefined && !options.isCurrent();
      if (stale()) return null;
      if (options.attempt === undefined) {
        let existing = (await store.findByIdentity(identity)).find(isActive);
        if (stale()) return null;
        if (existing) {
          if (options.resumeExisting) {
            const wasConnected = existing.connected;
            const wasServerDelivery = existing.serverDelivery;
            if (options.connected && !existing.connected) {
              const upgraded = await store.update(existing.id, {
                connected: true,
                serverDelivery: existing.serverDelivery === 'none' ? 'pending' : existing.serverDelivery,
              });
              if (!upgraded) {
                if (stale()) return null;
                await refresh(store);
                setNotice(failureNotice);
                setScreen(failureScreen);
                return null;
              }
              existing = upgraded;
              if (stale()) {
                await store.update(existing.id, {
                  connected: wasConnected,
                  serverDelivery: wasServerDelivery,
                });
                await refresh(store);
                return null;
              }
            }
            await refresh(store);
            if (stale()) return null;
            return existing;
          }
          if (stale()) return null;
          await refresh(store);
          setNotice('This game is already saved on this device. Resume it rather than starting again.');
          setScreen(failureScreen);
          return null;
        }
      }
      try {
        if (stale()) return null;
        const created = await store.create({
          package: packageValue,
          setup: setupFromPackage(packageValue),
          connected: options.connected,
          gameKey: options.gameKey,
          recordIdentity: options.recordIdentity,
          attempt: options.attempt,
        });
        if (stale()) {
          await store.remove(created.id);
          await refresh(store);
          return null;
        }
        await refresh(store);
        if (stale()) {
          await store.remove(created.id);
          await refresh(store);
          return null;
        }
        return created;
      } catch {
        if (stale()) return null;
        await refresh(store);
        setNotice(failureNotice);
        setScreen(failureScreen);
        return null;
      }
    },
    [store, refresh],
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
      const created = await ensureRecord(packageValue, options);
      if (!created) return null;
      setNotice('');
      await openRecord(created);
      return created;
    },
    [ensureRecord, openRecord],
  );

  /**
   * Start a game somebody typed in.
   *
   * Deliberately not `startFromPackage`. That function's first act is to look for an unfinished game
   * with the same `gamePackageIdentity` and offer to resume it, which is exactly right for a file or
   * a connected assignment — opening the same file twice must not produce two half-scored copies —
   * and exactly wrong here. Two practices between the same two teams on the same afternoon share
   * every field that identity is built from, and they are two games. Loosening the file path to
   * accommodate that would weaken duplicate detection for the case it exists to protect, so the
   * manual path is its own three lines instead and the file path is untouched.
   *
   * Everything after `create` is the ordinary route: the same tab claim, the same `openRecord`, the
   * same scorer. No assignment card, because nothing was assigned.
   */
  const createManualGame = useCallback(
    async (definition: IGameDefinition) => {
      const created = await ensureRecord(definition, {
        connected: false,
        recordIdentity: newManualRecordIdentity(),
      });
      if (!created) return;
      setNotice('');
      await openRecord(created);
    },
    [ensureRecord, openRecord],
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
    const next = { ...stored, version: connectionVersion, updatedAt: new Date().toISOString() };
    connectionRef.current = next;
    setConnection(next);
    setPendingBaseUrl('');
    setNotice('');
    // The launch link has been spent. The device is now the established room, whether this was a
    // manual pairing, a QR scan, a tapped link, or an in-room 401 repair.
    setScreen({ kind: 'room' });
  }, []);

  const onConnected = useCallback(
    async (start: IConnectedStart): Promise<ConnectedStartResult> => {
      if (!store) return { ok: false, error: 'Local storage is not ready. Stay in the room and try again.' };
      const isCurrent = start.isCurrent ?? (() => true);
      const staleStart = (): ConnectedStartResult => ({
        ok: false,
        error: 'The room was left before this game could start.',
      });
      if (!isCurrent()) return staleStart();
      // The session id is the game key for a new game, so a browser that reloads finds the same
      // history the server would recover, and so two devices in one room cannot collide on a key.
      const record = await ensureRecord(start.definition, {
        connected: true,
        gameKey: start.credentials.sessionId,
        resumeExisting: true,
        isCurrent,
        failureScreen: { kind: 'room' },
        failureNotice:
          'This game could not be committed locally. No scoring has started; try again from the room.',
      });
      if (!record) {
        if (!isCurrent()) return staleStart();
        return {
          ok: false,
          error: 'This game could not be committed locally. No scoring has started; try again.',
        };
      }
      if (!isCurrent()) return staleStart();
      const stored: Omit<IConnectedSession, 'version' | 'updatedAt'> = {
        ...start.room,
        sessionId: start.credentials.sessionId,
        sessionToken: start.credentials.token,
        gameRecordId: record.id,
        tournamentKey: start.tournamentKey,
      };
      if (!isCurrent()) return staleStart();
      // This is intentionally before the tab claim and before the scorer screen. A connected scorer
      // must never mount once as an unconnected/local game while its session binding is still only
      // in a callback's local variable.
      const persisted = writeConnection(stored);
      const next = { ...stored, version: connectionVersion, updatedAt: new Date().toISOString() };
      connectionRef.current = next;
      setConnection(next);
      if (!persisted) {
        setNotice('The game is saved, but the room session could not be persisted. Stay here and try again.');
        return { ok: false, error: 'The room session could not be persisted. No scoring has started.' };
      }
      setNotice('');
      const opened = await openRecord(record, isCurrent);
      if (!isCurrent()) return staleStart();
      return opened ? { ok: true } : { ok: false, error: 'Another tab is already scoring this game.' };
    },
    [ensureRecord, openRecord, store],
  );

  /** The room this device is paired with, if the pairing is still held. */
  const pairedRoom = useMemo(() => pairedRoomOf(connection), [connection]);
  const pairingDependentGame = useMemo(
    () => records.find((record) => unfinishedGameDependsOnConnection(connection, record)) ?? null,
    [connection, records],
  );
  const unreadablePairingGame = useMemo(
    () => unreadableGameDependsOnConnection(connection, unreadable),
    [connection, unreadable],
  );
  const resumeRecord = useMemo(() => resumeRecordForConnection(connection, records), [connection, records]);
  const settingsConnection = useMemo(
    () =>
      pairedRoom
        ? {
            roomName: pairedRoom.roomName,
            address: safeAddress(connection?.baseUrl),
          }
        : null,
    [connection?.baseUrl, pairedRoom],
  );
  const pairingProtection = pairingDependentGame
    ? `QBSheet cannot remove ${pairedRoom?.roomName ?? 'this room'} while ${gamePackageLabel(pairingDependentGame.package)} is unfinished and still uses this pairing. Resume and finish the game, or ask tournament control for help first.`
    : unreadablePairingGame
      ? `QBSheet cannot change ${pairedRoom?.roomName ?? 'this room'} while a saved game this version cannot open may still depend on this pairing. Update QBSheet or open that game on the device that saved it first.`
      : undefined;
  const pairingProtected = pairingProtection !== undefined;
  const pairingLaunchProtection = pairingDependentGame
    ? pairingLaunchBlockedNotice(pairedRoom?.roomName, gamePackageLabel(pairingDependentGame.package))
    : unreadablePairingGame
      ? unreadablePairingLaunchBlockedNotice(pairedRoom?.roomName)
      : undefined;

  /**
   * A pairing link read off a QR code while the application is already running.
   *
   * The same two decisions the startup path makes, so a link cannot get a different answer for
   * having arrived through the camera rather than through the address bar.
   */
  const beginPairingLaunch = useCallback(
    (intent: IPairingLaunchIntent, returnTo: 'home' | 'room' = connection ? 'room' : 'home') => {
      if (pairingLaunchProtection) {
        setNotice(pairingLaunchProtection);
        return;
      }
      setNotice('');
      setScreen({
        kind: 'pairing',
        launch: intent,
        launchKey: ++pairingLaunchSequence.current,
        returnTo,
      });
    },
    [connection, pairingLaunchProtection],
  );

  const forgetPairing = useCallback(() => {
    if (pairingProtected) return;
    clearConnection();
    connectionRef.current = null;
    setConnection(null);
    setNotice('Tournament pairing forgotten.');
    setScreen({ kind: 'home' });
  }, [pairingProtected]);

  const resetDevicePreferences = useCallback(() => {
    // Reset is all-or-nothing when pairing is protected. Clearing the harmless preferences first
    // would leave a half-reset device while the confirmation says the operation was blocked.
    if (pairingProtected) return;
    clearOperatorIdentity();
    clearKeyboardPreference();
    clearDisplayPreferences();
    clearConnection();
    setOperatorName('');
    connectionRef.current = null;
    setConnection(null);
    setNotice('Device preferences reset.');
    setScreen({ kind: 'home' });
  }, [pairingProtected]);

  const onComplete = useCallback(
    async (recordId: string, acceptedJustNow = false) => {
      if (!store) return;
      await refresh(store);
      claim.current?.release();
      claim.current = null;
      setScreen({ kind: 'completed', recordId, acceptedJustNow });
    },
    [store, refresh],
  );

  const goHome = useCallback(async () => {
    claim.current?.release();
    claim.current = null;
    if (store) await refresh(store);
    setScreen({ kind: 'home' });
  }, [store, refresh]);

  /** Reopen a finished result in the scorer so a scorekeeper can inspect or correct it. */
  const backToScorekeeper = useCallback(
    async (recordId: string) => {
      const held = await takeClaim(recordId);
      if (!held) {
        setScreen({ kind: 'duplicate', recordId });
        return;
      }
      setScreen({ kind: 'scoring', recordId });
    },
    [takeClaim],
  );

  const updateRecord = useCallback(
    async (recordId: string, change: Partial<IStoredGameRecord>) => {
      if (!store) return false;
      const updated = await store.update(recordId, change);
      await refresh(store);
      return updated !== null;
    },
    [store, refresh],
  );

  const retryResult = useCallback(
    async (recordId: string) => {
      if (!resultDelivery || !store) return;
      await resultDelivery.retry(recordId);
      await refresh(store);
    },
    [refresh, resultDelivery, store],
  );

  const canRetryResult = useCallback(
    (record: IStoredGameRecord) => resultDelivery?.canRetry(record) ?? false,
    [resultDelivery],
  );

  if (screen.kind === 'loading' || !store) {
    return (
      <main className="shell shell-centered">
        <p className="shell-loading">Opening the scoresheet…</p>
      </main>
    );
  }

  if (screen.kind === 'pairing') {
    return (
      <ConnectedSetup
        key={screen.launchKey ?? 'connected'}
        initialBaseUrl={pendingBaseUrl || (connection?.baseUrl ?? '')}
        initialConnection={screen.initialConnection}
        launch={screen.launch ?? null}
        existingDeviceId={connection?.deviceId}
        onPaired={onPaired}
        onPairingLaunch={(intent) => beginPairingLaunch(intent, screen.returnTo)}
        onOtherScoring={() => setScreen({ kind: 'home' })}
        onCancel={() =>
          setScreen(screen.returnTo === 'room' && pairedRoom ? { kind: 'room' } : { kind: 'home' })
        }
      />
    );
  }

  if (screen.kind === 'room' && pairedRoom) {
    return (
      <ConnectedRoom
        key={`${pairedRoom.baseUrl}|${pairedRoom.roomId}|${pairedRoom.roomToken}`}
        pairedRoom={pairedRoom}
        resumeRecord={resumeRecord}
        notice={notice}
        durable={store.durable}
        storageDegraded={storageDegraded}
        storageError={storageError}
        operatorName={operatorName}
        onOperatorNameChange={updateOperatorName}
        settingsConnection={settingsConnection as NonNullable<typeof settingsConnection>}
        pairingProtection={pairingProtection}
        onForgetPairing={forgetPairing}
        onResetDevicePreferences={resetDevicePreferences}
        practiceInProgress={(loadGame(practiceGameKey)?.events.length ?? 0) > 0}
        onReadiness={() => setScreen({ kind: 'readiness' })}
        onPractice={() => setScreen({ kind: 'practice' })}
        onOtherScoring={() => setScreen({ kind: 'home' })}
        onChangeTournament={() => {
          if (pairingProtected) return;
          setPendingBaseUrl(connection?.baseUrl ?? '');
          setScreen({ kind: 'pairing', returnTo: 'room' });
        }}
        onResume={async (record) => {
          await openRecord(record);
        }}
        onStart={onConnected}
        onPaired={onPaired}
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
        onBack={() => setScreen(pairedRoom ? { kind: 'room' } : { kind: 'home' })}
      />
    );
  }

  if (screen.kind === 'practice') {
    return <PracticeScreen onHome={goHome} operatorName={operatorName} />;
  }

  if (screen.kind === 'create') {
    return <ManualGameSetup onStart={createManualGame} onCancel={() => setScreen({ kind: 'home' })} />;
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
          resultDelivery={resultDelivery as ResultDeliveryService}
          connection={connection}
          durable={store.durable}
          storageDegraded={storageDegraded}
          operatorName={operatorName}
          onComplete={onComplete}
          onRecordChanged={refreshCurrentStore}
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
        acceptedJustNow={screen.acceptedJustNow === true}
        onUpdate={updateRecord}
        onBackToScorekeeper={() => backToScorekeeper(current.id)}
        continueLabel={backToRoom ? `Next game in ${pairedRoom.roomName}` : 'Done'}
        onRematch={
          isManualGame(current.package)
            ? () => createManualGame(current.package as IGameDefinition)
            : undefined
        }
        onHome={async () => {
          claim.current?.release();
          claim.current = null;
          await refresh(store);
          setScreen(backToRoom ? { kind: 'room' } : { kind: 'home' });
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
      storageDegraded={storageDegraded}
      storageError={storageError}
      operatorName={operatorName}
      onOperatorNameChange={updateOperatorName}
      pairedRoom={pairedRoom}
      settingsConnection={settingsConnection}
      pairingProtection={pairingProtection}
      onForgetPairing={forgetPairing}
      onResetDevicePreferences={resetDevicePreferences}
      practiceInProgress={(loadGame(practiceGameKey)?.events.length ?? 0) > 0}
      onReadiness={() => setScreen({ kind: 'readiness' })}
      onPractice={() => {
        setScreen({ kind: 'practice' });
      }}
      onCreateGame={() => setScreen({ kind: 'create' })}
      onOpenRoom={() => setScreen({ kind: 'room' })}
      onConnect={async (baseUrl): Promise<ControlOpenResult> => {
        const opened = await openControl(baseUrl);
        if (opened.ok) {
          setPendingBaseUrl(baseUrl);
          setScreen({
            kind: 'pairing',
            initialConnection: opened.value,
            returnTo: pairedRoom ? 'room' : 'home',
          });
        }
        return opened;
      }}
      onPairingLaunch={beginPairingLaunch}
      onOpenPackage={async (packageValue, attempt) => {
        await startFromPackage(packageValue, { connected: false, attempt });
      }}
      onOpenRecord={async (record) => {
        await openRecord(record);
      }}
      onRetryResult={retryResult}
      canRetryResult={canRetryResult}
      onFindExisting={(identity) => store.findByIdentity(identity)}
    />
  );
}
