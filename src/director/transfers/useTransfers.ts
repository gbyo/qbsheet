/**
 * The Transfers runtime: polling, scanning, preparing, importing.
 *
 * # Restraint is the design constraint here, not throughput
 *
 * This runs all day on a laptop that is also running the QBTCP server, the schedule, and the
 * director's nerves. So: volumes are enumerated on a slow timer rather than continuously, a scan
 * happens only for locations the director marked as watched, a poll that finds nothing writes no
 * state at all, and a scan never overlaps itself. A feature that watched folders aggressively would
 * be a feature that heats the machine running the tournament.
 *
 * # A drive appearing is not permission to change anything
 *
 * Inserting a stick parses and stages what is on it and tells the director quietly. It does not
 * open a modal, it does not accept a result, and it does not touch the standings. Every staged
 * result waits in the results inbox for a person, exactly as a QBTCP result does.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DirectorId, DirectorState } from '../domain/model';
import type { DirectorController } from '../state/useDirectorController';
import {
  authorizeTransferRoot,
  chooseTransferFolder,
  createTransferPlatform,
  downloadTextFile,
  forgetTransferRoot,
} from '../platform/transfers';
import { qbjMimeType, type AssignmentSelection } from './assignment';
import { looksLikeTransferVolume } from './discover';
import { folderPollIntervalMs, volumePollIntervalMs } from './limits';
import { cloudOfflineAdvice, exchangePaths } from './layout';
import type { TransferLocation } from './model';
import { initializeExchange, planAssignments, prepareAssignments, type PrepareReport } from './prepare';
import { collectFromLocation, filesFromDataTransfer, readBrowserFiles } from './service';
import type { ImportSummary } from './state';
import { errorNotice, type AnnounceInput } from '../notices';

/** Shown when a drive with recognisable QBSheet data appears. Restrained, non-blocking, dismissible. */
export interface DriveNotice {
  locationId: DirectorId;
  label: string;
  resultCount: number;
  assignmentCount: number;
}

/** Operation keys for the Transfers concurrency-safe busy state. */
export function scanOperation(locationId: DirectorId): string {
  return `scan:${locationId}`;
}

/** Operation keys for the Transfers concurrency-safe busy state. */
export function prepareOperation(locationId: DirectorId): string {
  return `prepare:${locationId}`;
}

export const importFilesOperation = 'import:files';
export const importDropOperation = 'import:drop';

/**
 * Tracks in-flight async operations as a set of keys rather than a single boolean, so the
 * first completion can never mark a still-running operation idle. Rendered busy state derives
 * from set membership; each operation removes only its own key.
 */
export function useActiveOperations() {
  const [active, setActive] = useState<ReadonlySet<string>>(() => new Set());
  const begin = useCallback((operation: string) => {
    setActive((previous) => {
      if (previous.has(operation)) return previous;
      return new Set(previous).add(operation);
    });
  }, []);
  const end = useCallback((operation: string) => {
    setActive((previous) => {
      if (!previous.has(operation)) return previous;
      const next = new Set(previous);
      next.delete(operation);
      return next;
    });
  }, []);
  const isActive = useCallback((operation: string) => active.has(operation), [active]);
  return { active, busy: active.size > 0, begin, end, isActive };
}

export interface TransfersRuntime {
  native: boolean;
  limitation?: string;
  notice: DriveNotice | null;
  dismissNotice(): void;
  busy: boolean;
  /** True while the given scan/prepare/import operation is in flight. */
  isOperationActive(operation: string): boolean;
  /** The last thing that happened, for the page's own status line. */
  status: string;
  addFolder(): Promise<void>;
  removeLocation(locationId: DirectorId): void;
  setWatching(locationId: DirectorId, watching: boolean): void;
  scanLocation(locationId: DirectorId): Promise<ImportSummary | null>;
  prepareTo(locationId: DirectorId, selection: AssignmentSelection): Promise<PrepareReport | null>;
  initializeLocation(locationId: DirectorId): Promise<void>;
  importFiles(files: readonly File[], label?: string): Promise<ImportSummary>;
  importDataTransfer(data: DataTransfer | null): Promise<ImportSummary | null>;
  /** Write the selection to the browser's download folder, one file at a time. */
  downloadAssignments(selection: AssignmentSelection): number;
  /** Advisory line about a cloud-synced folder, when one applies. */
  cloudAdviceFor(location: TransferLocation): string | undefined;
}

