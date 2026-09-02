import { unzipSync, zipSync, strFromU8 } from 'fflate';
import type {
  DirectorTournament,
  DirectorTournamentInput,
  FormatError,
  FormatReport,
  FormatWarning,
  JsonObject,
  JsonValue,
} from './types';
import { normalizeTournamentData } from './tournament';
import {
  asFiniteNumber,
  asJsonObject,
  asString,
  cloneJson,
  error,
  fail,
  isJsonValue,
  jsonText,
  ok,
  safeRelativePath,
  textBytes,
  warning,
} from './util';

/**
 * Portable Director archives are ZIP containers with an explicit JSON manifest. `.qbsheet` and
 * `.qbs` are already used by unrelated software, so `.qbst` is the intentionally product-specific
 * filename extension for a QBSheet Tournament archive. The extension is only a hint; the manifest
 * and ZIP signature remain authoritative.
 */
export const directorArchiveFormat = 'qbsheet-director-archive' as const;
export const directorArchiveVersion = 1;
export const directorArchiveSchema = '1.0';
export const directorArchiveExtension = '.qbst';
export const directorArchiveMimeType = 'application/vnd.qbsheet.director+zip';
export const directorArchiveManifestPath = 'manifest.json';
export const directorArchiveDataPath = 'data/tournament.json';
export const maxDirectorArchiveBytes = 128 * 1024 * 1024;
export const maxDirectorArchiveEntryBytes = 64 * 1024 * 1024;
/** The sum of ZIP entry sizes permitted before extraction begins. */
export const maxDirectorArchiveTotalUncompressedBytes = 128 * 1024 * 1024;
/** Keep central-directory processing bounded even when entries are tiny. */
export const maxDirectorArchiveEntryCount = 4096;

export interface DirectorArchiveAsset {
  /** Must be a relative path below `assets/`. */
  path: string;
  data: Uint8Array;
  mediaType?: string;
  description?: string;
}

export interface DirectorArchiveFileEntry {
  path: string;
  kind: 'data' | 'asset';
  required: boolean;
  mediaType: string;
  bytes: number;
  description?: string;
}

export interface DirectorArchiveManifest {
  format: typeof directorArchiveFormat;
  version: number;
  schema: typeof directorArchiveSchema;
  createdAt: string;
  generator?: { name: string; version?: string };
  tournament: { id: string; name: string };
  files: DirectorArchiveFileEntry[];
  extensions?: JsonObject;
}

export interface DirectorArchiveExportOptions {
  createdAt?: string;
  generator?: { name: string; version?: string };
  assets?: DirectorArchiveAsset[];
  manifestExtensions?: JsonObject;
}

export interface DirectorArchiveExportValue {
  bytes: Uint8Array;
  manifest: DirectorArchiveManifest;
  tournament: DirectorTournament;
}

export interface DirectorArchiveImportValue {
  tournament: DirectorTournament;
  manifest: DirectorArchiveManifest;
  assets: DirectorArchiveAsset[];
  /** Unexpected files are returned, not dropped, so a future importer can recover them. */
  extraFiles: Record<string, Uint8Array>;
}

const manifestKeys = new Set([
  'format',
  'version',
  'schema',
  'createdAt',
  'generator',
  'tournament',
  'files',
  'extensions',
]);

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function validateAssetPath(path: string, index: number, errors: FormatError[]): void {
  if (!safeRelativePath(path) || !path.startsWith('assets/')) {
    errors.push(
      error(
        'invalid-asset-path',
        `assets[${index}].path`,
        'Archive assets must use a safe assets/ relative path.',
      ),
    );
  }
  if (path === directorArchiveManifestPath || path === directorArchiveDataPath) {
    errors.push(
      error('reserved-archive-path', `assets[${index}].path`, `${path} is reserved by the archive format.`),
    );
  }
}

