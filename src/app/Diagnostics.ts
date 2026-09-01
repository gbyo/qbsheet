/**
 * Everything one device knows about itself, in a file somebody can send.
 *
 * # The problem this solves
 *
 * "Room 12 stopped sending scores." That sentence arrives at a tournament desk with no other
 * information, and every fact that would resolve it is inside a Chromebook two floors up: which build
 * it is running, whether the browser ever granted local-network access, whether the server it is
 * pointed at speaks QBTCP or fell back to the deprecated routes, whether storage is durable, and what
 * the connection actually did in the ninety seconds before somebody noticed. Walking a director through
 * eleven screens over a radio does not work. One button that produces one file does.
 *
 * # What is deliberately not in it
 *
 * Room tokens. Session tokens. Pairing codes. The device identity that arbitrates the writer lock. Any
 * URL query string. Anything a scorekeeper typed into a free-text box.
 *
 * This is the entire reason the export can be offered at all. A diagnostics file is going to be emailed
 * to whoever is helping, forwarded twice, and left in a downloads folder on a shared laptop; a room
 * token in it is a stranger's ability to write scores into a live tournament, and a pairing code is the
 * same thing one step removed. So the bundle is built by *naming every field that goes in* rather than
 * by serializing objects that happen to be nearby — the opposite of how a debug dump is usually
 * written, and the only shape where a token cannot arrive by accident when somebody later adds a field
 * to `IConnectedSession`.
 *
 * The one concession is that the server *address* is included, because a room pointed at the wrong
 * address is a real and common fault and the address is not a secret — it is on the projector at the
 * front of the room. It is stripped of any query string on the way in.
 */
import { IBuildVersion, buildVersion } from '../pwa/BuildVersion';
import { IWorkerBuild } from '../pwa/AppUpdate';
import { ITimelineEntry, connectionTimeline, redact, timelineLine } from './ConnectionTimeline';
import { IErrorEntry, errorLog } from './ErrorLog';
import { IUnreadableRecord } from '../game/GameRecordUpgrade';
import { downloadFile } from '../integrations/file/QbjDownload';

/** The format of the file itself, so a future reader knows what it is looking at. */
export const diagnosticsVersion = 1;

/** One readiness check, flattened out of whatever the screen was rendering. */
export interface IDiagnosticCheck {
  id: string;
  title: string;
  state: string;
  kind: string;
  detail: string;
}

/** What a room is pointed at, with nothing that could be used to talk to it. */
export interface IDiagnosticServer {
  /** Origin and path only. No query string, ever. */
  address?: string;
  /** Whether discovery found QBTCP, or this client fell back to the deprecated routes. */
  protocol: 'QBTCP' | 'legacy' | 'unsupported' | 'unknown';
  version?: number;
  qbjVersion?: string;
  capabilities?: string[];
  /** The tournament control said it was running. Not a secret; frequently the answer. */
  tournamentName?: string;
}

export interface IDiagnosticsInput {
  build?: IBuildVersion;
  /** What the worker serving this page says it is. A mismatch with `build` is itself a finding. */
  worker?: IWorkerBuild | null;
  /** True when a newer build is installed and waiting. */
  updateWaiting?: boolean;
  checks?: IDiagnosticCheck[];
  server?: IDiagnosticServer;
  /** The room's own name, for orientation. Never the room id or token. */
  roomName?: string;
  /** Storage facts, as the readiness screen measured them. */
  persistence?: {
    recordStoreDurable?: boolean;
    localStorageWorks?: boolean;
    persistentStorage?: boolean | null;
    storageUsage?: number;
    storageQuota?: number;
  };
  /** How many games are saved, and how many this build could not read. */
  games?: { saved: number; unfinished: number; unreadable: IUnreadableRecord[] };
  timeline?: ITimelineEntry[];
  errors?: IErrorEntry[];
  /** Injected so a test gets a stable file. */
  now?: Date;
}

export interface IDiagnosticsBundle {
  diagnosticsVersion: number;
  /** ISO 8601, and the device's own idea of the time — which is occasionally the bug. */
  generatedAt: string;
  /** Minutes offset from UTC, because a device with the wrong timezone reads as the wrong hour. */
  timezoneOffsetMinutes: number;
  build: IBuildVersion;
  worker: IWorkerBuild | null;
  updateWaiting: boolean;
  browser: { userAgent: string; language: string; platform?: string; screen?: string; online: boolean };
  server: IDiagnosticServer;
  roomName?: string;
  persistence: NonNullable<IDiagnosticsInput['persistence']>;
  games: { saved: number; unfinished: number; unreadable: IUnreadableRecord[] };
  checks: IDiagnosticCheck[];
  /** Human-readable lines, in order. The raw entries follow for anything that wants to parse them. */
  connectionTimeline: string[];
  connectionEntries: ITimelineEntry[];
  errors: IErrorEntry[];
}

/** Strip a URL back to the part that is safe to write down. */
export function safeAddress(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const url = new URL(value);
    // Credentials embedded in a URL are rare and catastrophic, so they go before anything else.
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    // Not parseable as a URL. Redact rather than pass through, because whatever it is, nobody here
    // knows what is in it.
    return redact(value);
  }
}

function browserFacts(): IDiagnosticsBundle['browser'] {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const legacyPlatform = (nav as (Navigator & { platform?: string }) | undefined)?.platform;
  return {
    // The user agent is the browser and OS in one string, which is exactly the question being asked
    // ("is this the Chromebook fleet or somebody's iPad?").
    userAgent: nav?.userAgent ?? 'unknown',
    language: nav?.language ?? 'unknown',
    ...(legacyPlatform ? { platform: legacyPlatform } : {}),
    ...(typeof window !== 'undefined' && window.screen
      ? { screen: `${window.screen.width}×${window.screen.height} @${window.devicePixelRatio ?? 1}x` }
      : {}),
    online: nav?.onLine ?? false,
  };
}

