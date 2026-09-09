import { Icon, type IconName } from './Icon';
import { IconButton } from './Controls';
import { labelForSection } from '../app/navigation';
import { toDirectorNotice, type AnnounceInput, type DirectorNoticeAction } from '../notices';

const toneIcons: Record<string, IconName> = {
  success: 'check',
  info: 'info',
  warning: 'alert',
  error: 'warning',
};

const resultsViewLabels: Record<NonNullable<DirectorNoticeAction['resultsView']>, string> = {
  review: 'Needs review',
  games: 'Games',
  protests: 'Protests',
  history: 'History',
};

/**
 * Follow an actionable notice through the same controls a Director already uses.
 *
 * This deliberately clicks the canonical navigation control instead of mutating app state from a
 * second routing system. A Results sub-view is selected on the next frame, after React has rendered
 * the destination.
 */
function followNoticeAction(action: DirectorNoticeAction) {
  const destination = labelForSection(action.section);
  const navigation = Array.from(document.querySelectorAll<HTMLButtonElement>('.director-nav-link')).find(
    (button) => button.title === destination,
  );
  navigation?.click();

  if (action.section !== 'results' || !action.resultsView) return;
  const selectResultsView = () => {
    const group = document.querySelector<HTMLElement>('[role="group"][aria-label="Results view"]');
    if (!group) return;
    const label = resultsViewLabels[action.resultsView!];
    const button = Array.from(group.querySelectorAll<HTMLButtonElement>('button')).find((candidate) =>
      candidate.textContent?.trim().startsWith(label),
    );
    button?.click();
    button?.focus();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(selectResultsView);
  else setTimeout(selectResultsView, 0);
}

/**
 * One Director toast with tone-appropriate treatment.
 *
 * Success and info are non-urgent (`role="status"`); errors are discoverable action items
 * (`role="alert"`, alert icon, never the success check). Warnings sit between: warning
 * treatment with status semantics so they inform without hijacking assistive tech.
 *
 * When a notice names a recovery destination, a trailing arrow takes the operator there instead of
 * making them translate an error sentence back into the application's information architecture.
 */
export function DirectorToast({
  announcement,
  onDismiss,
  onAction,
  className = 'director-toast',
}: {
  announcement: AnnounceInput;
  onDismiss?: () => void;
  onAction?: (action: DirectorNoticeAction) => void;
  className?: string;
}) {
  const notice = toDirectorNotice(announcement);
  const role = notice.tone === 'error' ? 'alert' : 'status';
  const toneClass =
    notice.tone === 'success'
      ? ''
      : notice.tone === 'info'
        ? ' director-toast-info'
        : notice.tone === 'warning'
          ? ' director-toast-warning'
          : ' director-toast-error';
  return (
    <div className={`${className}${toneClass}`} role={role} data-tone={notice.tone}>
      <span className="director-toast-icon" aria-hidden="true">
        <Icon name={toneIcons[notice.tone] ?? 'info'} size={16} />
      </span>
      <p>{notice.message}</p>
      {notice.action && (
        <IconButton
          icon="arrow"
          size="sm"
          label={notice.action.label}
          onClick={() => {
            (onAction ?? followNoticeAction)(notice.action!);
            onDismiss?.();
          }}
        />
      )}
      {onDismiss && <IconButton icon="x" size="sm" label="Dismiss notification" onClick={onDismiss} />}
    </div>
  );
}
