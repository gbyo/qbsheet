import { useId, useRef, useState, type ReactNode } from 'react';
import { DirectorMenu } from './DirectorMenu';
import { Icon, type IconName } from './Icon';
import { Button, IconButton } from './Controls';

/**
 * The Director action menu.
 *
 * # Why everything overflows into one of these
 *
 * A table row used to carry a toolbar: Edit, Assign packet, Assign room, Put on
 * USB, Move game, Prepare, Release, Close, Remove — visible on every row, on
 * every page, rearranging as state changed. That is a lot of chrome for actions
 * an operator takes once a tournament.
 *
 * The rule now: a row or list item shows **at most one action**, the one its
 * current state makes obvious, and everything else lives here. Which means the
 * primary action stays in the same place as state changes, and low-frequency
 * work is one predictable click away.
 *
 * The trigger is the shared `more` icon. The literal `•••` text is gone.
 */

export function ActionMenu({
  label,
  children,
  align = 'end',
  placement = 'bottom',
  trigger,
  triggerLabel,
  triggerIcon = 'more',
  triggerVariant = 'icon',
  disabled = false,
  className = '',
}: {
  /** The menu's accessible name, e.g. "Round 4 actions". */
  label: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  placement?: 'bottom' | 'top';
  /** A custom trigger. Receives nothing; wire it through `triggerLabel` instead where possible. */
  trigger?: ReactNode;
  triggerLabel?: string;
  triggerIcon?: IconName;
  triggerVariant?: 'icon' | 'secondary' | 'quiet' | 'primary';
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const menuId = useId();
  const close = () => setOpen(false);

  const commonTriggerProps = {
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    disabled,
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      openerRef.current = event.currentTarget;
      setOpen((current) => !current);
    },
  };

  return (
    <div className={`director-menu-wrap ${className}`.trim()}>
      {trigger ??
        (triggerVariant === 'icon' ? (
          <IconButton
            {...commonTriggerProps}
            icon={triggerIcon}
            label={triggerLabel ?? label}
            ref={openerRef as React.RefObject<HTMLButtonElement>}
          />
        ) : (
          <Button
            {...commonTriggerProps}
            variant={triggerVariant}
            icon={triggerIcon === 'more' ? undefined : triggerIcon}
            iconAfter="chevron"
          >
            {triggerLabel ?? label}
          </Button>
        ))}
      {open && (
        <DirectorMenu
          label={label}
          id={menuId}
          className="director-menu"
          align={align}
          placement={placement}
          openerRef={openerRef}
          onClose={close}
        >
          {typeof children === 'function' ? children(close) : children}
        </DirectorMenu>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onSelect,
  icon,
  detail,
  disabled = false,
  tone = 'default',
  selected = false,
}: {
  children: ReactNode;
  onSelect: () => void;
  icon?: IconName;
  detail?: ReactNode;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  selected?: boolean;
}) {
  return (
    <button
      role="menuitem"
      type="button"
      className={[
        'director-menu-item',
        tone === 'danger' ? 'director-menu-item-danger' : '',
        selected ? 'is-selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled}
      onClick={onSelect}
    >
      {icon && (
        <span className="director-menu-item-icon" aria-hidden="true">
          <Icon name={icon} size={15} />
        </span>
      )}
      <span>{children}</span>
      {detail && <small>{detail}</small>}
      {selected && (
        <span className="director-menu-item-icon" aria-hidden="true">
          <Icon name="check" size={15} />
        </span>
      )}
    </button>
  );
}

/**
 * A menu item that opens the platform file picker.
 *
 * The native `<input type="file">` is kept, because the platform dialog is the
 * right dialog and a synthetic one cannot read the filesystem. Only the visible
 * affordance is Director's — and it is the *same* affordance everywhere a file
 * is chosen, rather than a `<label>` styled as a button in one place and a
 * "Choose file…" quiet button in another.
 */
export function MenuFileItem({
  children,
  accept,
  onFile,
  icon = 'upload',
  multiple = false,
  disabled = false,
}: {
  children: ReactNode;
  accept: string;
  onFile: (files: File[]) => void;
  icon?: IconName;
  multiple?: boolean;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        role="menuitem"
        type="button"
        className="director-menu-item"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <span className="director-menu-item-icon" aria-hidden="true">
          <Icon name={icon} size={15} />
        </span>
        <span>{children}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="director-visually-hidden-input"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (files.length) onFile(files);
        }}
      />
    </>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="director-menu-separator" />;
}

export function MenuSectionLabel({ children }: { children: ReactNode }) {
  return <p className="director-menu-section-label">{children}</p>;
}

export function MenuNote({ children }: { children: ReactNode }) {
  return <div className="director-menu-note">{children}</div>;
}
