import type { SectionId } from './app/navigation';

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

export interface DirectorNoticeAction {
  /** Accessible label for the trailing navigation arrow. */
  label: string;
  /** Director destination that contains the recovery/workflow the notice is asking for. */
  section: SectionId;
  /** Optional sub-view inside Results. */
  resultsView?: 'review' | 'games' | 'protests' | 'history';
}

export interface DirectorNotice {
  message: string;
  tone: DirectorNoticeTone;
  action?: DirectorNoticeAction;
}

/** What `onAnnounce` accepts: legacy plain confirmations, or an explicit toned notice. */
export type AnnounceInput = string | DirectorNotice;

/** Normalize any announce input; bare strings keep their long-standing success treatment. */
export function toDirectorNotice(input: AnnounceInput): DirectorNotice {
  return typeof input === 'string' ? { message: input, tone: 'success' } : input;
}

/**
 * Known recovery wording that already names a canonical Director surface.
 *
 * Most new actionable errors should pass an explicit action to `errorNotice`. This compatibility
 * mapping makes the existing unresolved-game guard actionable without coupling the generic toast
 * to a team-specific error string, and keeps equivalent recovery wording consistent if another
 * caller emits it.
 */
function inferredErrorAction(message: string): DirectorNoticeAction | undefined {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('accept the result') &&
    normalized.includes('record a forfeit') &&
    normalized.includes('cancel/replay') &&
    normalized.includes('recovery')
  ) {
    return {
      label: 'Go to unresolved games',
      section: 'results',
      resultsView: 'games',
    };
  }
  return undefined;
}

/** An operation failure: error treatment, `role="alert"`, never a success/check icon. */
export function errorNotice(message: string, action?: DirectorNoticeAction): DirectorNotice {
  const resolvedAction = action ?? inferredErrorAction(message);
  return resolvedAction ? { message, tone: 'error', action: resolvedAction } : { message, tone: 'error' };
}

/** Neutral state worth stating without celebrating or alarming. */
export function infoNotice(message: string): DirectorNotice {
  return { message, tone: 'info' };
}

/** Something needs attention but is not a failure. */
export function warningNotice(message: string): DirectorNotice {
  return { message, tone: 'warning' };
}
