/**
 * The async glue: read files from somewhere, turn them into ingestion inputs.
 *
 * Everything here is a plain async function over a `TransferFileSystem`, deliberately not a React
 * hook and deliberately not aware of Director state. That is what lets the same three functions
 * serve a USB scan, a watched folder, a drag-and-drop and a file picker — the four transports the
 * product promises never to make a director choose between — without four code paths.
 *
 * A batch is bounded and a failure is per-file. One malformed download in a folder of twelve costs
 * that one file and produces a sentence about it; it does not cost the other eleven.
 */
import { digestBytes } from './canonical';
import { scanTransferLocation, type ScanCandidate, type ScanReport } from './discover';
import type { IncomingDocument } from './ingest';
import { maxFilesPerBatch, maxScanFileBytes } from './limits';
import type { ArtifactSourceKind } from './model';
import { parseTransferBytes } from './parse';
import type { TransferFileSystem } from './ports';
import type { ImportInput } from './state';

export interface ReadOptions {
  sourceKind: ArtifactSourceKind;
  sourceLabel: string;
  limit?: number;
}

function toInput(
  options: ReadOptions,
  file: { fileName: string; originalPath?: string; bytes: Uint8Array },
): ImportInput {
  const digest = digestBytes(file.bytes);
  const parsed = parseTransferBytes(file.bytes);
  if (!parsed.ok)
    return {
      ok: false,
      sourceKind: options.sourceKind,
      sourceLabel: options.sourceLabel,
      fileName: file.fileName,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      byteLength: file.bytes.byteLength,
      digest,
      reason: parsed.reason,
    };
  return {
    ok: true,
    document: {
      sourceKind: options.sourceKind,
      sourceLabel: options.sourceLabel,
      fileName: file.fileName,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      byteLength: file.bytes.byteLength,
      digest,
      qbj: parsed.value,
    } satisfies IncomingDocument,
  };
}

/**
 * Read a set of files a scan found.
 *
 * A file that has gone by the time it is read — the drive was pulled, the sync client moved it — is
 * reported as a refusal rather than throwing, because that is a normal event on removable media and
 * the other files in the batch are still worth having.
 */
export async function readScanCandidates(
  fileSystem: TransferFileSystem,
  candidates: readonly ScanCandidate[],
  options: ReadOptions,
): Promise<ImportInput[]> {
  const bounded = candidates.slice(0, options.limit ?? maxFilesPerBatch);
  const inputs: ImportInput[] = [];
  for (const candidate of bounded) {
    try {
      const file = await fileSystem.readFile(candidate.path, maxScanFileBytes);
      inputs.push(
        toInput(options, {
          fileName: candidate.fileName,
          originalPath: candidate.path,
          bytes: file.bytes,
        }),
      );
    } catch (reason: unknown) {
      inputs.push({
        ok: false,
        sourceKind: options.sourceKind,
        sourceLabel: options.sourceLabel,
        fileName: candidate.fileName,
        originalPath: candidate.path,
        byteLength: candidate.byteLength,
        digest: `unread-${candidate.path}`,
        reason: reason instanceof Error ? reason.message : 'That file could not be read.',
      });
    }
  }
  return inputs;
}

/** Scan a location and read everything it found, in one call. */
export async function collectFromLocation(
  fileSystem: TransferFileSystem,
  basePath: string,
  options: ReadOptions & { includeRoot?: boolean; includeAssignments?: boolean },
): Promise<{ report: ScanReport; inputs: ImportInput[] }> {
  const report = await scanTransferLocation(fileSystem, basePath, {
    ...(options.includeRoot ? { includeRoot: true } : {}),
    ...(options.includeAssignments ? { includeAssignments: true } : {}),
    limit: options.limit ?? maxFilesPerBatch,
  });
  if (report.error) return { report, inputs: [] };
  const inputs = await readScanCandidates(fileSystem, report.candidates, options);
  return { report, inputs };
}

/**
 * Read a `File`'s bytes, on every runtime that can produce one.
 *
 * `Blob.arrayBuffer` is the direct route and is what current browsers use. The `FileReader`
 * fallback is there for the ones that do not have it — older WebViews, and the jsdom the tests run
 * in — because a director on a school Chromebook that is three years behind should get "your file
 * was imported", not "file.arrayBuffer is not a function".
 */
async function fileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  if (typeof FileReader === 'undefined') throw new Error('This browser cannot read local files.');
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(new Uint8Array(reader.result))
        : reject(new Error('That file could not be read.'));
    reader.onerror = () => reject(reader.error ?? new Error('That file could not be read.'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Read browser `File` objects — dropped on the window or chosen in a picker.
 *
 * The browser gives no readable path, so `originalPath` is absent and duplicate suppression falls
 * back to the digest alone. That is the right trade: a director who drops the same download twice
 * should be told it is a duplicate, and they will be, by the fingerprint check on the way through
 * ingestion rather than by the seen-file check.
 */
export async function readBrowserFiles(files: readonly File[], options: ReadOptions): Promise<ImportInput[]> {
  const bounded = files.slice(0, options.limit ?? maxFilesPerBatch);
  const inputs: ImportInput[] = [];
  for (const file of bounded) {
    if (file.size > maxScanFileBytes) {
      inputs.push({
        ok: false,
        sourceKind: options.sourceKind,
        sourceLabel: options.sourceLabel,
        fileName: file.name,
        byteLength: file.size,
        digest: `oversize-${file.name}-${file.size}`,
        reason: 'That file is too large to read as QBJ.',
      });
      continue;
    }
    try {
      inputs.push(toInput(options, { fileName: file.name, bytes: await fileBytes(file) }));
    } catch (reason: unknown) {
      inputs.push({
        ok: false,
        sourceKind: options.sourceKind,
        sourceLabel: options.sourceLabel,
        fileName: file.name,
        byteLength: file.size,
        digest: `unread-${file.name}-${file.size}`,
        reason: reason instanceof Error ? reason.message : 'That file could not be read.',
      });
    }
  }
  return inputs;
}

/** Files from a drop event, filtered to what Transfers will look at. */
export function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = data.files ? Array.from(data.files) : [];
  return files.filter((file) => /\.(qbj|json)$/i.test(file.name));
}
