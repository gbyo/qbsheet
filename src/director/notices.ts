/**
 * Typed Director notifications.
 *
 * Director views report outcomes through `onAnnounce`, and the app shell used to render every
 * message with the same success/check-style toast — including validation failures and operation
 * errors. Callers now pass either a plain string (unchanged benign confirmation behavior) or a
 * `{ message, tone }` notice; the shell renders each tone with its own treatment so an error can
 * never visually claim success.
 */
export type DirectorNoticeTone = 'success' | 'info' | 'warning' | 'error';

export interface DirectorNotice {
  message: string;
  tone: DirectorNoticeTone;
}

/** What `onAnnounce` accepts: legacy plain confirmations, or an explicit toned notice. */
export type AnnounceInput = string | DirectorNotice;

/** Normalize any announce input; bare strings keep their long-standing success treatment. */
export function toDirectorNotice(input: AnnounceInput): DirectorNotice {
  return typeof input === 'string' ? { message: input, tone: 'success' } : input;
}

/** An operation failure: error treatment, `role="alert"`, never a success/check icon. */
export function errorNotice(message: string): DirectorNotice {
  return { message, tone: 'error' };
}

/** Neutral state worth stating without celebrating or alarming. */
export function infoNotice(message: string): DirectorNotice {
  return { message, tone: 'info' };
}

/** Something needs attention but is not a failure. */
export function warningNotice(message: string): DirectorNotice {
  return { message, tone: 'warning' };
}