function validateManifest(
  value: unknown,
  warnings: FormatWarning[],
  errors: FormatError[],
): DirectorArchiveManifest | null {
  const manifest = asJsonObject(value);
  if (!manifest) {
    errors.push(
      error('invalid-manifest', directorArchiveManifestPath, 'manifest.json must contain a JSON object.'),
    );
    return null;
  }
  const format = asString(manifest.format);
  if (format !== directorArchiveFormat)
    errors.push(error('invalid-format', 'manifest.format', `Expected ${directorArchiveFormat}.`));
  const version = asFiniteNumber(manifest.version);
  if (!Number.isInteger(version) || version === undefined) {
    errors.push(error('invalid-version', 'manifest.version', 'Archive version must be an integer.'));
  } else if (version !== directorArchiveVersion) {
    errors.push(
      error(
        version > directorArchiveVersion ? 'unsupported-future-version' : 'unsupported-version',
        'manifest.version',
        `This archive uses version ${version}; this build reads version ${directorArchiveVersion}.`,
      ),
    );
  }
  const schema = asString(manifest.schema);
  if (schema !== directorArchiveSchema)
    errors.push(error('unsupported-schema', 'manifest.schema', `Expected schema ${directorArchiveSchema}.`));
  const createdAt = asString(manifest.createdAt);
  if (!createdAt)
    errors.push(error('missing-field', 'manifest.createdAt', 'createdAt must be a non-empty string.'));
  const tournament = asJsonObject(manifest.tournament);
  const tournamentId = tournament ? asString(tournament.id) : undefined;
  const tournamentName = tournament ? asString(tournament.name) : undefined;
  if (!tournamentId)
    errors.push(
      error('missing-field', 'manifest.tournament.id', 'The manifest must identify the tournament.'),
    );
  if (!tournamentName)
    errors.push(error('missing-field', 'manifest.tournament.name', 'The manifest must name the tournament.'));
  if (!Array.isArray(manifest.files)) {
    errors.push(error('invalid-files', 'manifest.files', 'The manifest must list archive files.'));
  }
  const files: DirectorArchiveFileEntry[] = [];
  if (Array.isArray(manifest.files)) {
    const paths = new Set<string>();
    manifest.files.forEach((entry, index) => {
      const file = asJsonObject(entry);
      if (!file) {
        errors.push(
          error('invalid-file-entry', `manifest.files[${index}]`, 'A file entry must be a JSON object.'),
        );
        return;
      }
      const path = asString(file.path);
      const kind = file.kind === 'data' || file.kind === 'asset' ? file.kind : undefined;
      const required = typeof file.required === 'boolean' ? file.required : undefined;
      const mediaType = asString(file.mediaType);
      const bytes = asFiniteNumber(file.bytes);
      if (!path || !safeRelativePath(path))
        errors.push(
          error(
            'invalid-file-path',
            `manifest.files[${index}].path`,
            'File paths must be safe relative paths.',
          ),
        );
      if (path === directorArchiveManifestPath) {
        errors.push(
          error(
            'reserved-archive-path',
            `manifest.files[${index}].path`,
            `${path} is reserved for the archive manifest and cannot be declared as a data or asset file.`,
          ),
        );
      }
      if (path === directorArchiveDataPath && kind !== 'data') {
        errors.push(
          error(
            'reserved-archive-path',
            `manifest.files[${index}].path`,
            `${path} is reserved for the structured tournament data entry.`,
          ),
        );
      }
      if (kind === 'asset' && path && !path.startsWith('assets/'))
        errors.push(
          error(
            'invalid-file-path',
            `manifest.files[${index}].path`,
            'Asset entries must use an assets/ relative path.',
          ),
        );
      if (kind === 'data' && path && path !== directorArchiveDataPath)
        errors.push(
          error(
            'invalid-file-path',
            `manifest.files[${index}].path`,
            `Data entries must use ${directorArchiveDataPath}.`,
          ),
        );
      if (!kind)
        errors.push(
          error('invalid-file-kind', `manifest.files[${index}].kind`, 'File kind must be data or asset.'),
        );
      if (required === undefined)
        errors.push(
          error(
            'invalid-file-required',
            `manifest.files[${index}].required`,
            'File required must be boolean.',
          ),
        );
      if (!mediaType)
        errors.push(
          error(
            'invalid-file-media-type',
            `manifest.files[${index}].mediaType`,
            'File mediaType must be a non-empty string.',
          ),
        );
      if (bytes === undefined || !Number.isInteger(bytes) || bytes < 0)
        errors.push(
          error(
            'invalid-file-size',
            `manifest.files[${index}].bytes`,
            'File bytes must be a non-negative integer.',
          ),
        );
      if (path && paths.has(path))
        errors.push(
          error(
            'duplicate-file',
            `manifest.files[${index}].path`,
            `The manifest lists ${path} more than once.`,
          ),
        );
      if (path) paths.add(path);
      if (path && kind && required !== undefined && mediaType && bytes !== undefined) {
        files.push({
          path,
          kind,
          required,
          mediaType,
          bytes,
          ...(asString(file.description) ? { description: asString(file.description) } : {}),
        });
      }
    });
  }
  const manifestExtensions = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !manifestKeys.has(key)),
  ) as JsonObject;
  if (Object.keys(manifestExtensions).length > 0) {
    for (const [key, extension] of Object.entries(manifestExtensions)) {
      warnings.push(
        warning(
          'unsupported-field-preserved',
          `manifest.${key}`,
          `The manifest field ${key} is not interpreted and was preserved.`,
          extension,
        ),
      );
    }
  }
  if (asJsonObject(manifest.extensions)) {
    Object.assign(manifestExtensions, asJsonObject(manifest.extensions));
  }
  if (errors.length > 0 || !createdAt || !tournamentId || !tournamentName) return null;
  return {
    format: directorArchiveFormat,
    version: version as number,
    schema: directorArchiveSchema,
    createdAt,
    ...(asJsonObject(manifest.generator)
      ? { generator: cloneJson(manifest.generator) as DirectorArchiveManifest['generator'] }
      : {}),
    tournament: { id: tournamentId, name: tournamentName },
    files,
    ...(Object.keys(manifestExtensions).length > 0 ? { extensions: manifestExtensions } : {}),
  };
}

