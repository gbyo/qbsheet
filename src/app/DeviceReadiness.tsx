import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import FruityServerClient, { normalizeBaseUrl } from '../integrations/fruity/FruityServerClient';

type CheckState = 'pass' | 'warn' | 'fail' | 'info';
type CheckKind = 'required' | 'recommended' | 'connected';

type ServiceWorkerState = 'unsupported' | 'missing' | 'registered' | 'controlled';
type LocalNetworkPermissionState = PermissionState | 'unsupported';
type DownloadState = 'untested' | 'waiting' | 'passed' | 'failed';

type ServerTestState =
  | { kind: 'untested' }
  | { kind: 'testing' }
  | { kind: 'passed'; message: string }
  | { kind: 'failed'; message: string };

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
  return window.matchMedia('(display-mode: standalone)').matches || iosNavigator.standalone === true;
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
  onBack: () => void;
}) {
  const { durable, rememberedServer = '', onBack } = props;
  const [snapshot, setSnapshot] = useState<IReadinessSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [requestingPersistence, setRequestingPersistence] = useState(false);
  const [serverAddress, setServerAddress] = useState(rememberedServer);
  const [serverTest, setServerTest] = useState<ServerTestState>({ kind: 'untested' });
  const [downloadState, setDownloadState] = useState<DownloadState>('untested');

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

    const [worker, permission] = await Promise.all([serviceWorkerState(), localNetworkPermission()]);
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
    });
    setChecking(false);
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

    setServerTest({ kind: 'testing' });
    const result = await new FruityServerClient(normalized.value).verify();
    await runChecks();
    if (result.ok) {
      setServerAddress(normalized.value);
      setServerTest({ kind: 'passed', message: `Tournament control answered at ${normalized.value}.` });
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
    const permissionCheck: IReadinessCheck =
      permission === 'granted'
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

  const requiredFailures = checks.filter((check) => check.kind === 'required' && check.state === 'fail').length;
  const recommendations = checks.filter((check) => check.kind === 'recommended' && check.state === 'warn').length;
  const requiredUntested = checks.some((check) => check.kind === 'required' && check.state === 'info');

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
        </div>
        <button type="button" className="shell-button" disabled={checking} onClick={() => void runChecks()}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </header>

      {snapshot && (
        <section
          className={`readiness-summary ${requiredFailures > 0 ? 'is-failed' : requiredUntested ? 'is-pending' : 'is-ready'}`}
          aria-live="polite"
        >
          <strong>
            {requiredFailures > 0
              ? 'Fix before scoring'
              : requiredUntested
                ? 'One check still needs you'
                : 'This device is ready'}
          </strong>
          <span>
            {requiredFailures > 0
              ? `${requiredFailures} required ${requiredFailures === 1 ? 'check needs' : 'checks need'} attention.`
              : requiredUntested
                ? 'Run the backup download test below.'
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
        <h2 className="shell-heading">Test tournament control</h2>
        <p className="readiness-copy">
          Use the LAN address tournament control will actually give rooms. This makes a real QBSheet status request and is
          the best test of browser Local Network Access, mixed-content rules, CORS, and the server being reachable.
        </p>
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
        {serverTest.kind === 'passed' && <p className="readiness-test-result is-pass">✓ {serverTest.message}</p>}
        {serverTest.kind === 'failed' && <p className="readiness-test-result is-fail">× {serverTest.message}</p>}
      </section>

      <p className="readiness-footnote">
        File-only scoring does not require tournament control or Local Network Access. A connected-scoring failure should
        not stop a room from opening a .qbg file.
      </p>
    </main>
  );
}