const emptySummary: ImportSummary = {
  imported: 0,
  duplicates: 0,
  needsReview: 0,
  assignments: 0,
  invalid: 0,
  skipped: 0,
  classifications: [],
  messages: [],
};

/** "4 results staged, 1 duplicate" — the one line a director reads after a scan. */
export function describeSummary(summary: ImportSummary): string {
  const parts: string[] = [];
  if (summary.imported) parts.push(`${summary.imported} ready`);
  if (summary.needsReview) parts.push(`${summary.needsReview} to review`);
  if (summary.duplicates) parts.push(`${summary.duplicates} duplicate${summary.duplicates === 1 ? '' : 's'}`);
  if (summary.assignments)
    parts.push(`${summary.assignments} assignment${summary.assignments === 1 ? '' : 's'} skipped`);
  if (summary.invalid) parts.push(`${summary.invalid} unreadable`);
  if (summary.skipped) parts.push(`${summary.skipped} already seen`);
  return parts.length ? parts.join(' · ') : 'No new files.';
}

export function useTransfers(
  state: DirectorState,
  controller: DirectorController,
  onAnnounce: (announcement: AnnounceInput) => void,
  enabled = true,
): TransfersRuntime {
  const platform = useMemo(() => createTransferPlatform(), []);
  const [notice, setNotice] = useState<DriveNotice | null>(null);
  const operations = useActiveOperations();
  const { begin: beginOperation, end: endOperation } = operations;
  const busy = operations.busy;
  const [status, setStatus] = useState('');
  const controllerRef = useRef(controller);
  const stateRef = useRef(state);
  const preparingRef = useRef(new Set<string>());
  const scope = `${state.tournament?.id ?? ''}:${controller.documentEpoch ?? 0}`;
  const scanningRef = useRef(new Set<string>());
  const announcedRef = useRef(new Set<string>());

  // The timers and callbacks below outlive any one render and must act on the current controller
  // and the current tournament, not on whichever ones existed when they were created. This effect
  // is declared first so it commits before the effects that start those timers.
  //
  // A layout effect rather than a passive one, and the difference is the whole point. Passive
  // effects are flushed in a scheduler task *after* the commit that put the drive's button on
  // screen, so on a busy machine there is a real window in which that button is visible and
  // clickable while this mirror still describes the render before it. A director who clicks inside
  // that window reaches `prepareTo`, which looks the drive up in `stateRef.current`, does not find
  // it, and returns null: no files, no error, no announcement, and nothing to retry. Every callback
  // below has the same shape, so the window costs a scan or a watch toggle just as silently.
  //
  // A layout effect still only runs for a commit — a render that is thrown away never writes here,
  // which a render-phase assignment could not promise — but it runs inside that commit, so the
  // mirror can never be behind the DOM through which these callbacks are reached.
  useLayoutEffect(() => {
    controllerRef.current = controller;
    stateRef.current = state;
  });

  const buildLabel = `QBSheet Director ${state.schemaVersion}`;

  // Re-grant the operating-system permission for every location the director configured earlier.
  // The list persists in the tournament document; the grant is per-run and deliberately is not
  // persisted, so a location the director has not opened this session can be re-authorized here
  // without the application ever holding a standing grant to anything wider.
  useEffect(() => {
    if (!platform.native || !enabled) return;
    let active = true;
    void (async () => {
      for (const location of stateRef.current.transfers.locations) {
        if (!active) return;
        const outcome = await authorizeTransferRoot(location.path);
        if (active && !outcome.ok && location.kind === 'folder')
          controllerRef.current.noteTransferScan(location.id, {
            at: new Date().toISOString(),
            message: outcome.message,
          });
      }
    })();
    return () => {
      active = false;
    };
    // Deliberately once per mount: this is startup re-adoption, not a reaction to location edits.
  }, [platform.native, enabled, scope]);

  // Volume enumeration on a slow timer. `syncTransferVolumes` writes nothing when nothing moved, so
  // a quiet tournament day costs one enumeration every few seconds and no state churn at all.
  useEffect(() => {
    const source = platform.volumes;
    if (!source || !enabled) return;
    let active = true;
    const poll = async () => {
      try {
        const volumes = await source.listVolumes();
        if (active) controllerRef.current.syncTransferVolumes(volumes);
      } catch {
        // A failed enumeration is a transient platform condition, not something to interrupt a
        // director over. The next tick tries again.
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), volumePollIntervalMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [platform.volumes, enabled, scope]);

  const runScan = useCallback(
    async (
      location: TransferLocation,
      options: { announce?: boolean } = {},
    ): Promise<ImportSummary | null> => {
      const fileSystem = platform.fileSystem;
      if (!fileSystem || !location.connected || controllerRef.current.recovering) return null;
      const tournamentId = stateRef.current.tournament?.id;
      const epoch = controllerRef.current.documentEpoch;
      if (scanningRef.current.has(location.id)) return null;
      scanningRef.current.add(location.id);
      try {
        const { report, inputs } = await collectFromLocation(fileSystem, location.path, {
          sourceKind: location.kind === 'removable-drive' ? 'removable-drive' : 'folder',
          sourceLabel: location.label,
          includeRoot: location.kind === 'removable-drive',
          includeAssignments: true,
        });
        if (
          controllerRef.current.recovering ||
          stateRef.current.tournament?.id !== tournamentId ||
          controllerRef.current.documentEpoch !== epoch
        )
          return null;
        controllerRef.current.noteTransferScan(location.id, {
          at: new Date().toISOString(),
          ...(report.error ? { message: report.error } : {}),
          found: report.candidates.length,
        });
        if (report.error) return null;
        if (inputs.length === 0) return emptySummary;
        const summary = controllerRef.current.importTransferDocuments(inputs);
        if (options.announce && summary.imported + summary.needsReview + summary.duplicates > 0)
          onAnnounce(`${location.label}: ${describeSummary(summary)}`);
        return summary;
      } finally {
        scanningRef.current.delete(location.id);
      }
    },
    [onAnnounce, platform.fileSystem],
  );

  // Watched locations, on their own slower timer. Only locations the director marked as watched are
  // read; a connected drive that nobody asked to watch is left alone.
  useEffect(() => {
    if (!platform.fileSystem || !enabled) return;
    let active = true;
    const tick = async () => {
      const watched = stateRef.current.transfers.locations.filter(
        (location) => location.watching && location.connected,
      );
      for (const location of watched) {
        if (!active) return;
        await runScan(location, { announce: true });
      }
    };
    const interval = window.setInterval(() => void tick(), folderPollIntervalMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [platform.fileSystem, runScan, enabled, scope]);

  // A drive that appears and has QBSheet data on it earns one quiet line. A drive that does not is
  // somebody's photo stick and earns nothing.
  useEffect(() => {
    const fileSystem = platform.fileSystem;
    if (!fileSystem || !enabled) return;
    let active = true;
    void (async () => {
      for (const location of state.transfers.locations) {
        if (!active) return;
        if (location.kind !== 'removable-drive' || !location.connected) continue;
        if (announcedRef.current.has(location.id)) continue;
        const look = await looksLikeTransferVolume(fileSystem, location.path);
        if (!active) return;
        announcedRef.current.add(location.id);
        if (!look.recognized) continue;
        setNotice({
          locationId: location.id,
          label: location.label,
          resultCount: look.resultCount,
          assignmentCount: look.assignmentCount,
        });
        await runScan(location);
      }
      for (const id of [...announcedRef.current]) {
        const location = state.transfers.locations.find((entry) => entry.id === id);
        if (!location || !location.connected) announcedRef.current.delete(id);
      }
    })();
    return () => {
      active = false;
    };
  }, [platform.fileSystem, runScan, state.transfers.locations, enabled, scope]);

  const addFolder = useCallback(async () => {
    if (!platform.native) {
      onAnnounce('Choosing a folder needs the Director desktop app. Drag files onto this page instead.');
      return;
    }
    try {
      const chosen = await chooseTransferFolder();
      if (!chosen) return;
      const added = controllerRef.current.addTransferLocation({
        kind: 'folder',
        label: chosen.name,
        path: chosen.path,
        watching: true,
      });
      onAnnounce(
        added
          ? `${chosen.name} added and being watched.`
          : errorNotice('The folder could not be added; review the Director error.'),
      );
    } catch (reason: unknown) {
      onAnnounce(errorNotice(reason instanceof Error ? reason.message : 'That folder could not be added.'));
    }
  }, [onAnnounce, platform.native]);

  const removeLocation = useCallback((locationId: DirectorId) => {
    const location = stateRef.current.transfers.locations.find((entry) => entry.id === locationId);
    controllerRef.current.removeTransferLocation(locationId);
    if (location) void forgetTransferRoot(location.path);
  }, []);

  const setWatching = useCallback((locationId: DirectorId, watching: boolean) => {
    controllerRef.current.setTransferWatching(locationId, watching);
  }, []);

  const scanLocation = useCallback(
    async (locationId: DirectorId) => {
      const location = stateRef.current.transfers.locations.find((entry) => entry.id === locationId);
      if (!location) return null;
      const operation = scanOperation(locationId);
      beginOperation(operation);
      try {
        const summary = await runScan(location);
        if (summary) {
          setStatus(`${location.label}: ${describeSummary(summary)}`);
          onAnnounce(`${location.label}: ${describeSummary(summary)}`);
        }
        return summary;
      } finally {
        endOperation(operation);
      }
    },
    [beginOperation, endOperation, onAnnounce, runScan],
  );

  const prepareTo = useCallback(
    async (locationId: DirectorId, selection: AssignmentSelection) => {
      const fileSystem = platform.fileSystem;
      const location = stateRef.current.transfers.locations.find((entry) => entry.id === locationId);
      if (!fileSystem || !location || controllerRef.current.recovering) return null;
      if (!location.connected) {
        onAnnounce(errorNotice(`${location.label} is no longer connected. Nothing was written.`));
        return null;
      }
      if (preparingRef.current.has(locationId)) return null;
      if (location.readOnly) {
        onAnnounce(errorNotice(`${location.label} is read-only. Nothing was written.`));
        return null;
      }
      const operation = prepareOperation(locationId);
      preparingRef.current.add(locationId);
      const tournamentId = stateRef.current.tournament?.id;
      const epoch = controllerRef.current.documentEpoch;
      beginOperation(operation);
      try {
        const report = await prepareAssignments(stateRef.current, fileSystem, {
          basePath: location.path,
          destinationLabel: location.label,
          selection,
          directorBuild: buildLabel,
          groupByRound: selection.kind === 'released',
        });
        if (
          controllerRef.current.recovering ||
          stateRef.current.tournament?.id !== tournamentId ||
          controllerRef.current.documentEpoch !== epoch
        )
          return null;
        controllerRef.current.recordPreparedAssignments({
          report,
          transportKind: location.kind === 'removable-drive' ? 'removable-drive' : 'folder',
          destinationLabel: location.label,
          locationId: location.id,
        });
        const round =
          selection.kind === 'round'
            ? stateRef.current.rounds.find((entry) => entry.id === selection.roundId)
            : undefined;
        const message =
          round && report.ok && report.failures.length === 0
            ? `${round.name} copied to ${location.label} — eject normally.`
            : report.message;
        setStatus(message);
        onAnnounce(report.ok && report.failures.length === 0 ? message : errorNotice(message));
        return report;
      } catch (reason: unknown) {
        const message = reason instanceof Error ? reason.message : 'The files could not be written.';
        onAnnounce(errorNotice(message));
        return null;
      } finally {
        preparingRef.current.delete(locationId);
        endOperation(operation);
      }
    },
    [beginOperation, buildLabel, endOperation, onAnnounce, platform.fileSystem],
  );

  const initializeLocation = useCallback(
    async (locationId: DirectorId) => {
      const fileSystem = platform.fileSystem;
      const location = stateRef.current.transfers.locations.find((entry) => entry.id === locationId);
      if (!fileSystem || !location) return;
      const outcome = await initializeExchange(
        fileSystem,
        location.path,
        stateRef.current.tournament?.name ?? 'QBSheet tournament',
      );
      onAnnounce(outcome.ok ? `${location.label} is ready for exchange.` : (outcome.error ?? 'Failed.'));
      if (outcome.ok) controllerRef.current.setTransferWatching(location.id, true);
    },
    [onAnnounce, platform.fileSystem],
  );

  const importFiles = useCallback(
    async (files: readonly File[], label = 'Chosen files') => {
      if (files.length === 0) return emptySummary;
      beginOperation(importFilesOperation);
      try {
        const inputs = await readBrowserFiles(files, { sourceKind: 'file-picker', sourceLabel: label });
        const summary = controllerRef.current.importTransferDocuments(inputs);
        setStatus(describeSummary(summary));
        onAnnounce(describeSummary(summary));
        return summary;
      } finally {
        endOperation(importFilesOperation);
      }
    },
    [beginOperation, endOperation, onAnnounce],
  );

  const importDataTransfer = useCallback(
    async (data: DataTransfer | null) => {
      const files = filesFromDataTransfer(data);
      if (files.length === 0) {
        onAnnounce('Drop QBJ files. Other file types are not read.');
        return null;
      }
      beginOperation(importDropOperation);
      try {
        const inputs = await readBrowserFiles(files, {
          sourceKind: 'drop',
          sourceLabel: 'Dropped files',
        });
        const summary = controllerRef.current.importTransferDocuments(inputs);
        setStatus(describeSummary(summary));
        onAnnounce(describeSummary(summary));
        return summary;
      } finally {
        endOperation(importDropOperation);
      }
    },
    [beginOperation, endOperation, onAnnounce],
  );

  /**
   * The no-sync-client cloud workflow.
   *
   * Writes each assignment to the browser's own download folder so the director can upload them by
   * hand to Drive, OneDrive, Dropbox or anything else. No provider API, no account, no OAuth — and
   * it works identically in the desktop app and in the browser preview.
   */
  const downloadAssignments = useCallback(
    (selection: AssignmentSelection) => {
      const plan = planAssignments(stateRef.current, selection);
      plan.assignments.forEach((assignment) =>
        downloadTextFile(assignment.fileName, assignment.text, qbjMimeType),
      );
      const count = plan.assignments.length;
      controllerRef.current.recordPreparedAssignments({
        report: {
          ok: count > 0,
          written: plan.assignments.map((assignment) => ({
            assignment,
            path: assignment.fileName,
            fileName: assignment.fileName,
            digest: '',
            byteLength: new TextEncoder().encode(assignment.text).byteLength,
          })),
          failures: plan.failures,
          warnings: plan.warnings,
          rootPath: 'downloads',
          message: '',
        },
        transportKind: 'download',
        destinationLabel: 'Downloads',
      });
      onAnnounce(
        count > 0
          ? `${count} assignment file${count === 1 ? '' : 's'} downloaded. Upload them to your cloud folder, then return the completed files here.`
          : 'There was nothing to export.',
      );
      return count;
    },
    [onAnnounce],
  );

  const cloudAdviceFor = useCallback(
    (location: TransferLocation) =>
      location.cloudProvider ? cloudOfflineAdvice(location.cloudProvider) : undefined,
    [],
  );

  return {
    native: platform.native,
    ...(platform.limitation ? { limitation: platform.limitation } : {}),
    notice,
    dismissNotice: () => setNotice(null),
    busy,
    isOperationActive: operations.isActive,
    status,
    addFolder,
    removeLocation,
    setWatching,
    scanLocation,
    prepareTo,
    initializeLocation,
    importFiles,
    importDataTransfer,
    downloadAssignments,
    cloudAdviceFor,
  };
}

export { exchangePaths };