export function buildDiagnostics(input: IDiagnosticsInput = {}): IDiagnosticsBundle {
  const now = input.now ?? new Date();
  const timeline = input.timeline ?? connectionTimeline.entries();
  return {
    diagnosticsVersion,
    generatedAt: now.toISOString(),
    timezoneOffsetMinutes: -now.getTimezoneOffset(),
    build: input.build ?? buildVersion,
    worker: input.worker ?? null,
    updateWaiting: input.updateWaiting ?? false,
    browser: browserFacts(),
    server: input.server ?? { protocol: 'unknown' },
    ...(input.roomName ? { roomName: input.roomName } : {}),
    persistence: input.persistence ?? {},
    games: input.games ?? { saved: 0, unfinished: 0, unreadable: [] },
    checks: input.checks ?? [],
    connectionTimeline: timeline.map(timelineLine),
    connectionEntries: timeline,
    errors: input.errors ?? errorLog.entries(),
  };
}

/**
 * The filename.
 *
 * Carries the build and the minute, because the first thing that happens to one of these is that three
 * of them from three devices end up in the same folder. No room name: a filename is the one part of a
 * download that shows up in screenshots and shoulder-surfing range, and the room is inside the file
 * anyway.
 */
export function diagnosticsFilename(bundle: IDiagnosticsBundle): string {
  const stamp = bundle.generatedAt.replace(/[:.]/g, '-').replace(/Z$/, '');
  return `qbsheet-diagnostics-${bundle.build.commit}-${stamp}.json`;
}

/**
 * Field names that must never appear in an exported bundle, whatever they contain.
 *
 * The reliable half of the check below. A field called `roomToken` is wrong even if it is empty, because
 * its existence means somebody spread a connection object into the bundle and the next person to add a
 * credential to that object will not think about this file at all.
 */
const forbiddenFields =
  /(token|secret|password|pairing[_-]?code|authorization|credential|deviceid|roomid|sessionid)/i;

/**
 * What a credential looks like when nobody labelled it.
 *
 * Deliberately narrow: at least 24 characters of unbroken letters-and-digits with both present. That is
 * the shape of a JWT segment, a hex session id, a base64url token. It is emphatically *not* the shape of
 * the things that legitimately appear here — `tournament-control-1.local` and
 * `qbsheet-shell-ba0f64fe8df2f006` both break at their hyphens, and a version or a timestamp breaks at
 * its dots and colons.
 *
 * An earlier version of this allowed hyphens and underscores in the run, which flagged every hyphenated
 * hostname and the worker's own cache name — a check that cries wolf gets an allow-list bolted onto it
 * and then stops being a check at all.
 */
const unlabelledCredential = /(?=[A-Za-z0-9]{24,})(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{24,}/;

/**
 * The last line of defence, run before any file is written.
 *
 * Two checks, and the second is the important one. Scanning for things that *look* like credentials is
 * guesswork; scanning for the credentials this device is actually holding is not. So the caller passes
 * the live secrets — the room token, the session token, the identifiers that arbitrate the writer lock —
 * and this refuses to produce a file if any of them appears anywhere in it, verbatim. That catches the
 * real failure mode exactly: a field added to `IConnectedSession` six months from now that somebody
 * spreads into this bundle without reading this comment.
 *
 * A diagnostics download that fails loudly is a bug report. One that quietly contains a session token is
 * a live tournament a stranger can write scores into.
 */
export function findLeaks(bundle: IDiagnosticsBundle, secrets: readonly string[] = []): string[] {
  const leaks: string[] = [];

  const visit = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      // The user agent is a long string chosen by the browser vendor and is the point of the field.
      if (path !== 'diagnostics.browser.userAgent' && unlabelledCredential.test(value)) {
        leaks.push(`${path} contains something shaped like a credential`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (forbiddenFields.test(key)) {
          leaks.push(`${path}.${key} is a field name that must never be exported`);
          continue;
        }
        visit(nested, `${path}.${key}`);
      }
    }
  };
  visit(bundle, 'diagnostics');

  // Short values are not credentials worth failing a download over, and a two-character "secret" would
  // match half the file.
  const serialized = JSON.stringify(bundle);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6 && serialized.includes(secret)) {
      leaks.push('a live credential from this device appears in the bundle');
    }
  }
  return leaks;
}

export function serializeDiagnostics(bundle: IDiagnosticsBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export type DiagnosticsOutcome =
  | { ok: true; fileName: string }
  /** The browser gave us no way to write a file. Same failure the QBJ backup can have. */
  | { ok: false; reason: 'no-download' }
  /** The safety scan found something. Deliberately loud; see `findLeaks`. */
  | { ok: false; reason: 'unsafe'; leaks: string[] };

/**
 * Build the bundle, check it, and write it.
 *
 * The order is the point: nothing is written until `findLeaks` has passed. A caller cannot get the file
 * without the check, because there is no exported path that produces one.
 */
export function downloadDiagnostics(
  input: IDiagnosticsInput = {},
  secrets: readonly string[] = [],
  write: (contents: string, fileName: string) => boolean = downloadFile,
): DiagnosticsOutcome {
  const bundle = buildDiagnostics(input);
  const leaks = findLeaks(bundle, secrets);
  if (leaks.length > 0) return { ok: false, reason: 'unsafe', leaks };
  const fileName = diagnosticsFilename(bundle);
  return write(serializeDiagnostics(bundle), fileName)
    ? { ok: true, fileName }
    : { ok: false, reason: 'no-download' };
}
