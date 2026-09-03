import { Icon } from './Icon';
import { toDirectorNotice, type AnnounceInput } from '../notices';

/**
 * One Director toast with tone-appropriate treatment.
 *
 * Success and info are non-urgent (`role="status"`); errors are discoverable action items
 * (`role="alert"`, alert icon, never the success check). Warnings sit between: warning
 * treatment with status semantics so they inform without hijacking assistive tech.
 */
export function DirectorToast({
  announcement,
  onDismiss,
  className = 'director-toast',
}: {
  announcement: AnnounceInput;
  onDismiss?: () => void;
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
    <div className={`${className}${toneClass}`} role={role}>
      {notice.tone === 'success' && <Icon name="check" size={16} />}
      {notice.tone === 'warning' && <Icon name="alert" size={16} />}
      {notice.tone === 'error' && <Icon name="alert" size={16} />}
      <span>{notice.message}</span>
      {onDismiss && (
        <button type="button" aria-label="Dismiss notification" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}
