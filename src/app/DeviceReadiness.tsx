import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import FruityServerClient, { normalizeBaseUrl } from '../integrations/fruity/FruityServerClient';
import { buildLabel } from '../pwa/BuildVersion';
import { IWorkerBuild, serviceWorkerBuild } from '../pwa/AppUpdate';
import { useAppUpdate } from '../pwa/useAppUpdate';
import { IUnreadableRecord } from '../game/GameRecordUpgrade';
import {
  DiagnosticsOutcome,
  IDiagnosticServer,
  downloadDiagnostics,
  safeAddress,
} from './Diagnostics';
import { isSafariBrowser } from './browserCompatibility';

type CheckState = 'pass' | 'warn' | 'fail' | 'info';
type CheckKind = 'required' | 'recommended' | 'connected';

type ServiceWorkerState = 'unsupported' | 'missing' | 'registered' | 'controlled';
type LocalNetworkPermissionState = PermissionState | 'unsupported';
type DownloadState = 'untested' | 'waiting' | 'passed' | 'failed';

type ServerTestState =
  | { kind: 'untested' }
  | { kind: 'testing' }
  /** `protocol` is what this device would actually speak to that address, not what it hopes for. */
  | { kind: 'passed'; message: string; protocol: string; canonical: boolean; server: IDiagnosticServer }
  | { kind: 'failed'; message: string };

/**
 * What a director needs to be told about the surface a Chromebook settled on.
 *
 * Worth a line of its own because the two are not equally good and the difference is invisible
 * everywhere else: a device on the fallback is scoring perfectly well today and will stop being
 * able to the day the tournament's server drops its deprecated aliases. Finding that out in a room
 * at 9am is the failure this sentence exists to prevent.
 */
export function protocolLabel(client: { isQbtcp: boolean }): string {
  return client.isQbtcp ? 'QBTCP v1' : 'Legacy API fallback';
}

interface IReadinessSnapshot {
  localStorage: boolean;
  serviceWorker: ServiceWorkerState;
  installed: boolean;
  secureContext: boolean;
  broadcastChannel: boolean;
  persistentStorage: boolean | null;
  storageUsage?: number;
  storageQuota?: number;
  localNetworkPermission: LocalNetworkPermissionState;
  online: boolean;
  safari: boolean;
}

interface IReadinessCheck {
  id: string;
  title: string;
  detail: string;
  state: CheckState;
  kind: CheckKind;
}

function localStorageWorks(): boolean {
  const key = '__qbsheet_readiness__';
  try {
    window.localStorage.setItem(key, 'ok');
    const value = window.localStorage.getItem(key);
    window.localStorage.removeItem(key);
    return value === 'ok';
  } catch {
    return false;
  }
}

function installedAsApp(): boolean {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  // Guarded rather than called, because this runs inside the check sweep and a browser without
  // `matchMedia` would throw out of it — which used to leave the whole screen saying "Checking this
  // device…" with no way to retry. "Not installed" is the right answer for a browser that cannot say.
  const standalone =
    typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  return standalone || iosNavigator.standalone === true;
}

async function serviceWorkerState(): Promise<ServiceWorkerState> {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  if (navigator.serviceWorker.controller) return 'controlled';
  try {
    return (await navigator.serviceWorker.getRegistration()) ? 'registered' : 'missing';
  } catch {
    return 'missing';
  }
}

async function localNetworkPermission(): Promise<LocalNetworkPermissionState> {
  if (!navigator.permissions?.query) return 'unsupported';

  // Chrome 145 split Local Network Access into `local-network` and `loopback-network`.
  // Older Chrome exposed `local-network-access`; query both without assuming either exists.
  for (const name of ['local-network', 'local-network-access'] as const) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName });
      return status.state;
    } catch {
      // Unknown permission names throw. Try the other spelling before calling it unsupported.
    }
  }
  return 'unsupported';
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function statusMark(state: CheckState): string {
  if (state === 'pass') return '✓';
  if (state === 'fail') return '×';
  if (state === 'warn') return '!';
  return '○';
}

interface IOptionalPersistenceStorage {
  persist?: () => Promise<boolean>;
}

function persistenceStorage(): IOptionalPersistenceStorage | undefined {
  return (navigator as unknown as { storage?: IOptionalPersistenceStorage }).storage;
}

