import type { FormatError, FormatReport, FormatWarning, JsonObject, JsonValue } from './types';

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  if (!isJsonObject(value)) return false;
  return Object.entries(value).every(([key, entry]) => isSafeJsonKey(key) && isJsonValue(entry, depth + 1));
}

export function isSafeJsonKey(key: string): boolean {
  return key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
}

/** Clone only JSON values so source objects cannot be mutated through an adapter result. */
export function cloneJson<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry)) as T;
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) result[key] = cloneJson(entry);
  return result as T;
}

export function asJsonObject(value: unknown): JsonObject | null {
  return isJsonObject(value) && isJsonValue(value) ? cloneJson(value) : null;
}

export function asString(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return allowEmpty || normalized !== '' ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asInteger(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function slugId(prefix: string, ...parts: string[]): string {
  const slug = parts
    .join('-')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${prefix}_${slug || 'unnamed'}`;
}

export function pathJoin(path: string, child: string): string {
  return path === '' ? child : `${path}.${child}`;
}

export function warning(code: string, path: string, message: string, value?: JsonValue): FormatWarning {
  return { code, path, message, ...(value === undefined ? {} : { value: cloneJson(value) }) };
}

export function error(code: string, path: string, message: string): FormatError {
  return { code, path, message };
}

export function ok<T>(value: T, warnings: FormatWarning[] = []): FormatReport<T> {
  return { ok: true, value, warnings };
}

export function fail<T>(errors: FormatError[], warnings: FormatWarning[] = []): FormatReport<T> {
  return { ok: false, errors, warnings };
}

/**
 * Pull unknown keys into an extension object and make the loss visible to the caller.
 *
 * The returned extension is JSON data, not a reference to the parsed input. This is important for
 * importers: editing a normalized team must not mutate the original QBJ object retained for audit.
 */
export function preserveUnknownFields(
  raw: JsonObject,
  known: ReadonlySet<string>,
  path: string,
  warnings: FormatWarning[],
): JsonObject | undefined {
  const extensions: JsonObject = {};
  for (const [key, value] of Object.entries(raw)) {
    if (known.has(key)) continue;
    extensions[key] = cloneJson(value);
    warnings.push(
      warning(
        'unsupported-field-preserved',
        pathJoin(path, key),
        `The ${key} field is not interpreted by this adapter; it was preserved in extensions.`,
        value,
      ),
    );
  }
  return Object.keys(extensions).length > 0 ? extensions : undefined;
}

export function mergeSourceAndExtensions(
  source: JsonObject | undefined,
  extensions: JsonObject | undefined,
): JsonObject {
  return {
    ...(source ? cloneJson(source) : {}),
    ...(extensions ? cloneJson(extensions) : {}),
  };
}

/** Parse JSON while rejecting prototype-pollution keys and non-JSON values. */
export function parseJsonInput(
  input: string | Uint8Array | JsonValue,
): { ok: true; value: JsonValue } | { ok: false; message: string } {
  let value: unknown = input;
  if (input instanceof Uint8Array) {
    try {
      value = JSON.parse(new TextDecoder().decode(input));
    } catch {
      return { ok: false, message: 'The input is not valid UTF-8 JSON.' };
    }
  } else if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, message: 'The input is not valid JSON.' };
    }
  }
  if (!isJsonValue(value)) return { ok: false, message: 'The input contains unsafe or non-JSON values.' };
  return { ok: true, value: cloneJson(value) };
}

/** Canonical JSON for stable fingerprints and deterministic tests. */
export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

export function safeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\u0000')) return false;
  const parts = path.split('/');
  return (
    !/^[A-Za-z]:/.test(parts[0] ?? '') &&
    parts.every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        part !== '__proto__' &&
        part !== 'prototype' &&
        part !== 'constructor',
    )
  );
}

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function jsonText(value: JsonValue, pretty = true): string {
  return `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
}

export function readRequiredString(
  raw: JsonObject,
  key: string,
  path: string,
  errors: FormatError[],
): string | undefined {
  const value = asString(raw[key]);
  if (value === undefined)
    errors.push(error('missing-field', pathJoin(path, key), `${key} must be a non-empty string.`));
  return value;
}
