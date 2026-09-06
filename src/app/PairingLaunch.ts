/**
 * The one URL this application reads, and the reason it is gone by the time anybody sees it.
 *
 * # What a pairing launch link is
 *
 * A director opens Room 204 in tournament control and puts a QR code on the projector, or sends a
 * link over chat. Both carry the same string:
 *
 *     https://qbsheet.com/#qbtcp-pair?v=1&server=http%3A%2F%2F192.168.1.24%3A3000&code=48213906&room=room-204
 *
 * It replaces the two things a scorekeeper otherwise has to copy by hand — an address off a
 * projector and an eight-digit code — and it replaces nothing else. What comes out of it is fed into
 * the same `POST /qbtcp/v1/pair` exchange the typed form uses, through the same client, and produces
 * the same room capability stored in the same place. See `docs/QBTCP.md`, "Pairing launch links and
 * QR codes".
 *
 * # Why the fragment, and not a query string
 *
 * A fragment is never sent to an HTTP server. The scoresheet is a static site behind somebody else's
 * web server and CDN, and a pairing code in `?code=` would be written into their access log, their
 * analytics and their referrer headers before this application ran a line. The fragment reaches the
 * browser and stops there.
 *
 * # Why this file runs before anything else
 *
 * The code is a bootstrap secret. It is short-lived and it only buys a room token, but for the
 * seconds it exists it is enough to pair a stranger's browser into a live tournament — and a URL is
 * the single most shoulder-surfable, screenshot-prone, accidentally-shared part of a page. So the
 * fragment is read and replaced synchronously at startup, before the error logger is installed and
 * before React renders, rather than in an effect that would leave it in the address bar for however
 * long the first paint takes. `main.tsx` calls `capturePairingLaunch` as its first statement.
 *
 * A *recognised* fragment is scrubbed whether or not it parses. A malformed link is exactly as
 * likely to carry a real code as a well-formed one.
 *
 * # And why nothing here is durable
 *
 * The parsed intent is held in memory and handed to the application once. It is never written to
 * storage, never recorded on the connection timeline, never put in diagnostics, and never rendered.
 * The `Ready to connect` screen states the address and the room, and deliberately not the code. Once
 * it has been exchanged for a room capability the code is dropped; the capability is what persists,
 * through the ordinary `ConnectedSession` path that every manual pairing already uses.
 *
 * This is a narrowly scoped bootstrap fragment and not the beginning of a router. There are still no
 * path routes, no application state in the URL, and a reload after the fragment has been consumed is
 * the ordinary QBSheet address. See the note at the top of `App`.
 */
import { normalizeBaseUrl } from '../integrations/fruity/FruityServerClient';

/** The standardised fragment namespace. Product-neutral: it names the protocol, not the scoresheet. */
export const pairingLaunchNamespace = 'qbtcp-pair';

/** The launch format version this build understands. Not the QBTCP wire version. */
export const pairingLaunchVersion = 1;

/**
 * Bounds on untrusted input.
 *
 * Every one of these is generous for a real link and small enough that a hostile QR code cannot make
 * this application spend meaningful time on it. The whole payload is bounded first, so the field
 * limits are never reached by a megabyte of `&&&&`.
 */
const maxLaunchLength = 2048;
const maxServerLength = 512;
const maxCodeLength = 64;
const maxRoomIdLength = 128;

/**
 * What a launch link asked for, once it has been believed.
 *
 * `server` is already through `normalizeBaseUrl`, so it is the same string shape a typed address
 * becomes and it can be handed straight to `openControl`.
 */
export interface IPairingLaunchIntent {
  version: 1;
  /** Normalized, no trailing slash. */
  server: string;
  /** The short bootstrap secret. Never stored, never logged, never rendered. */
  code: string;
  /** Optional. The server remains authoritative for the room it actually pairs. */
  roomId?: string;
}

export type PairingLaunchResult =
  /** No pairing fragment here. The URL is somebody else's business and is left alone. */
  | { kind: 'none' }
  | { kind: 'intent'; intent: IPairingLaunchIntent }
  /** Recognised as a pairing link and refused. The message never contains any part of the link. */
  | { kind: 'problem'; message: string };

