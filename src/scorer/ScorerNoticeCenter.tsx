/**
 * The one ambient status surface used by the live scorer.
 *
 * A game can have several true status facts at once (for example, a local save failure and an
 * offline connection). Rendering each fact as a banner makes the scoring controls move under the
 * scorekeeper's hand. This component keeps one reserved surface for the highest-priority fact and
 * leaves the rest available from a compact, deliberate issues view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ScorerNoticeTone = 'info' | 'warning' | 'error';

export interface IScorerNoticeAction {
  label: string;
  onSelect: () => void;
}

export interface IScorerNotice {
  /** Stable identity for the underlying condition, not a render or poll identity. */
  id: string;
  /** Change this when the meaning of the same condition changes materially. */
  fingerprint?: string;
  tone: ScorerNoticeTone;
  /** A short heading. Omit it for a one-line acknowledgement. */
  title?: string;
  /** The explanatory sentence, or the complete text for a heading-less notice. */
  message?: string;
  body?: string;
  actions?: IScorerNoticeAction[];
  /** Lower values are shown first. */
  priority?: number;
  /** Temporary receipts are not retained in the issues count after they disappear. */
  transient?: boolean;
  /** An unresolved condition remains discoverable after its expanded surface is dismissed. */
  persistent?: boolean;
  /** Defaults to the ordinary acknowledgement lifetime when `transient` is true. */
  autoDismissMs?: number;
  /** Ambient notices are dismissible by default. */
  dismissible?: boolean;
  /** Called when this notice is dismissed or expires. It must not move focus. */
  onDismiss?: () => void;
  /** Optional separate callback for auto-expiry. */
  onExpire?: () => void;
  /** Retained for compatibility; the close glyph itself is provided by the notice CSS. */
  dismissGlyph?: boolean;
  dismissLabel?: string;
}

const defaultTransientMs = 4000;

function noticeKey(notice: IScorerNotice): string {
  return `${notice.id}::${notice.fingerprint ?? `${notice.tone}|${notice.title ?? ''}|${notice.message ?? ''}|${notice.body ?? ''}`}`;
}

function noticeText(notice: IScorerNotice): string {
  return [notice.title, notice.message, notice.body, ...(notice.actions?.map((action) => action.label) ?? [])]
    .filter(Boolean)
    .join('|');
}

function priorityFor(notice: IScorerNotice): number {
  if (notice.priority !== undefined) return notice.priority;
  if (notice.tone === 'error') return 10;
  if (notice.tone === 'warning') return 20;
  return 30;
}

function NoticeSurface(props: {
  notice: IScorerNotice;
  onDismiss: (notice: IScorerNotice) => void;
  onHoverChange: (paused: boolean) => void;
}) {
  const { notice, onDismiss, onHoverChange } = props;
  const heading = notice.title;
  const message = notice.message ?? notice.body;
  const role = notice.tone === 'info' ? 'status' : 'alert';
  const dismissible = notice.dismissible !== false;

  return (
    <div
      className={`scorer-banner scorer-notice-surface is-${notice.tone}`}
      role={role}
      data-notice-id={notice.id}
      data-notice-fingerprint={notice.fingerprint}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      onFocusCapture={() => onHoverChange(true)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) onHoverChange(false);
      }}
    >
      {heading && <strong className="scorer-notice-title">{heading}</strong>}
      {message && <span className="scorer-banner-message">{message}</span>}
      {notice.body && notice.message && <span className="scorer-notice-body">{notice.body}</span>}
      {notice.actions?.map((action) => (
        <button key={action.label} type="button" className="scorer-text-action" onClick={action.onSelect}>
          {action.label}
        </button>
      ))}
      {dismissible && (
        <button
          type="button"
          className="scorer-banner-dismiss scorer-notice-dismiss"
          aria-label={notice.dismissLabel ?? `Dismiss ${heading ?? 'notice'}`}
          title={notice.dismissLabel ?? `Dismiss ${heading ?? 'notice'}`}
          onClick={() => onDismiss(notice)}
        />
      )}
    </div>
  );
}

/**
 * Render one expanded notice and, when needed, a compact route to every unresolved condition.
 *
 * The component deliberately does not focus the expanded surface or the issues button when input
 * changes. Background state is allowed to arrive while somebody is scoring without interrupting
 * the keyboard or touch interaction already in progress.
 */
