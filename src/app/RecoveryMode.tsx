/**
 * A deliberately separate, low-level recovery screen.
 *
 * This module is loaded only after `?recovery=1` is seen by the bootstrap. It does not import the
 * normal App, Welcome screen, scorer, connected runtime, or application chrome. Its inspection is
 * read-only; any file, restore, or folder action is explicit, and restore always creates a separate attempt.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { isActive } from '../game/GameStore';
import type { IStoredGameRecord } from '../game/GameStore';
import { downloadFile } from '../integrations/file/QbjDownload';
import { ExternalBackupTarget } from '../recovery/ExternalBackup';
import type { IQbsheetBackup } from '../scorer/QBSheetBackup';
import { journalFileContents, journalFileName } from './RecoveryJournal';
import {
  formatRecoveryAge,
  loadRecoverySources,
  maxQbsheetBackupBytes,
  parseRecoveryFileText,
  recoverySourceLabel,
  recoveryStatusLabel,
  restoreBackupAsSeparateAttempt,
} from './RecoveryModeSupport';
import type { IRecoveryGameStatus, IRecoverySnapshot, RestoreBackupResult } from './RecoveryModeSupport';
import { normalModeHref } from './recoveryModeRequest';
import './recovery.css';

type RawFileState = 'idle' | 'saved' | 'empty' | 'failed';

export interface IRecoveryModeProps {
  /** Test seam and host integration seam; the default only changes the URL after a button press. */
  onResume?: (record: IStoredGameRecord) => void;
  onLeave?: () => void;
  /** Test seam for the existing exact backup import path. */
  onRestoreBackup?: (
    backup: Parameters<typeof restoreBackupAsSeparateAttempt>[0],
    store: IRecoverySnapshot['store'],
    now: Date,
  ) => Promise<RestoreBackupResult>;
  /** Test seam for a browser download, matching the existing download helper's contract. */
  write?: (contents: string, fileName: string) => boolean;
  /** Test seam for source loading; no picker or permission request is part of startup. */
  loadSources?: () => Promise<IRecoverySnapshot>;
  now?: () => Date;
}

function currentTime(now: (() => Date) | undefined): Date {
  try {
    return now ? now() : new Date();
  } catch {
    return new Date();
  }
}

function defaultResume(record: IStoredGameRecord): void {
  if (typeof window !== 'undefined') window.location.assign(normalModeHref(window.location));
  void record;
}

function sourceSummary(source: IRecoveryGameStatus['sources'][number], at: Date): string {
  const details = [
    recoveryStatusLabel(source.status),
    formatRecoveryAge(source.updatedAt, at),
    source.eventCount === undefined
      ? undefined
      : `${source.eventCount} event${source.eventCount === 1 ? '' : 's'}`,
    source.latestQuestion === undefined ? undefined : `through TU ${source.latestQuestion}`,
  ].filter((value): value is string => value !== undefined && value !== '');
  return details.join(' · ');
}

function restoreLabel(result: Extract<RestoreBackupResult, { ok: true }>): string {
  if (result.restoringAlongsideActive) {
    return 'This backup was restored as a separate local attempt. An existing unfinished copy was left untouched; confirm which copy is current before scoring.';
  }
  if (result.skippedOccupiedSlot) {
    return 'This backup was restored as a separate local attempt. Another unreadable local record was left untouched.';
  }
  return result.journalSaved
    ? 'This backup was restored as a separate local attempt on this device.'
    : 'This backup was restored, but its fast recovery journal could not be saved.';
}