function ensureArchiveLimit(bytes: Uint8Array, errors: FormatError[]): void {
  if (bytes.byteLength > maxDirectorArchiveBytes) {
    errors.push(
      error('archive-too-large', '', `The archive exceeds the ${maxDirectorArchiveBytes}-byte safety limit.`),
    );
  }
}

class ArchiveSafetyError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveSafetyError';
  }
}

/**
 * Ask fflate to inspect each central-directory entry before it allocates an output buffer.
 *
 * `unzipSync` supports a metadata filter, so the filter is deliberately the only place where an
 * entry is admitted to extraction. The checks below are duplicated after extraction as a defense in
 * depth against malformed archives, but the central-directory values are what prevent a small,
 * highly-compressible entry from reaching the inflater in the first place.
 */
function extractArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  const paths = new Set<string>();
  let entryCount = 0;
  let totalUncompressedBytes = 0;
  // First walk only the central directory. Returning false from the filter means fflate does not
  // slice or inflate any entry, so aggregate limits are known before the second pass can allocate an
  // output buffer for even the first entry.
  unzipSync(bytes, {
    filter: (entry) => {
      entryCount += 1;
      if (entryCount > maxDirectorArchiveEntryCount) {
        throw new ArchiveSafetyError(
          'archive-too-many-entries',
          '',
          `The archive contains more than the ${maxDirectorArchiveEntryCount}-entry safety limit.`,
        );
      }
      if (!safeRelativePath(entry.name)) {
        throw new ArchiveSafetyError(
          'unsafe-entry-path',
          entry.name,
          'The archive contains an unsafe file path.',
        );
      }
      if (paths.has(entry.name)) {
        throw new ArchiveSafetyError(
          'duplicate-entry',
          entry.name,
          `The archive contains the file ${entry.name} more than once.`,
        );
      }
      paths.add(entry.name);
      if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
        throw new ArchiveSafetyError(
          'invalid-entry-size',
          entry.name,
          'The archive entry declares an invalid uncompressed size.',
        );
      }
      if (entry.originalSize > maxDirectorArchiveEntryBytes) {
        throw new ArchiveSafetyError(
          'entry-too-large',
          entry.name,
          `The archive entry exceeds the ${maxDirectorArchiveEntryBytes}-byte safety limit.`,
        );
      }
      if (entry.originalSize > maxDirectorArchiveTotalUncompressedBytes - totalUncompressedBytes) {
        throw new ArchiveSafetyError(
          'archive-uncompressed-too-large',
          entry.name,
          `The archive entries exceed the ${maxDirectorArchiveTotalUncompressedBytes}-byte uncompressed safety limit.`,
        );
      }
      totalUncompressedBytes += entry.originalSize;
      return false;
    },
  });

  // The metadata pass has admitted every entry, so this pass is bounded by the limits above. Keep a
  // filter here as well because fflate invokes it immediately before each individual allocation.
  return unzipSync(bytes, {
    filter: () => true,
  }) as Record<string, Uint8Array>;
}

