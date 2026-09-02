/**
 * Formatting.
 *
 * Times are rendered in the tournament's zone by default, because the person reading is usually
 * standing in it. A viewer in another zone gets the same wall-clock time the building is using,
 * which is the number that lets them talk to somebody who is there.
 *
 * The 12/24-hour choice comes from the browser's locale, not from a hardcoded pattern.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  const key = `time:${timeZone}`;
  const existing = formatterCache.get(key);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' });
  formatterCache.set(key, created);
  return created;
}

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const key = `day:${timeZone}`;
  const existing = formatterCache.get(key);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  formatterCache.set(key, created);
  return created;
}

/**
 * A scheduled time, or null.
 *
 * Returning null rather than a placeholder is deliberate. The caller has to decide what to render
 * when there is no time, and the answer is nothing — never "TBD ~2:14".
 */
export function formatTime(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    return timeFormatter(timeZone).format(instant);
  } catch {
    return timeFormatter('UTC').format(instant);
  }
}

export function formatDay(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    return dayFormatter(timeZone).format(instant);
  } catch {
    return dayFormatter('UTC').format(instant);
  }
}

/**
 * How stale the displayed data is, in words.
 *
 * Shown whenever the connection is not live. Never implies freshness it does not have: "Updated
 * just now" is only used inside the first ten seconds.
 */
export function formatAge(receivedAt: number | null, now: number): string {
  if (receivedAt === null) return 'Not updated yet';
  const seconds = Math.max(0, Math.round((now - receivedAt) / 1000));
  if (seconds < 10) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Last updated ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  return `Last updated ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
}

/** A cell's rendered text, honouring the server's own `display` before any client formatting. */
export function cellText(
  cell: { value: string | number | null; display?: string },
  precision?: number,
): string {
  if (cell.display !== undefined) return cell.display;
  if (cell.value === null) return '—';
  if (typeof cell.value === 'number' && precision !== undefined) return cell.value.toFixed(precision);
  return String(cell.value);
}
