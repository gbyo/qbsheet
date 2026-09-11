import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Director's status model.
 *
 * # Why there is only one
 *
 * Status used to be expressed as dots, whole tinted panels, prose sentences,
 * tab labels, banners, backgrounds, badges, and helper paragraphs — sometimes
 * three of those for the same fact on the same screen. The operator could not
 * tell which treatment meant "worse".
 *
 * Now there are four presentations sharing five tones, and the choice between
 * them is about *what kind of thing* is in the state, never about emphasis:
 *
 *   `Badge`     the state of an object, inline. A row, a header, a list item.
 *   `StateLabel` the same fact where a pill would out-shout the data — dense
 *               tables, the round list.
 *   `Callout`   a state the operator has to read a sentence about, and probably
 *               act on. Carries the action that fixes it.
 *   `Panel data-tone` a container that is itself in that state.
 *
 * Tones, in increasing severity: `neutral`, `info`, `success`, `warning`,
 * `danger`. Severity means severity everywhere.
 */

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/**
 * The domain vocabulary Director statuses actually use, mapped to tones once.
 *
 * Kept as a table rather than inferred per call site so that "released" reads
 * as the same severity on the round list, the transfers page, and the room
 * table.
 */
const toneByState: Record<string, StatusTone> = {
  accepted: 'success',
  available: 'success',
  closed: 'success',
  complete: 'success',
  confirmed: 'success',
  connected: 'success',
  finished: 'success',
  healthy: 'success',
  paired: 'success',
  ready: 'success',
  ruled: 'success',
  saved: 'success',
  active: 'info',
  assigned: 'info',
  current: 'info',
  info: 'info',
  'in-progress': 'info',
  live: 'info',
  prepared: 'info',
  released: 'info',
  running: 'info',
  submitted: 'info',
  watching: 'info',
  playing: 'info',
  help: 'warning',
  'awaiting-result': 'warning',
  recommendation: 'warning',
  received: 'warning',
  review: 'warning',
  'result-received': 'warning',
  stale: 'warning',
  unassigned: 'warning',
  waitlist: 'warning',
  abandoned: 'danger',
  blocked: 'danger',
  blocker: 'danger',
  cancelled: 'danger',
  dropped: 'danger',
  error: 'danger',
  failed: 'danger',
  forfeit: 'danger',
  'no-show': 'danger',
  offline: 'danger',
  rejected: 'danger',
  withdrawn: 'danger',
  archived: 'neutral',
  draft: 'neutral',
  exhibition: 'neutral',
  idle: 'neutral',
  'not-started': 'neutral',
  open: 'neutral',
  pending: 'neutral',
  planned: 'neutral',
  retired: 'neutral',
  scheduled: 'neutral',
  staged: 'neutral',
  stopped: 'neutral',
  waiting: 'neutral',
};

export function normalizeState(state: string): string {
  return (
    state
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'neutral'
  );
}

export function statusTone(state: string): StatusTone {
  const normalized = normalizeState(state);
  const direct = toneByState[normalized];
  if (direct) return direct;
  if (
    /(?:error|offline|blocker|dropped|rejected|failed|abandoned|cancelled|withdrawn|forfeit)/.test(normalized)
  ) {
    return 'danger';
  }
  if (/(?:warning|review|help|recommendation|waitlist|stale|unassigned)/.test(normalized)) return 'warning';
  if (
    /(?:ready|accepted|confirmed|available|connected|finished|complete|healthy|paired|closed)/.test(
      normalized,
    )
  ) {
    return 'success';
  }
  if (/(?:live|active|current|info|assigned|prepared|released|submitted|running)/.test(normalized)) {
    return 'info';
  }
  return 'neutral';
}

export function humanizeState(state: string): string {
  return normalizeState(state)
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (character) => character.toLocaleUpperCase());
}

/**
 * The canonical inline status. A pill, 12px semibold, toned.
 *
 * `state` is domain vocabulary and picks the tone; `label` overrides the text
 * when the human name differs from the stored value — which is most of the
 * time, because internal state names are storage truth, not operator language.
 */
export function Badge({
  state,
  label,
  tone,
  icon,
  className = '',
}: {
  state?: string;
  label?: ReactNode;
  tone?: StatusTone;
  icon?: IconName;
  className?: string;
}) {
  const resolvedTone = tone ?? (state ? statusTone(state) : 'neutral');
  return (
    <span
      className={`director-badge ${className}`.trim()}
      data-tone={resolvedTone}
      data-state={state ? normalizeState(state) : undefined}
    >
      {icon && <Icon name={icon} size={12} />}
      {label ?? (state ? humanizeState(state) : null)}
    </span>
  );
}

/** A count, toned by what the count means. */
export function CountBadge({
  count,
  tone = 'neutral',
  label,
}: {
  count: number;
  tone?: StatusTone;
  label?: string;
}) {
  return (
    <span
      className="director-badge director-badge-count"
      data-tone={tone}
      aria-label={label ? `${count} ${label}` : undefined}
    >
      {count}
    </span>
  );
}

/**
 * The dot form of a status. Same tones, less weight.
 *
 * Kept for dense tables and the tournament-day list, where a column of pills
 * competes with the data it is describing.
 */
export function StateLabel({ state, label, tone }: { state: string; label?: ReactNode; tone?: StatusTone }) {
  const normalized = normalizeState(state);
  const resolvedTone = tone ?? statusTone(normalized);
  return (
    <span className="director-state" data-state={normalized} data-tone={resolvedTone}>
      <span className="director-state-dot" aria-hidden="true" />
      {label ?? humanizeState(normalized)}
    </span>
  );
}

const calloutIcons: Record<StatusTone, IconName> = {
  neutral: 'info',
  info: 'info',
  success: 'success',
  warning: 'alert',
  danger: 'warning',
};

/**
 * A state that needs a sentence and usually an action.
 *
 * The body says what is wrong and why it prevents what the operator wanted;
 * `actions` is where they go to fix it. This replaces the assorted banners,
 * tinted panels, and italic helper paragraphs that carried warnings before —
 * several of which looked exactly like ordinary body copy.
 */
export function Callout({
  tone = 'info',
  title,
  children,
  actions,
  icon,
  role,
  className = '',
}: {
  tone?: StatusTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: IconName;
  role?: 'alert' | 'status' | 'note';
  className?: string;
}) {
  return (
    <div
      className={`director-callout ${className}`.trim()}
      data-tone={tone}
      role={role ?? (tone === 'danger' ? 'alert' : undefined)}
    >
      <span className="director-callout-icon" aria-hidden="true">
        <Icon name={icon ?? calloutIcons[tone]} size={17} />
      </span>
      <div className="director-callout-body">
        {title && <strong>{title}</strong>}
        {children && <p>{children}</p>}
        {actions && <div className="director-callout-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** A determinate progress bar. Plain, no animation beyond the width change. */
export function Progress({
  value,
  max,
  label,
  tone,
}: {
  value: number;
  max: number;
  label?: string;
  tone?: 'accent' | 'success';
}) {
  const safeMax = max > 0 ? max : 1;
  const percent = Math.max(0, Math.min(100, Math.round((value / safeMax) * 100)));
  return (
    <div className="director-progress" data-tone={tone === 'success' ? 'success' : undefined}>
      <div
        className="director-progress-track"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label ?? `${value} of ${max}`}
      >
        <div className="director-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="director-progress-label">{label ?? `${value}/${max}`}</span>
    </div>
  );
}