function checkEntryLimit(
  entries: Record<string, Uint8Array>,
  warnings: FormatWarning[],
  errors: FormatError[],
): void {
  let totalUncompressedBytes = 0;
  let entryCount = 0;
  for (const [path, bytes] of Object.entries(entries)) {
    entryCount += 1;
    if (!safeRelativePath(path))
      errors.push(error('unsafe-entry-path', path, 'The archive contains an unsafe file path.'));
    if (bytes.byteLength > maxDirectorArchiveEntryBytes)
      errors.push(
        error(
          'entry-too-large',
          path,
          `The archive entry exceeds the ${maxDirectorArchiveEntryBytes}-byte safety limit.`,
        ),
      );
    totalUncompressedBytes += bytes.byteLength;
    if (
      path !== directorArchiveManifestPath &&
      path !== directorArchiveDataPath &&
      !path.startsWith('assets/')
    ) {
      warnings.push(
        warning(
          'unsupported-file-preserved',
          path,
          'This archive entry is not part of the v1 data/assets layout and was preserved.',
        ),
      );
    }
  }
  if (entryCount > maxDirectorArchiveEntryCount)
    errors.push(
      error(
        'archive-too-many-entries',
        '',
        `The archive contains more than the ${maxDirectorArchiveEntryCount}-entry safety limit.`,
      ),
    );
  if (totalUncompressedBytes > maxDirectorArchiveTotalUncompressedBytes)
    errors.push(
      error(
        'archive-uncompressed-too-large',
        '',
        `The archive entries exceed the ${maxDirectorArchiveTotalUncompressedBytes}-byte uncompressed safety limit.`,
      ),
    );
}

function requiredEntry(
  entries: Record<string, Uint8Array>,
  path: string,
  errors: FormatError[],
): Uint8Array | null {
  const entry = entries[path];
  if (!entry) {
    errors.push(error('missing-entry', path, `The archive is missing required entry ${path}.`));
    return null;
  }
  return entry;
}

/** Build a versioned ZIP archive; the structured JSON is the interchange contract, not SQLite. */
export function exportDirectorArchiveReport(
  input: DirectorTournamentInput | DirectorTournament,
  options: DirectorArchiveExportOptions = {},
): FormatReport<DirectorArchiveExportValue> {
  const normalized = normalizeTournamentData(input);
  if (!normalized.ok) return normalized;
  const warnings = [...normalized.warnings];
  const errors: FormatError[] = [];
  const assets = options.assets ?? [];
  const paths = new Set<string>([directorArchiveManifestPath, directorArchiveDataPath]);
  assets.forEach((asset, index) => {
    validateAssetPath(asset.path, index, errors);
    if (paths.has(asset.path))
      errors.push(
        error('duplicate-file', `assets[${index}].path`, `The archive already contains ${asset.path}.`),
      );
    paths.add(asset.path);
    if (asset.data.byteLength > maxDirectorArchiveEntryBytes)
      errors.push(
        error(
          'entry-too-large',
          `assets[${index}].path`,
          `The asset exceeds the ${maxDirectorArchiveEntryBytes}-byte safety limit.`,
        ),
      );
    if (asset.path.includes('\u0000'))
      errors.push(
        error('invalid-asset-path', `assets[${index}].path`, 'Asset paths cannot contain NUL bytes.'),
      );
  });
  if (errors.length > 0) return fail(errors, warnings);

  const dataText = jsonText(normalized.value as unknown as JsonValue);
  const dataBytes = textBytes(dataText);
  const manifest: DirectorArchiveManifest = {
    format: directorArchiveFormat,
    version: directorArchiveVersion,
    schema: directorArchiveSchema,
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.generator ? { generator: { ...options.generator } } : {}),
    tournament: { id: normalized.value.tournament.id, name: normalized.value.tournament.name },
    files: [
      {
        path: directorArchiveDataPath,
        kind: 'data',
        required: true,
        mediaType: 'application/json',
        bytes: dataBytes.byteLength,
        description: 'Structured Director tournament data.',
      },
      ...assets.map((asset) => ({
        path: asset.path,
        kind: 'asset' as const,
        required: false,
        mediaType: asset.mediaType ?? 'application/octet-stream',
        bytes: asset.data.byteLength,
        ...(asset.description ? { description: asset.description } : {}),
      })),
    ],
    ...(options.manifestExtensions ? { extensions: cloneJson(options.manifestExtensions) } : {}),
  };
  const manifestBytes = textBytes(jsonText(manifest as unknown as JsonValue));
  const entries: Record<string, Uint8Array> = {
    [directorArchiveManifestPath]: manifestBytes,
    [directorArchiveDataPath]: dataBytes,
  };
  for (const asset of assets) entries[asset.path] = new Uint8Array(asset.data);
  const bytes = zipSync(entries, { level: 6 });
  return ok({ bytes, manifest, tournament: normalized.value }, warnings);
}

export function exportDirectorArchive(
  input: DirectorTournamentInput | DirectorTournament,
  options: DirectorArchiveExportOptions = {},
): Uint8Array {
  const report = exportDirectorArchiveReport(input, options);
  if (!report.ok) throw new Error(report.errors.map((entry) => entry.message).join(' '));
  return report.value.bytes;
}

