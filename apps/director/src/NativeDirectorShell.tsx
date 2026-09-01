import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  checkForUpdates,
  errorMessage,
  exportDiagnostics,
  getAppDataPaths,
  initializeDirectorStore,
  isNativeRuntime,
  openTournamentFile,
  persistWindowState,
  recordDirectorEvent,
  saveTournamentSnapshot,
  type AppDataPaths,
} from './platform/tauri';
import { createDirectorShellSnapshot, snapshotFileName } from './platform/snapshot';

export default function NativeDirectorShell({ children }: { children: ReactNode }) {
  const native = isNativeRuntime();
  const [paths, setPaths] = useState<AppDataPaths | null>(null);
  const [storeReady, setStoreReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState(native ? 'Starting local shell…' : 'Browser preview');

  useEffect(() => {
    if (!native) return;
    let mounted = true;

    void (async () => {
      try {
        const dataPaths = await getAppDataPaths();
        const databaseReady = await initializeDirectorStore();
        if (!mounted) return;
        setPaths(dataPaths);
        setStoreReady(databaseReady);
        setStatus(databaseReady ? 'Local store ready' : 'Local store unavailable');
        await recordDirectorEvent('shell_started');
      } catch (error) {
        if (mounted) setStatus(`Shell startup issue: ${errorMessage(error)}`);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [native]);

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      if (busy) return;
      setBusy(label);
      try {
        await action();
      } catch (error) {
        setStatus(`${label} failed: ${errorMessage(error)}`);
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const runOpen = useCallback(
    () =>
      run('Open', async () => {
        if (!native) {
          setStatus('Open is available in the packaged desktop app.');
          return;
        }
        const file = await openTournamentFile();
        if (!file) {
          setStatus('Open cancelled');
          return;
        }
        await recordDirectorEvent('tournament_file_opened');
        await persistWindowState();
        setStatus(`Opened ${file.path.split(/[\\/]/).pop() ?? 'tournament file'}`);
      }),
    [native, run],
  );

  const runSave = useCallback(
    () =>
      run('Save', async () => {
        if (!native) {
          setStatus('Save is available in the packaged desktop app.');
          return;
        }
        const now = new Date();
        const contents = `${JSON.stringify(createDirectorShellSnapshot(now), null, 2)}\n`;
        const path = await saveTournamentSnapshot(contents, snapshotFileName(now));
        if (!path) {
          setStatus('Save cancelled');
          return;
        }
        await recordDirectorEvent('shell_snapshot_saved');
        await persistWindowState();
        setStatus(`Saved ${path.split(/[\\/]/).pop() ?? 'snapshot'}`);
      }),
    [native, run],
  );

  const runDiagnostics = useCallback(
    () =>
      run('Diagnostics', async () => {
        if (!native) {
          setStatus('Diagnostics export is available in the packaged desktop app.');
          return;
        }
        const path = await exportDiagnostics();
        if (!path) {
          setStatus('Diagnostics export cancelled');
          return;
        }
        await recordDirectorEvent('diagnostics_exported');
        setStatus(`Saved ${path.split(/[\\/]/).pop() ?? 'diagnostics'}`);
      }),
    [native, run],
  );

  const runUpdateCheck = useCallback(
    () =>
      run('Update check', async () => {
        if (!native) {
          setStatus('Updates are checked by the packaged desktop app.');
          return;
        }
        const result = await checkForUpdates();
        setStatus(
          result.available
            ? `Update ${result.version ?? 'available'} is ready to review`
            : 'No update is available for this build',
        );
      }),
    [native, run],
  );

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'o') {
        event.preventDefault();
        void runOpen();
      } else if (key === 's') {
        event.preventDefault();
        void runSave();
      } else if (key === 'd' && event.shiftKey) {
        event.preventDefault();
        void runDiagnostics();
      }
    };

    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [runDiagnostics, runOpen, runSave]);

  return (
    <div className="director-native-frame">
      <header className="director-native-toolbar" aria-label="QBSheet desktop tools">
        <div className="director-native-session">
          <span className="director-native-session-mark" aria-hidden="true" />
          <strong>{native ? 'Desktop shell' : 'Browser preview'}</strong>
          <span className="director-native-session-divider" aria-hidden="true" />
          <span
            className="director-native-store"
            title={paths?.appData ? `App data: ${paths.appData}` : undefined}
          >
            {storeReady ? 'SQLite ready' : native ? 'SQLite starting' : 'Native store paused'}
          </span>
        </div>
        <div className="director-native-actions" aria-label="Desktop actions">
          <button type="button" onClick={runOpen} disabled={busy !== null}>
            Open file <kbd>⌘/Ctrl O</kbd>
          </button>
          <button type="button" onClick={runSave} disabled={busy !== null}>
            Save snapshot <kbd>⌘/Ctrl S</kbd>
          </button>
          <button type="button" onClick={runDiagnostics} disabled={busy !== null}>
            Diagnostics <kbd>⇧⌘/Ctrl D</kbd>
          </button>
          <button type="button" onClick={runUpdateCheck} disabled={busy !== null}>
            Check updates
          </button>
        </div>
        <span className="director-native-status" role="status" aria-live="polite">
          {busy ? `${busy}…` : status}
        </span>
      </header>
      {children}
    </div>
  );
}