export default function DeviceReadiness(props: {
  durable: boolean;
  rememberedServer?: string;
  /** The paired room's name, for orientation in the diagnostics file. Never its id or token. */
  roomName?: string;
  /** How many games are on this device, and what this build could not read. */
  games?: { saved: number; unfinished: number; unreadable: IUnreadableRecord[] };
  /**
   * The credentials this device currently holds.
   *
   * Passed in so the diagnostics export can prove none of them reached the file, rather than trusting
   * that they did not. Nothing here is rendered, logged or written; see `findLeaks`.
   */
  liveSecrets?: readonly string[];
  onBack: () => void;
}) {
  const { durable, rememberedServer = '', roomName, games, liveSecrets = [], onBack } = props;
  const [snapshot, setSnapshot] = useState<IReadinessSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [requestingPersistence, setRequestingPersistence] = useState(false);
  const [serverAddress, setServerAddress] = useState(rememberedServer);
  const [serverTest, setServerTest] = useState<ServerTestState>({ kind: 'untested' });
  const [downloadState, setDownloadState] = useState<DownloadState>('untested');
  const [workerBuild, setWorkerBuild] = useState<IWorkerBuild | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsOutcome | null>(null);
  const update = useAppUpdate();

  const runChecks = useCallback(async () => {
    setChecking(true);
    let persistentStorage: boolean | null = null;
    let storageUsage: number | undefined;
    let storageQuota: number | undefined;

    if (navigator.storage?.persisted) {
      try {
        persistentStorage = await navigator.storage.persisted();
      } catch {
        persistentStorage = false;
      }
    }
    if (navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        storageUsage = estimate.usage;
        storageQuota = estimate.quota;
      } catch {
        // Quota is informational only.
      }
    }

    try {
      const [worker, permission, reportedBuild] = await Promise.all([
        serviceWorkerState(),
        localNetworkPermission(),
        // Asks the worker actually serving this page what it is. A page running new code off the network
        // while an old worker still owns the cache is a real state and this is the only way to see it.
        serviceWorkerBuild(),
      ]);
      setWorkerBuild(reportedBuild);
      setSnapshot({
        localStorage: localStorageWorks(),
        serviceWorker: worker,
        installed: installedAsApp(),
        secureContext: window.isSecureContext,
        broadcastChannel: typeof BroadcastChannel !== 'undefined',
        persistentStorage,
        storageUsage,
        storageQuota,
        localNetworkPermission: permission,
        online: navigator.onLine,
        safari: isSafariBrowser(),
      });
    } finally {
      // Always, even if one of the probes above threw. This screen exists to be used on a locked-down
      // browser that is behaving unexpectedly, which is exactly where a probe is most likely to throw —
      // and a readiness screen stuck on "Checking this device…" with its retry button disabled is the
      // least helpful thing it could possibly do.
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const requestPersistence = async () => {
    const storage = persistenceStorage();
    if (typeof storage?.persist !== 'function') return;
    setRequestingPersistence(true);
    try {
      await storage.persist();
    } finally {
      setRequestingPersistence(false);
      await runChecks();
    }
  };

  const testServer = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeBaseUrl(serverAddress);
    if (!normalized.ok) {
      setServerTest({ kind: 'failed', message: normalized.error });
      return;
    }
    if (isSafariBrowser()) {
      setServerAddress(normalized.value);
      setServerTest({
        kind: 'failed',
        message:
          'Safari cannot use QBSheet connected scoring with the current plain-HTTP LAN Tournament Control server. Use Chrome or Edge on this device, or score from a game file instead.',
      });
      return;
    }

    setServerTest({ kind: 'testing' });
    const client = new FruityServerClient(normalized.value);
    // The client discovers on its first call, exactly as it does for a live room, so the protocol
    // this reports is the one a scorekeeper would actually get at this address.
    const result = await client.verify();
    await runChecks();
    if (result.ok) {
      setServerAddress(normalized.value);
      setServerTest({
        kind: 'passed',
        message: `Tournament control answered at ${normalized.value}.`,
        protocol: protocolLabel(client),
        canonical: client.isQbtcp,
        server: { ...client.describeProtocol(), address: safeAddress(normalized.value) },
      });
    } else {
      setServerTest({ kind: 'failed', message: result.error });
    }
  };

  const startDownloadTest = () => {
    const blob = new Blob(['QBSheet download readiness test\n'], { type: 'text/plain' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = 'qbsheet-download-test.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
    setDownloadState('waiting');
  };

  const checks = useMemo<IReadinessCheck[]>(() => {
    if (!snapshot) return [];
    const storageDetail =
      snapshot.storageUsage !== undefined && snapshot.storageQuota !== undefined
        ? `${formatBytes(snapshot.storageUsage)} used of ${formatBytes(snapshot.storageQuota)} available to this origin.`
        : 'The browser did not report storage usage.';

    const workerCheck: IReadinessCheck = (() => {
      if (snapshot.serviceWorker === 'controlled') {
        return {
          id: 'offline',
          title: 'Offline app',
          detail: 'The QBSheet service worker is controlling this page.',
          state: 'pass',
          kind: 'recommended',
        };
      }
      if (snapshot.serviceWorker === 'registered') {
        return {
          id: 'offline',
          title: 'Offline app',
          detail: 'The offline worker is installed but is not controlling this tab yet. Reload once before the tournament.',
          state: 'warn',
          kind: 'recommended',
        };
      }
      return {
        id: 'offline',
        title: 'Offline app',
        detail:
          snapshot.serviceWorker === 'unsupported'
            ? 'This browser does not support service workers, so QBSheet cannot cold-start offline.'
            : 'No QBSheet service worker is registered yet. Stay online and reload before the tournament.',
        state: 'warn',
        kind: 'recommended',
      };
    })();

    const permission = snapshot.localNetworkPermission;
    const permissionCheck: IReadinessCheck = snapshot.safari
      ? {
          id: 'local-network',
          title: 'Local network access',
          detail:
            'Safari cannot use QBSheet connected scoring with the current HTTPS-to-HTTP LAN Tournament Control connection. Use Chrome or Edge for connected scoring.',
          state: 'fail',
          kind: 'connected',
        }
      : permission === 'granted'
        ? {
            id: 'local-network',
            title: 'Local network access',
            detail: 'This browser has granted access to devices on the local network.',
            state: 'pass',
            kind: 'connected',
          }
        : permission === 'denied'
          ? {
              id: 'local-network',
              title: 'Local network access',
              detail: 'Local network access is denied. Connected scoring cannot reach a LAN tournament server until it is allowed.',
              state: 'fail',
              kind: 'connected',
            }
          : permission === 'prompt'
            ? {
                id: 'local-network',
                title: 'Local network access',
                detail: 'Not granted yet. Testing tournament control below should trigger the browser permission prompt.',
                state: 'info',
                kind: 'connected',
              }
            : {
                id: 'local-network',
                title: 'Local network access',
                detail: 'This browser does not expose the Local Network Access permission state. Use the connection test below to verify it directly.',
                state: 'info',
                kind: 'connected',
              };

    const downloadCheck: IReadinessCheck =
      downloadState === 'passed'
        ? {
            id: 'downloads',
            title: 'Backup downloads',
            detail: 'A test file downloaded successfully.',
            state: 'pass',
            kind: 'required',
          }
        : downloadState === 'failed'
          ? {
              id: 'downloads',
              title: 'Backup downloads',
              detail: 'The test file did not download. Fix browser download restrictions before relying on QBJ backup.',
              state: 'fail',
              kind: 'required',
            }
          : {
              id: 'downloads',
              title: 'Backup downloads',
              detail: 'Not tested yet. QBSheet cannot verify a completed browser download without asking you.',
              state: 'info',
              kind: 'required',
            };

    return [
      {
        id: 'game-storage',
        title: 'Game storage',
        detail: durable
          ? 'IndexedDB is writable, so saved games survive a tab or browser restart.'
          : 'IndexedDB is not durable on this device. A closed tab can lose the game.',
        state: durable ? 'pass' : 'fail',
        kind: 'required',
      },
      {
        id: 'journal',
        title: 'Emergency journal',
        detail: snapshot.localStorage
          ? 'localStorage can write and read the in-progress event journal.'
          : 'localStorage is blocked or unavailable. The synchronous recovery journal cannot be trusted.',
        state: snapshot.localStorage ? 'pass' : 'fail',
        kind: 'required',
      },
      downloadCheck,
      {
        id: 'installed',
        title: 'Installed app',
        detail: snapshot.installed
          ? 'QBSheet is running in standalone app mode.'
          : 'QBSheet is running in a browser tab. That works, but installing the PWA is recommended for tournament devices.',
        state: snapshot.installed ? 'pass' : 'warn',
        kind: 'recommended',
      },
      workerCheck,
      {
        id: 'persistent-storage',
        title: 'Protected storage',
        detail:
          snapshot.persistentStorage === true
            ? `The browser marked QBSheet storage persistent. ${storageDetail}`
            : snapshot.persistentStorage === false
              ? `Storage is currently evictable if the browser needs space. ${storageDetail}`
              : `This browser does not expose persistent-storage status. ${storageDetail}`,
        state: snapshot.persistentStorage === true ? 'pass' : 'warn',
        kind: 'recommended',
      },
      {
        id: 'duplicate-tabs',
        title: 'Duplicate-tab guard',
        detail: snapshot.broadcastChannel
          ? 'BroadcastChannel is available, so QBSheet can warn when the same game is open in another live tab.'
          : 'BroadcastChannel is unavailable. Scoring still works, but QBSheet cannot detect the same game in another tab.',
        state: snapshot.broadcastChannel ? 'pass' : 'warn',
        kind: 'recommended',
      },
      {
        id: 'secure-context',
        title: 'Secure browser context',
        detail: snapshot.secureContext
          ? 'Browser security APIs are available to QBSheet.'
          : 'This page is not in a secure context. Connected scoring and offline features may be restricted.',
        state: snapshot.secureContext ? 'pass' : 'fail',
        kind: 'connected',
      },
      permissionCheck,
      {
        id: 'network',
        title: 'Current network',
        detail: snapshot.online
          ? 'The browser currently reports a network connection.'
          : 'The browser reports that it is offline. File scoring can still work if the app is cached.',
        state: snapshot.online ? 'pass' : 'info',
        kind: 'connected',
      },
    ];
  }, [durable, downloadState, snapshot]);

  /**
   * Write the diagnostics file.
   *
   * Everything the bundle needs is already on this screen — which is why the button lives here rather
   * than somewhere it would have to re-run the checks to have anything to say. The readiness results go
   * in exactly as rendered, so the file and the screen can never disagree.
   */
  const saveDiagnostics = () => {
    const address = safeAddress(serverAddress);
    setDiagnostics(
      downloadDiagnostics(
        {
          worker: workerBuild,
          updateWaiting: update.available,
          checks: checks.map((check) => ({
            id: check.id,
            title: check.title,
            state: check.state,
            kind: check.kind,
            detail: check.detail,
          })),
          server:
            serverTest.kind === 'passed'
              ? serverTest.server
              : { protocol: 'unknown', ...(address ? { address } : {}) },
          ...(roomName ? { roomName } : {}),
          persistence: {
            recordStoreDurable: durable,
            localStorageWorks: snapshot?.localStorage,
            persistentStorage: snapshot?.persistentStorage ?? null,
            ...(snapshot?.storageUsage !== undefined ? { storageUsage: snapshot.storageUsage } : {}),
            ...(snapshot?.storageQuota !== undefined ? { storageQuota: snapshot.storageQuota } : {}),
          },
          ...(games ? { games } : {}),
        },
        liveSecrets,
      ),
    );
  };

  const requiredFailures = checks.filter((check) => check.kind === 'required' && check.state === 'fail').length;
  const connectedFailures = checks.filter((check) => check.kind === 'connected' && check.state === 'fail').length;
  const connectedIntent = serverAddress.trim() !== '' || serverTest.kind !== 'untested';
  const recommendations = checks.filter((check) => check.kind === 'recommended' && check.state === 'warn').length;
  const requiredUntested = checks.some((check) => check.kind === 'required' && check.state === 'info');
  const connectedBlocked = connectedIntent && connectedFailures > 0;

  const sections: Array<{ kind: CheckKind; title: string }> = [
    { kind: 'required', title: 'Required for a safe game' },
    { kind: 'recommended', title: 'Recommended before the tournament' },
    { kind: 'connected', title: 'Connected scoring' },
  ];

  return (
    <main className="shell readiness-shell">
      <header className="shell-header readiness-header">
        <div>
          <button type="button" className="shell-back" onClick={onBack}>
            ← QBSheet
          </button>
          <h1 className="shell-title">Device readiness</h1>
          <p className="shell-subtitle">Check this browser before it is needed in a room.</p>
          {/* Small, and directly under the title, because it is the one fact on this screen that a
              director will be asked to read out over a radio. */}
          <p className="readiness-build">Build {buildLabel()}</p>
        </div>
        <button type="button" className="shell-button" disabled={checking} onClick={() => void runChecks()}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </header>

      {snapshot && (
        <section
          className={`readiness-summary ${requiredFailures > 0 || connectedBlocked ? 'is-failed' : requiredUntested ? 'is-pending' : 'is-ready'}`}
          aria-live="polite"
        >
          <strong>
            {requiredFailures > 0
              ? 'Fix before scoring'
              : connectedBlocked
                ? 'Not ready for connected scoring'
                : requiredUntested
                  ? 'One check still needs you'
                  : 'This device is ready'}
          </strong>
          <span>
            {requiredFailures > 0
              ? `${requiredFailures} required ${requiredFailures === 1 ? 'check needs' : 'checks need'} attention.`
              : connectedBlocked
                ? `${connectedFailures} connected-scoring ${connectedFailures === 1 ? 'check needs' : 'checks need'} attention. File scoring can still be used.`
                : requiredUntested
                  ? 'Run the backup download test below.'
                  : connectedFailures > 0
                    ? 'Ready for file scoring. Connected scoring needs attention below.'
                    : recommendations > 0
                      ? `${recommendations} ${recommendations === 1 ? 'recommendation' : 'recommendations'} remain.`
                      : 'All device checks passed.'}
          </span>
        </section>
      )}

      {!snapshot ? (
        <p className="shell-loading">Checking this device…</p>
      ) : (
        sections.map((section) => (
          <section className="shell-section readiness-section" key={section.kind}>
            <h2 className="shell-heading">{section.title}</h2>
            <ul className="readiness-list">
              {checks
                .filter((check) => check.kind === section.kind)
                .map((check) => (
                  <li className={`readiness-row is-${check.state}`} key={check.id}>
                    <span className="readiness-mark" aria-hidden="true">
                      {statusMark(check.state)}
                    </span>
                    <div>
                      <p className="readiness-name">{check.title}</p>
                      <p className="readiness-detail">{check.detail}</p>
                      {check.id === 'persistent-storage' &&
                        snapshot.persistentStorage === false &&
                        typeof persistenceStorage()?.persist === 'function' && (
                          <button
                            type="button"
                            className="shell-button readiness-inline-action"
                            disabled={requestingPersistence}
                            onClick={() => void requestPersistence()}
                          >
                            {requestingPersistence ? 'Requesting…' : 'Protect storage'}
                          </button>
                        )}
                      {check.id === 'downloads' && downloadState === 'untested' && (
                        <button type="button" className="shell-button readiness-inline-action" onClick={startDownloadTest}>
                          Test download
                        </button>
                      )}
                      {check.id === 'downloads' && downloadState === 'waiting' && (
                        <div className="readiness-confirm">
                          <span>Did qbsheet-download-test.txt download?</span>
                          <button type="button" className="shell-button" onClick={() => setDownloadState('passed')}>
                            Yes
                          </button>
                          <button type="button" className="shell-button" onClick={() => setDownloadState('failed')}>
                            No
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}

      <section className="shell-section">
        <h2 className="shell-heading">Tournament control</h2>
        <form className="connect-form readiness-server-test" onSubmit={(event) => void testServer(event)}>
          <label className="shell-label" htmlFor="readiness-server-address">
            Tournament control address
          </label>
          <input
            id="readiness-server-address"
            className="shell-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://192.168.1.24:8787"
            value={serverAddress}
            onChange={(event) => {
              setServerAddress(event.target.value);
              setServerTest({ kind: 'untested' });
            }}
          />
          <button type="submit" className="shell-button is-primary" disabled={serverTest.kind === 'testing'}>
            {serverTest.kind === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
        </form>
        {serverTest.kind === 'passed' && (
          <>
            <p className="readiness-test-result is-pass">✓ {serverTest.message}</p>
            <p className="readiness-detail">
              Protocol: {serverTest.protocol}.{' '}
              {serverTest.canonical
                ? 'This device is using the canonical protocol.'
                : 'This server did not announce QBTCP, so this device is using the deprecated /api/v1 routes. Scoring works; ask whether tournament control can be updated.'}
            </p>
          </>
        )}
        {serverTest.kind === 'failed' && <p className="readiness-test-result is-fail">× {serverTest.message}</p>}
      </section>

      <section className="shell-section">
        <h2 className="shell-heading">Diagnostics</h2>
        <p className="readiness-detail">
          Saves one file describing this device: the build it is running, the browser and screen, every
          check above, what tournament control answered, storage health, recent connection activity and
          any recent errors. It contains no pairing code, no room or session token, and nothing typed into
          a message box, so it is safe to send to whoever is helping.
        </p>
        <button type="button" className="shell-button readiness-inline-action" onClick={saveDiagnostics}>
          Download diagnostics
        </button>
        {diagnostics?.ok === true && (
          <p className="readiness-test-result is-pass">✓ Saved {diagnostics.fileName}.</p>
        )}
        {diagnostics?.ok === false && diagnostics.reason === 'no-download' && (
          <p className="readiness-test-result is-fail">
            × This browser would not write the file. Check the download test above.
          </p>
        )}
        {diagnostics?.ok === false && diagnostics.reason === 'unsafe' && (
          /* Should be unreachable. It is loud rather than silent because the alternative to refusing
             here is a file with a live credential in it. */
          <p className="readiness-test-result is-fail" role="alert">
            × QBSheet stopped the download because the file would have contained something private. Please
            report this: {diagnostics.leaks.join('; ')}
          </p>
        )}
      </section>
    </main>
  );
}