export const invalidPairingLaunchMessage = 'This QBSheet pairing link is invalid.';
export const unsupportedPairingLaunchMessage =
  'This pairing link uses a version this build does not support.';

function problem(message: string): PairingLaunchResult {
  return { kind: 'problem', message };
}

/** `application/x-www-form-urlencoded` decoding, which is what a `?a=b` fragment tail is. */
function decodeComponent(raw: string): string {
  return decodeURIComponent(raw.replace(/\+/g, ' '));
}

/**
 * The parameters, or nothing at all.
 *
 * Written by hand rather than with `URLSearchParams` because both of the things this has to refuse
 * are things `URLSearchParams` forgives: it keeps a repeated key and hands back whichever the caller
 * asks for, and it leaves a broken `%zz` escape in place as literal text. A launch link is machine
 * generated, so either one means the generator is wrong or the payload has been edited, and guessing
 * which of two `code` values was meant is not a guess worth making.
 */
function readParameters(query: string): Map<string, string> | null {
  const parameters = new Map<string, string>();
  if (query === '') return parameters;
  for (const pair of query.split('&')) {
    if (pair === '') return null;
    const separator = pair.indexOf('=');
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? '' : pair.slice(separator + 1);
    let key: string;
    let value: string;
    try {
      key = decodeComponent(rawKey);
      value = decodeComponent(rawValue);
    } catch {
      // A malformed percent escape. `decodeURIComponent` throws, and that is the answer.
      return null;
    }
    if (key === '') return null;
    if (parameters.has(key)) return null;
    parameters.set(key, value);
  }
  return parameters;
}

/** Control characters have no place in any of these fields and are the shape of an injection attempt. */
// eslint-disable-next-line no-control-regex
const unprintable = /[\u0000-\u001f\u007f]/;

/**
 * Read a fragment.
 *
 * Accepts the fragment with or without its leading `#`, so a caller can pass `location.hash` or the
 * tail of a scanned URL without deciding which it has.
 */