function GameSources(props: {
  game: IRecoveryGameStatus;
  index: number;
  inspectedAt: Date;
  onResume: (record: IStoredGameRecord) => void;
  onSelectBackup: (backup: IQbsheetBackup, label: string) => void;
}) {
  const { game, index, inspectedAt, onResume, onSelectBackup } = props;
  const resumable =
    game.record !== undefined &&
    isActive(game.record) &&
    (game.resumeSource === 'journal' || game.resumeSource === 'durable');
  const hasRestorableBackup = game.sources.some(
    (source) =>
      source.status === 'valid' &&
      source.backup !== undefined &&
      (source.kind === 'checkpoint' || source.kind === 'external'),
  );
  return (
    <article className="recovery-game" aria-labelledby={`recovery-game-${index}`}>
      <div className="recovery-game-heading">
        <div>
          <h3 id={`recovery-game-${index}`}>{game.matchup}</h3>
          <p>{game.label}</p>
        </div>
        {resumable && (
          <button type="button" className="recovery-button is-primary" onClick={() => onResume(game.record!)}>
            Resume safest copy
          </button>
        )}
      </div>
      <dl className="recovery-sources">
        {game.sources.map((source) => (
          <div key={source.id ?? source.kind}>
            <dt>{source.label}</dt>
            <dd>
              <span className={`recovery-status is-${source.status}`}>
                {sourceSummary(source, inspectedAt)}
              </span>
              {source.status === 'valid' &&
                source.kind === 'journal' &&
                game.sources.some((other) => other.kind === 'durable' && other.status === 'valid') && (
                  <small>Readable local copies found.</small>
                )}
              {source.status === 'valid' &&
                source.backup &&
                (source.kind === 'checkpoint' || source.kind === 'external') && (
                  <button
                    type="button"
                    className="recovery-source-action"
                    onClick={() => onSelectBackup(source.backup!, source.label)}
                  >
                    Restore this version as a separate attempt
                  </button>
                )}
            </dd>
          </div>
        ))}
      </dl>
      {!resumable && game.record === undefined && !hasRestorableBackup && (
        <p className="recovery-hint">
          This journal has no readable game definition attached to it. Save the raw journal below for a
          director or another QBSheet build.
        </p>
      )}
    </article>
  );
}

