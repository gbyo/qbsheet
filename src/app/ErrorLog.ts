/**
 * The last few things that went wrong, kept so they can be handed over.
 *
 * # Why this exists separately from the connection timeline
 *
 * `ConnectionTimeline` records what the *connection* did, which is a closed set of things this
 * application deliberately does. This records what *broke*: an exception nobody caught, a promise
 * nobody handled, an operation the scoresheet refused. Those are open-ended by nature and they are the
 * ones that are impossible to reconstruct afterwards, because by the time a director hears about a
 * problem the console has been closed and the tab has been reloaded twice.
 *
 * # It never changes what the room sees
 *
 * Recording an error does not raise a banner, does not stop a game, and does not appear on the
 * scoresheet. A Chromebook that throws inside some effect on question fourteen must keep taking
 * tossups; the only thing this adds is that somebody can find out about it on Monday. The existing
 * banners are for problems the scorekeeper has to act on, and that is a strictly smaller set than the
 * problems worth writing down.
 *
 * # Same redaction rule as the timeline
 *
 * Everything here ends up in the same downloadable file, so everything here goes through `redact`. A
 * stack trace is exactly the sort of text that quietly contains a URL with a token in its query string.
 */
import { redact } from './ConnectionTimeline';

export type ErrorSource =
  /** An exception that reached `window.onerror`. */
  | 'uncaught'
  /** A rejected promise nobody handled. */
  | 'unhandled-rejection'
  /**
   * A throw during render, which `window.onerror` never sees.
   *
   * React catches these itself and unmounts the tree, so the browser has nothing to report. Kept
   * distinct from `uncaught` because it is the only source that took the scoresheet off the screen,
   * and a diagnostics bundle that says which one happened answers "why was it blank?" on its own.
   */
  | 'render'
  /** Something this application refused to do, recorded on purpose. */
  | 'rejected-operation';

export interface IErrorEntry {
  /** Authoritative order, for the same reason as the timeline's: clocks move. */
  seq: number;
  at: number;
  /** How many times this identical message has happened in a row. */
  count: number;
  source: ErrorSource;
  /** Redacted, always. */
  message: string;
  /** Where it came from, when the browser said. Redacted; a bundle path is not a secret but a URL can be. */
  where?: string;
}

/**
 * How many are kept.
 *
 * Smaller than the connection timeline on purpose. A device throwing the same error four hundred times
 * has one problem, not four hundred, and the collapse below turns that into one line anyway.
 */
export const errorLogLimit = 50;

/** Longest a message may be. Long enough for a real message, short enough that a trace cannot fill it. */
export const messageLimit = 300;

/** Whatever was thrown, as a sentence. Never trusts it to be an `Error`. */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) {
    return value.message === '' ? value.name : `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'Nothing was thrown, which is itself the problem';
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? 'An unserializable value was thrown'
      : serialized.slice(0, messageLimit);
  } catch {
    // A circular object, or one with a throwing getter. The fact that something was thrown is still
    // worth a line.
    return 'An unserializable value was thrown';
  }
}

export class ErrorLog {
  private buffer: IErrorEntry[] = [];

  private sequence = 0;

  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  record(source: ErrorSource, thrown: unknown, where?: string): void {
    const described = redact(describeThrown(thrown)).slice(0, messageLimit);
    const location = where === undefined || where === '' ? undefined : redact(where);
    const last = this.buffer[this.buffer.length - 1];

    if (last && last.source === source && last.message === described && last.where === location) {
      last.count += 1;
      last.at = this.now();
      return;
    }

    this.sequence += 1;
    this.buffer.push({
      seq: this.sequence,
      at: this.now(),
      count: 1,
      source,
      message: described,
      ...(location ? { where: location } : {}),
    });
    if (this.buffer.length > errorLogLimit) this.buffer.splice(0, this.buffer.length - errorLogLimit);
  }

  entries(): IErrorEntry[] {
    return this.buffer.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.buffer = [];
  }
}

/** The device's error history, for the same reason the timeline is device-scoped. */
export const errorLog = new ErrorLog();

/**
 * Start catching what nobody else caught.
 *
 * Deliberately does not `preventDefault`. The browser should still report the error to its own console,
 * because a developer with the tab open is better served by the real thing than by our copy of it; this
 * only adds a record that survives the console being closed.
 *
 * Returns a function that stops listening, so a test can install and remove this without leaking
 * handlers into the next one.
 */
export function watchForErrors(log: ErrorLog = errorLog): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onError = (event: ErrorEvent) => {
    const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
    log.record('uncaught', event.error ?? event.message, where);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    log.record('unhandled-rejection', event.reason);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
