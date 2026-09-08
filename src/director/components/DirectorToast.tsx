import { Icon, type IconName } from './Icon';
import { IconButton } from './Controls';
import { toDirectorNotice, type AnnounceInput } from '../notices';

const toneIcons: Record<string, IconName> = {
  success: 'check',
  info: 'info',
  warning: 'alert',
  error: 'warning',
};

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
    <div className={`${className}${toneClass}`} role={role} data-tone={notice.tone}>
      <span className="director-toast-icon" aria-hidden="true">
        <Icon name={toneIcons[notice.tone] ?? 'info'} size={16} />
      </span>
      <p>{notice.message}</p>
      {onDismiss && <IconButton icon="x" size="sm" label="Dismiss notification" onClick={onDismiss} />}
    </div>
  );
}