/** Read and validate an archive, retaining unknown files and fields for forward compatibility. */
export function importDirectorArchive(
  input: Uint8Array | ArrayBuffer,
): FormatReport<DirectorArchiveImportValue> {
  const warnings: FormatWarning[] = [];
  const errors: FormatError[] = [];
  const bytes = asBytes(input);
  ensureArchiveLimit(bytes, errors);
  if (errors.length > 0) return fail(errors, warnings);
  let entries: Record<string, Uint8Array>;
  try {
    // The filter in extractArchive runs from ZIP metadata before fflate inflates any admitted entry.
    entries = extractArchive(bytes);
  } catch (caught) {
    if (caught instanceof ArchiveSafetyError)
      return fail([error(caught.code, caught.path, caught.message)], warnings);
    return fail([error('invalid-zip', '', 'The input is not a readable ZIP archive.')], warnings);
  }
  checkEntryLimit(entries, warnings, errors);
  const manifestEntry = requiredEntry(entries, directorArchiveManifestPath, errors);
  const dataEntry = requiredEntry(entries, directorArchiveDataPath, errors);
  if (!manifestEntry || !dataEntry || errors.length > 0) return fail(errors, warnings);

  let manifestValue: unknown;
  let dataValue: unknown;
  try {
    manifestValue = JSON.parse(strFromU8(manifestEntry));
  } catch {
    errors.push(error('invalid-json', directorArchiveManifestPath, 'manifest.json is not valid UTF-8 JSON.'));
  }
  try {
    dataValue = JSON.parse(strFromU8(dataEntry));
  } catch {
    errors.push(
      error('invalid-json', directorArchiveDataPath, 'The tournament data entry is not valid UTF-8 JSON.'),
    );
  }
  const manifest = validateManifest(manifestValue, warnings, errors);
  if (!manifest || errors.length > 0) return fail(errors, warnings);
  if (!isJsonValue(dataValue)) {
    errors.push(
      error(
        'invalid-data',
        directorArchiveDataPath,
        'The tournament data contains unsafe or non-JSON values.',
      ),
    );
    return fail(errors, warnings);
  }

  const listed = new Map(manifest.files.map((entry) => [entry.path, entry]));
  if (!listed.has(directorArchiveDataPath))
    errors.push(
      error('manifest-missing-data', 'manifest.files', 'The manifest must list data/tournament.json.'),
    );
  for (const entry of manifest.files) {
    const actual = entries[entry.path];
    if (!actual) {
      if (entry.required)
        errors.push(error('missing-entry', entry.path, `The required entry ${entry.path} is missing.`));
      else
        warnings.push(
          warning('missing-optional-entry', entry.path, `Optional entry ${entry.path} is missing.`),
        );
      continue;
    }
    if (actual.byteLength !== entry.bytes)
      warnings.push(
        warning(
          'file-size-mismatch',
          entry.path,
          `The manifest says ${entry.bytes} bytes but the archive contains ${actual.byteLength}.`,
        ),
      );
  }
  if (errors.length > 0) return fail(errors, warnings);

  const normalized = normalizeTournamentData(dataValue as unknown as DirectorTournamentInput);
  if (!normalized.ok) return fail(normalized.errors, [...warnings, ...normalized.warnings]);
  warnings.push(...normalized.warnings);
  const assets: DirectorArchiveAsset[] = [];
  const extraFiles: Record<string, Uint8Array> = {};
  for (const [path, value] of Object.entries(entries)) {
    const listedEntry = listed.get(path);
    if (listedEntry?.kind === 'asset') {
      assets.push({
        path,
        data: new Uint8Array(value),
        mediaType: listedEntry.mediaType,
        ...(listedEntry.description ? { description: listedEntry.description } : {}),
      });
    } else if (!listedEntry && path !== directorArchiveManifestPath && path !== directorArchiveDataPath) {
      extraFiles[path] = new Uint8Array(value);
      warnings.push(
        warning(
          'unsupported-file-preserved',
          path,
          `The unrecognized archive entry ${path} was preserved for a future importer.`,
        ),
      );
    }
  }
  return ok({ tournament: normalized.value, manifest, assets, extraFiles }, warnings);
}

/** Alias with the explicit report suffix for callers that prefer to make warning handling obvious. */
export const importDirectorArchiveReport = importDirectorArchive;
export const serializeDirectorArchive = exportDirectorArchive;
