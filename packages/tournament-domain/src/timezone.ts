/**
 * Tournament timezone.
 *
 * A tournament happens in a place, and that place keeps its own time whether or not the Director's
 * laptop agrees. QBSheet Live publishes scheduled times to people standing in the building, so the
 * zone has to be a property of the tournament rather than of whichever machine last derived a
 * timestamp. See `docs/QBLIVE.md`.
 */

export type IanaTimeZone = string;

/**
 * The fallback used when a tournament predates the timezone field and the host cannot be asked.
 *
 * UTC rather than a populated zone: an obviously-wrong-but-unambiguous offset is easier for a
 * Director to notice and correct than a plausible one that is silently off by an hour.
 */
export const fallbackTimeZone: IanaTimeZone = 'UTC';

/**
 * Whether the runtime recognises the identifier.
 *
 * `Intl.DateTimeFormat` is the only zone database a browser is guaranteed to carry, so it is also
 * the only honest validator available here. A runtime without full ICU narrows the accepted set
 * rather than accepting nonsense, which is the safe direction for a value that decides what time a
 * spectator is told to be in a room.
 */
export function isValidTimeZone(value: unknown): value is IanaTimeZone {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The host's current zone, offered as a default at tournament creation and never re-read after. */
export function hostTimeZone(): IanaTimeZone {
  try {
    const resolved = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(resolved) ? resolved : fallbackTimeZone;
  } catch {
    return fallbackTimeZone;
  }
}

export function normalizeTimeZone(value: unknown): IanaTimeZone {
  return isValidTimeZone(value) ? value : fallbackTimeZone;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: IanaTimeZone): Intl.DateTimeFormat {
  const existing = offsetFormatters.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  offsetFormatters.set(timeZone, created);
  return created;
}

interface ZonedFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedFields(timeZone: IanaTimeZone, instant: Date): ZonedFields {
  const parts = zonedFormatter(timeZone).formatToParts(instant);
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    // Some engines render midnight as hour 24 under hour12: false.
    hour: field('hour') % 24,
    minute: field('minute'),
    second: field('second'),
  };
}

/**
 * The UTC offset of a zone at an instant, as the `+HH:MM` suffix an ISO 8601 timestamp needs.
 *
 * Computed from the instant rather than from the zone alone, because a tournament that runs across
 * a daylight-saving transition has two different correct answers on the same day.
 */
export function utcOffsetAt(timeZone: IanaTimeZone, instant: Date): string {
  const zone = normalizeTimeZone(timeZone);
  const fields = zonedFields(zone, instant);
  const asUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  // The instant's own sub-second component is not part of the offset; drop it on both sides.
  const offsetMinutes = Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * An unambiguous ISO 8601 timestamp carrying the tournament's offset rather than `Z`.
 *
 * A spectator reads "1:30 PM" off their phone; the phone reads it off this string. Publishing the
 * offset the tournament is actually keeping means a viewer in another zone sees a correct local
 * conversion and a viewer in the building sees the time printed on the wall schedule.
 */
export function toZonedIso(instant: Date, timeZone: IanaTimeZone): string {
  const zone = normalizeTimeZone(timeZone);
  const offset = utcOffsetAt(zone, instant);
  const fields = zonedFields(zone, instant);
  const stamp =
    `${pad(fields.year, 4)}-${pad(fields.month)}-${pad(fields.day)}` +
    `T${pad(fields.hour)}:${pad(fields.minute)}:${pad(fields.second)}`;
  return offset === '+00:00' ? `${stamp}Z` : `${stamp}${offset}`;
}

/**
 * Re-express an arbitrary stored timestamp in the tournament's zone, or drop it if unparseable.
 *
 * Returning `null` rather than a guess is the point: QBSheet Live shows no time at all rather than
 * a wrong one, and a caller that cannot distinguish the two would have to invent one.
 */
export function zonedIsoOrNull(value: string | null | undefined, timeZone: IanaTimeZone): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  return toZonedIso(instant, timeZone);
}

/**
 * Convert the value emitted by a `datetime-local` control in the tournament's zone to an absolute
 * instant.  A datetime-local value has no offset, so `new Date(value)` would incorrectly interpret
 * it in the Director laptop's zone.  The small fixed-point adjustment below first guesses the
 * offset, then rechecks it at the resulting instant so daylight-saving transitions use the offset
 * that was actually in force.
 */
export function zonedDateTimeInputToIso(
  value: string | null | undefined,
  timeZone: IanaTimeZone,
): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second = 0] = timePart.split(':').map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const requested = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  let instant = new Date(naiveUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = utcOffsetMinutes(utcOffsetAt(timeZone, instant));
    const next = new Date(naiveUtc - offset * 60_000);
    const fields = zonedFields(normalizeTimeZone(timeZone), next);
    const actual = `${pad(fields.year, 4)}-${pad(fields.month)}-${pad(fields.day)}T${pad(fields.hour)}:${pad(fields.minute)}:${pad(fields.second)}`;
    instant = next;
    if (actual === requested) return instant.toISOString();
  }
  // A local clock value inside a spring-forward gap does not exist. Refuse it rather than silently
  // moving the event to a different wall-clock time.
  return null;
}

/** Convert an absolute instant to the value expected by a datetime-local control. */
export function isoToZonedDateTimeInput(value: string | null | undefined, timeZone: IanaTimeZone): string {
  if (typeof value !== 'string') return '';
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const fields = zonedFields(normalizeTimeZone(timeZone), instant);
  return `${pad(fields.year, 4)}-${pad(fields.month)}-${pad(fields.day)}T${pad(fields.hour)}:${pad(fields.minute)}`;
}

function utcOffsetMinutes(value: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/** Return the runtime's IANA list, with UTC included even on runtimes that omit it. */
export function availableTimeZones(): string[] {
  const supportedValues = (
    Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf?.('timeZone');
  return [...new Set(['UTC', ...(supportedValues ?? [])])].sort((left, right) => left.localeCompare(right));
}

/** A readable label while retaining the exact IANA identifier as the stored value. */
export function timeZoneLabel(timeZone: IanaTimeZone, at = new Date()): string {
  const normalized = normalizeTimeZone(timeZone);
  const city =
    normalized === 'UTC' ? 'UTC' : (normalized.split('/').at(-1)?.replaceAll('_', ' ') ?? normalized);
  return `${city} (${utcOffsetAt(normalized, at)}) · ${normalized}`;
}