export function parsePairingLaunch(fragment: string): PairingLaunchResult {
  if (fragment.length > maxLaunchLength) {
    // Too long to be a launch link. Refused rather than ignored only if it announces itself as one;
    // otherwise it is some other application's fragment and none of this file's business.
    return fragment.startsWith(`#${pairingLaunchNamespace}`) || fragment.startsWith(pairingLaunchNamespace)
      ? problem(invalidPairingLaunchMessage)
      : { kind: 'none' };
  }
  const body = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (body !== pairingLaunchNamespace && !body.startsWith(`${pairingLaunchNamespace}?`)) {
    return { kind: 'none' };
  }

  const parameters = readParameters(body.slice(pairingLaunchNamespace.length + 1));
  if (parameters === null) return problem(invalidPairingLaunchMessage);

  const version = parameters.get('v');
  if (version === undefined) return problem(invalidPairingLaunchMessage);
  // Anything that is not exactly this version is a link written for a build that is not this one.
  // Refusing is the safe direction: a launch format that grew a field carrying meaning must not be
  // half-understood by a client that ignores it.
  if (version !== String(pairingLaunchVersion)) return problem(unsupportedPairingLaunchMessage);

  const server = parameters.get('server') ?? '';
  if (server === '' || server.length > maxServerLength || unprintable.test(server)) {
    return problem(invalidPairingLaunchMessage);
  }
  // An explicit scheme is required here, unlike the typed address box. A person squinting at a
  // projector gets `http://` supplied for them; a generator has no such excuse, and a bare host in a
  // launch link is as likely to be a mangled payload as an omission.
  if (!/^https?:\/\//i.test(server)) return problem(invalidPairingLaunchMessage);
  const normalized = normalizeBaseUrl(server);
  if (!normalized.ok) return problem(invalidPairingLaunchMessage);

  const code = (parameters.get('code') ?? '').trim();
  if (code === '' || code.length > maxCodeLength || unprintable.test(code) || /\s/.test(code)) {
    return problem(invalidPairingLaunchMessage);
  }

  const room = parameters.get('room');
  if (room !== undefined) {
    // `room=` with nothing after it is ambiguous rather than absent, and this is not a payload to
    // resolve ambiguity in. A generator that means "any room" omits the parameter.
    if (room.trim() === '' || room.length > maxRoomIdLength || unprintable.test(room)) {
      return problem(invalidPairingLaunchMessage);
    }
  }

  // Unknown parameters are ignored, which is QBTCP's forward-compatibility rule for every other
  // document it defines. Ignoring is only safe because the version above is exact: a future field
  // that carries authority arrives with a version this build refuses outright.
  return {
    kind: 'intent',
    intent: {
      version: pairingLaunchVersion,
      server: normalized.value,
      code,
      ...(room === undefined ? {} : { roomId: room.trim() }),
    },
  };
}

/**
 * Read a whole scanned string.
 *
 * The QR code carries a complete URL, because the same string has to work when a director pastes it
 * into a chat window. Which origin it names is the deployment's business and not this parser's — a
 * self-hosted copy on a school's own server produces its own links — so everything up to the `#` is
 * discarded rather than checked.
 */
export function parsePairingLaunchUrl(text: string): PairingLaunchResult {
  const hashAt = text.indexOf('#');
  if (hashAt === -1) return { kind: 'none' };
  return parsePairingLaunch(text.slice(hashAt));
}

/**
 * Interpret a QR scan for the two screens that can start pairing.
 *
 * The scanner owns the camera, while its caller owns the screen state and the next pairing action.
 * Keeping this small handoff here means both screens preserve the same distinction between a
 * malformed QBSheet link and an ordinary non-pairing QR code.
 */
export function readScannedPairingCode(
  text: string,
  setScanning: (scanning: boolean) => void,
  onPairingLaunch: (intent: IPairingLaunchIntent) => void,
): string | null {
  const parsed = parsePairingLaunchUrl(text);
  if (parsed.kind === 'problem') return parsed.message;
  if (parsed.kind === 'none')
    return 'That is not a QBSheet pairing code. Look for the QR code tournament control is showing.';
  setScanning(false);
  onPairingLaunch(parsed.intent);
  return null;
}

/**
 * Take the fragment out of the address bar, without a reload and without a history entry.
 *
 * The pathname and query are rebuilt rather than the URL edited, so a deployment under a GitHub
 * Pages project path keeps its base and anything legitimate in the query string survives.
 */
function scrub(target: Window): void {
  try {
    const { pathname, search } = target.location;
    target.history.replaceState(target.history.state, '', `${pathname}${search}`);
  } catch {
    // A `file://` copy on a USB stick can refuse `replaceState`. Nothing better is available — a
    // `location` assignment would reload the page — and pairing is still safe to offer, so the rest
    // of the flow continues with the fragment still on screen.
  }
}

/**
 * Read the current URL's fragment and remove it if it was ours.
 *
 * Synchronous, all of it. Nothing here awaits, schedules, or renders between reading the code and
 * replacing the URL that held it.
 */
export function consumePairingLaunch(
  target: Window | null = typeof window === 'undefined' ? null : window,
): PairingLaunchResult {
  if (target === null) return { kind: 'none' };
  const result = parsePairingLaunch(target.location.hash);
  if (result.kind !== 'none') scrub(target);
  return result;
}

/**
 * The one piece of module state, and why it is allowed to exist.
 *
 * The fragment has to be consumed before the application starts, and the application has to be told
 * what was in it. Those are two different moments in two different files with no value that can be
 * passed between them, because `main.tsx` renders `<App />` rather than calling it. So the answer is
 * held here, for exactly as long as it takes the first render to ask for it.
 */
let captured: PairingLaunchResult | null = null;

/** Startup. Called by `main.tsx` before the error logger and before React. */
export function capturePairingLaunch(target?: Window | null): PairingLaunchResult {
  captured = target === undefined ? consumePairingLaunch() : consumePairingLaunch(target);
  return captured;
}

/**
 * Read the captured launch, once.
 *
 * Falls back to consuming the URL directly, which is what happens when the application is mounted by
 * something other than `main.tsx` — a test, or an embedding host. The scrub is the same scrub either
 * way; there is only one implementation of it.
 */
export function takePairingLaunch(): PairingLaunchResult {
  const held = captured ?? consumePairingLaunch();
  captured = null;
  return held;
}