export default function RecoveryMode(props: IRecoveryModeProps = {}) {
  const [snapshot, setSnapshot] = useState<IRecoverySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [rawFile, setRawFile] = useState<RawFileState>('idle');
  const [fileError, setFileError] = useState('');
  const [pendingBackup, setPendingBackup] = useState<
    Parameters<typeof restoreBackupAsSeparateAttempt>[0] | null
  >(null);
  const [pendingBackupName, setPendingBackupName] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState('');
  const [externalBusy, setExternalBusy] = useState(false);
  const [externalNotice, setExternalNotice] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const loaded = await (
        props.loadSources ?? (() => loadRecoverySources({ now: currentTime(props.now) }))
      )();
      setSnapshot(loaded);
    } catch {
      setLoadError(
        'QBSheet could not inspect local recovery sources. The raw journal export may still be available.',
      );
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [props.loadSources, props.now]);

  useEffect(() => {
    // Start on the next microtask so the effect is only the bridge to the async source read, not a
    // synchronous state cascade during React's commit.
    void Promise.resolve().then(() => load());
  }, [load]);

  const saveRawJournal = () => {
    const journals = snapshot?.journals ?? {};
    if (Object.keys(journals).length === 0) {
      setRawFile('empty');
      return;
    }
    const now = currentTime(props.now);
    const write = props.write ?? ((contents: string, fileName: string) => downloadFile(contents, fileName));
    setRawFile(write(journalFileContents(journals, now), journalFileName(now)) ? 'saved' : 'failed');
  };

  const readBackupFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    setFileError('');
    setPendingBackup(null);
    setPendingBackupName('');
    if (!file) return;
    if (file.size > maxQbsheetBackupBytes) {
      setFileError('That QBSheet backup is larger than this recovery screen will safely open.');
      return;
    }
    try {
      const parsed = parseRecoveryFileText(await file.text());
      if (!parsed.ok) {
        setFileError(parsed.errors[0] ?? 'That file is not a readable QBSheet backup.');
        return;
      }
      setPendingBackup(parsed.backup);
      setPendingBackupName(file.name);
    } catch {
      setFileError('QBSheet could not read that backup file. Nothing on this device was changed.');
    }
  };

  const restoreBackup = async () => {
    if (!pendingBackup || !snapshot || restoreBusy) return;
    setRestoreBusy(true);
    setRestoreNotice('');
    try {
      const result = props.onRestoreBackup
        ? await props.onRestoreBackup(pendingBackup, snapshot.store, currentTime(props.now))
        : await restoreBackupAsSeparateAttempt(pendingBackup, snapshot.store, currentTime(props.now));
      if (result.ok) {
        setRestoreNotice(restoreLabel(result));
        setPendingBackup(null);
        setPendingBackupName('');
        await load();
      } else {
        setRestoreNotice(result.message);
      }
    } catch {
      setRestoreNotice('QBSheet could not complete that restore. No existing local record was changed.');
    } finally {
      setRestoreBusy(false);
    }
  };

  const manageExternalBackup = async () => {
    if (!snapshot?.recoveryStore || externalBusy) return;
    setExternalBusy(true);
    setExternalNotice('');
    try {
      const target = new ExternalBackupTarget(snapshot.recoveryStore);
      const state = snapshot.externalBackup?.state;
      const result =
        state === 'needs-permission' || state === 'folder-unavailable'
          ? await target.reconnectFromUserGesture()
          : await target.setupFromUserGesture();
      setExternalNotice(
        result.ok
          ? 'External backup folder updated. Existing backup files were not deleted.'
          : result.cancelled
            ? 'Folder selection was cancelled. Local protection is still active.'
            : 'QBSheet could not update that folder. Existing backup files were not deleted.',
      );
      await load();
    } catch {
      setExternalNotice('QBSheet could not update that folder. Existing backup files were not deleted.');
    } finally {
      setExternalBusy(false);
    }
  };

  const resume = props.onResume ?? defaultResume;
  const leave =
    props.onLeave ??
    (() => {
      if (typeof window !== 'undefined') window.location.assign(normalModeHref(window.location));
    });
  const inspectedAt = snapshot?.inspectedAt ?? currentTime(props.now);
  const selectSourceBackup = (backup: IQbsheetBackup, label: string) => {
    setFileError('');
    setRestoreNotice('');
    setPendingBackup(backup);
    setPendingBackupName(label);
  };

  return (
    <main className="recovery-screen" aria-labelledby="recovery-title">
      <header className="recovery-header">
        <p className="recovery-eyebrow">QBSheet</p>
        <h1 id="recovery-title">Recovery Mode</h1>
        <p>
          This is a quiet view of the copies QBSheet can find. Inspection does not open the scorer, contact
          tournament control, request folder access on startup, or clear anything.
        </p>
      </header>

      {loading && (
        <p className="recovery-panel" role="status">
          Inspecting local recovery sources…
        </p>
      )}
      {loadError !== '' && (
        <p className="recovery-panel is-warning" role="alert">
          {loadError}
        </p>
      )}

      {snapshot && (
        <>
          <section className="recovery-panel" aria-labelledby="recovery-status-title">
            <div className="recovery-section-heading">
              <div>
                <h2 id="recovery-status-title">Local recovery status</h2>
                <p>Nothing in this inspection changes a journal or a durable game record.</p>
              </div>
              <button
                type="button"
                className="recovery-button"
                onClick={() => void load()}
                disabled={loading}
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {snapshot.journalUnavailable && (
              <p className="recovery-inline-warning" role="alert">
                The instant scoring journal could not be inspected. Its raw contents were not changed.
              </p>
            )}
            {!snapshot.durable && (
              <p className="recovery-inline-warning" role="alert">
                The durable device copy is unavailable in this browser. The instant journal remains a separate
                source; do not close a game until it is saved elsewhere.
              </p>
            )}
            {snapshot.storageDegraded && snapshot.storageError && (
              <p className="recovery-inline-warning" role="alert">
                {snapshot.storageError}
              </p>
            )}
            {snapshot.unreadableCount > 0 && (
              <p className="recovery-inline-warning" role="alert">
                {snapshot.unreadableCount === 1 ? 'One' : snapshot.unreadableCount} local record
                {snapshot.unreadableCount === 1 ? ' is' : 's are'} in a format this build cannot read. Nothing
                was overwritten.
              </p>
            )}

            {snapshot.externalBackup && snapshot.externalBackup.state !== 'unsupported' && (
              <div className="recovery-external-status">
                <p>
                  <strong>External backup:</strong>{' '}
                  {snapshot.externalBackup.state === 'ready'
                    ? `${snapshot.externalBackup.directoryName ?? 'Connected folder'}${
                        snapshot.externalBackup.lastSuccessfulWriteAt
                          ? ` · ${formatRecoveryAge(snapshot.externalBackup.lastSuccessfulWriteAt, inspectedAt)}`
                          : ''
                      }`
                    : snapshot.externalBackup.state === 'not-configured'
                      ? 'Not configured'
                      : recoveryStatusLabel(snapshot.externalBackup.state)}
                </p>
                {(snapshot.externalBackup.state === 'not-configured' ||
                  snapshot.externalBackup.state === 'ready' ||
                  snapshot.externalBackup.state === 'needs-permission' ||
                  snapshot.externalBackup.state === 'folder-unavailable' ||
                  snapshot.externalBackup.state === 'backup-failed') && (
                  <button
                    type="button"
                    className="recovery-button"
                    onClick={() => void manageExternalBackup()}
                    disabled={externalBusy}
                  >
                    {externalBusy
                      ? 'Updating…'
                      : snapshot.externalBackup.state === 'not-configured'
                        ? 'Set up external backup…'
                        : snapshot.externalBackup.state === 'needs-permission' ||
                            snapshot.externalBackup.state === 'folder-unavailable'
                          ? 'Reconnect external folder…'
                          : 'Manage external folder…'}
                  </button>
                )}
                {externalNotice !== '' && (
                  <p className="recovery-note" role="status">
                    {externalNotice}
                  </p>
                )}
              </div>
            )}

            {snapshot.games.length === 0 ? (
              <p className="recovery-empty">No readable local game copy was found.</p>
            ) : (
              <div className="recovery-game-list">
                {snapshot.games.map((game, index) => (
                  <GameSources
                    key={game.key}
                    game={game}
                    index={index}
                    inspectedAt={inspectedAt}
                    onResume={resume}
                    onSelectBackup={selectSourceBackup}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="recovery-panel" aria-labelledby="recovery-actions-title">
            <h2 id="recovery-actions-title">Recovery actions</h2>
            <p>Choose an action deliberately. Existing local copies are preserved.</p>
            <div className="recovery-actions">
              <button type="button" className="recovery-button" onClick={saveRawJournal}>
                Save raw recovery file
              </button>
              <button type="button" className="recovery-button" onClick={() => fileInput.current?.click()}>
                Open QBSheet backup…
              </button>
              <input
                ref={fileInput}
                className="recovery-file-input"
                type="file"
                accept=".qbsheet,application/json"
                aria-label="Open QBSheet backup file"
                onChange={(event) => void readBackupFile(event)}
              />
            </div>

            {rawFile !== 'idle' && (
              <p className="recovery-note" role="status">
                {rawFile === 'saved' && 'The raw journal file was offered to this browser’s downloads.'}
                {rawFile === 'empty' && 'No raw journal entries were available to export.'}
                {rawFile === 'failed' && 'This browser refused the raw journal download.'}
              </p>
            )}

            {fileError !== '' && (
              <p className="recovery-inline-warning" role="alert">
                {fileError}
              </p>
            )}
            {pendingBackup && (
              <div className="recovery-backup-preview" role="status">
                <h3>Backup ready to inspect</h3>
                <p>
                  {pendingBackupName || 'QBSheet backup'} · {pendingBackup.package.left.name} vs{' '}
                  {pendingBackup.package.right.name} · {pendingBackup.events.length} event
                  {pendingBackup.events.length === 1 ? '' : 's'}
                </p>
                <button
                  type="button"
                  className="recovery-button is-primary"
                  onClick={() => void restoreBackup()}
                  disabled={restoreBusy}
                >
                  {restoreBusy ? 'Restoring…' : 'Restore as separate local attempt'}
                </button>
              </div>
            )}
            {restoreNotice !== '' && (
              <p className="recovery-note" role="status">
                {restoreNotice}
              </p>
            )}
          </section>
        </>
      )}

      <footer className="recovery-footer">
        <button type="button" className="recovery-button" onClick={leave}>
          Return to QBSheet
        </button>
        <p>When you are ready, returning to QBSheet removes Recovery Mode from the startup path.</p>
      </footer>
    </main>
  );
}

export { recoverySourceLabel };