export default function ScorerNoticeCenter(props: { notices: IScorerNotice[] }) {
  const { notices: suppliedNotices } = props;
  const notices = useMemo(() => {
    const deduped = new Map<string, IScorerNotice>();
    for (const notice of suppliedNotices) {
      const key = noticeKey(notice);
      if (!deduped.has(key)) deduped.set(key, notice);
    }
    return [...deduped.values()].sort((first, second) => priorityFor(first) - priorityFor(second));
  }, [suppliedNotices]);
  const keys = useMemo(() => notices.map(noticeKey), [notices]);
  const [dismissed, setDismissed] = useState<Record<string, true>>({});
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [paused, setPaused] = useState(false);

  // A condition that resolved is forgotten. If it later recurs with the same id/fingerprint it is
  // a new unresolved occurrence and can surface again, while a repeated poll remains suppressed.
  useEffect(() => {
    // This is a small local cache reconciliation, not an external subscription. Keeping it here
    // avoids retaining a dismissal after its condition has disappeared and later recurred.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed((current) => {
      let changed = false;
      const next: Record<string, true> = {};
      for (const key of keys) {
        if (current[key]) next[key] = true;
      }
      if (Object.keys(current).length !== Object.keys(next).length) changed = true;
      else {
        for (const key of Object.keys(current)) {
          if (!next[key]) {
            changed = true;
            break;
          }
        }
      }
      return changed ? next : current;
    });
  }, [keys]);

  const unresolved = notices.filter((notice) => notice.persistent);
  const visible = notices.filter((notice) => !dismissed[noticeKey(notice)]);
  const active = visible[0];
  const activeKey = active ? noticeKey(active) : undefined;
  const activeDuration = active
    ? (active.autoDismissMs ?? (active.transient ? defaultTransientMs : undefined))
    : undefined;
  const activeNoticeRef = useRef(active);

  useEffect(() => {
    activeNoticeRef.current = active;
  }, [active]);

  const dismiss = useCallback((notice: IScorerNotice, expired = false) => {
    const key = noticeKey(notice);
    setDismissed((current) => (current[key] ? current : { ...current, [key]: true }));
    if (expired) notice.onExpire?.();
    else notice.onDismiss?.();
  }, []);

  useEffect(() => {
    if (activeKey === undefined || activeDuration === undefined || paused) return undefined;
    const timer = window.setTimeout(() => {
      const notice = activeNoticeRef.current;
      if (notice && noticeKey(notice) === activeKey) dismiss(notice, true);
    }, activeDuration);
    return () => window.clearTimeout(timer);
  }, [activeDuration, activeKey, dismiss, paused]);

  const hiddenIssueCount = unresolved.filter((notice) => noticeKey(notice) !== activeKey).length;
  const showIssues = unresolved.length > 0 && (active === undefined || hiddenIssueCount > 0);

  const showNotice = useCallback((notice: IScorerNotice) => {
    const key = noticeKey(notice);
    setDismissed((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setIssuesOpen(false);
  }, []);

  if (!active && !showIssues) return null;

  const compact = active === undefined;

  return (
    <section
      className={`scorer-notice-region${compact ? ' is-compact' : ''}`}
      aria-label="Game status"
      style={compact ? { minHeight: 'auto', padding: '4px 16px' } : undefined}
    >
      {active && (
        <div className="scorer-notice-slot">
          <NoticeSurface notice={active} onDismiss={dismiss} onHoverChange={setPaused} />
        </div>
      )}
      {showIssues && (
        <button
          type="button"
          className="scorer-notice-issues"
          aria-expanded={issuesOpen}
          aria-controls="scorer-notice-issues-view"
          onClick={() => setIssuesOpen((current) => !current)}
          style={compact ? { position: 'static', display: 'block', marginLeft: 'auto' } : undefined}
        >
          {active ? `${hiddenIssueCount} more` : `Issues ${unresolved.length}`}
        </button>
      )}
      {issuesOpen && (
        <div id="scorer-notice-issues-view" className="scorer-notice-issues-view" aria-label="Open issues">
          <ul>
            {unresolved.map((notice) => {
              const key = noticeKey(notice);
              const hidden = Boolean(dismissed[key]);
              return (
                <li key={key} className={hidden ? 'is-dismissed' : undefined}>
                  <span className={`scorer-notice-issue-mark is-${notice.tone}`} aria-hidden="true" />
                  <span className="scorer-notice-issue-copy">
                    <strong>{notice.title ?? notice.message ?? 'Issue'}</strong>
                    {notice.title && notice.message && <span>{notice.message}</span>}
                    {notice.body && <span>{notice.body}</span>}
                  </span>
                  {hidden ? (
                    <button type="button" className="scorer-text-action" onClick={() => showNotice(notice)}>
                      Show notice
                    </button>
                  ) : (
                    <button type="button" className="scorer-text-action" onClick={() => dismiss(notice)}>
                      Dismiss
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

export { noticeKey, noticeText };
