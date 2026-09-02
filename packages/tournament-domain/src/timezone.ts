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
