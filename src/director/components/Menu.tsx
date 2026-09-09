import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Command, useCommandState } from 'cmdk';
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
 *
 * Because everything overflows into one of these, they are also searchable: the popover is a `cmdk`
 * command list and typing filters the items by fuzzy score. See `DirectorMenu` for what that costs
 * in ARIA terms — the items are options in a filtered listbox, not menu items.
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
  searchPlaceholder,
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
  /** Overrides the filter field's placeholder, e.g. "Search packets". */
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const [listboxId, setListboxId] = useState<string>();
  const close = useCallback(() => setOpen(false), []);

  /*
   * Closing returns focus to the trigger.
   *
   * This is what makes a menu item that opens a dialog restore focus correctly:
   * the dialog captures whatever is focused when it mounts, and without this
   * that was a menu item which had just been unmounted — so Escape left focus
   * on the document body. The cleanup runs before the dialog's own effects, so
   * the trigger is focused in time for the dialog to capture it.
   *
   * Nothing is stolen: if focus already moved somewhere real, it stays there.
   */
  useEffect(() => {
    if (!open) return;
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const opener = openerRef.current;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open]);

  const commonTriggerProps = {
    // The popover is a filter field over a listbox, not a menu — see `DirectorMenu`.
    'aria-haspopup': 'listbox' as const,
    'aria-expanded': open,
    'aria-controls': open ? listboxId : undefined,
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
          onListboxId={setListboxId}
          className="director-menu"
          align={align}
          placement={placement}
          floating
          openerRef={openerRef}
          onClose={close}
          searchPlaceholder={searchPlaceholder}
        >
          {typeof children === 'function' ? children(close) : children}
        </DirectorMenu>
      )}
    </div>
  );
}

/**
 * One action in a menu.
 *
 * The label and any `detail` are both searchable — an operator looking for the round with the
 * missing packet types "packet", not the row number. `keywords` adds terms that are not on screen,
 * for the entries whose visible label is not what anyone would type ("Advanced recovery…" is what
 * you reach for when you would have searched "rollback").
 */
export function MenuItem({
  children,
  onSelect,
  icon,
  detail,
  disabled = false,
  tone = 'default',
  selected = false,
  keywords,
}: {
  children: ReactNode;
  onSelect: () => void;
  icon?: IconName;
  detail?: ReactNode;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  selected?: boolean;
  /** Extra search terms that are not part of the visible label. */
  keywords?: string[];
}) {
  return (
    <Command.Item
      className={[
        'director-menu-item',
        tone === 'danger' ? 'director-menu-item-danger' : '',
        selected ? 'is-selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled}
      keywords={keywords}
      onSelect={onSelect}
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
    </Command.Item>
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
      <Command.Item
        className="director-menu-item"
        disabled={disabled}
        onSelect={() => inputRef.current?.click()}
      >
        <span className="director-menu-item-icon" aria-hidden="true">
          <Icon name={icon} size={15} />
        </span>
        <span>{children}</span>
      </Command.Item>
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
  return <Command.Separator className="director-menu-separator" />;
}

/*
 * The furniture between the items — group headings, separators, the note under a disabled entry —
 * all describes the *unfiltered* list. Once a search narrows the list, a heading whose whole group
 * scored zero is a label over someone else's item, so the furniture stands down until the field is
 * empty again. `cmdk` already does this for separators; headings and notes are ours.
 */
function useIsSearching() {
  return useCommandState((state) => state.search.length > 0);
}

export function MenuSectionLabel({ children }: { children: ReactNode }) {
  const searching = useIsSearching();
  if (searching) return null;
  return <p className="director-menu-section-label">{children}</p>;
}

export function MenuNote({ children }: { children: ReactNode }) {
  const searching = useIsSearching();
  if (searching) return null;
  return <div className="director-menu-note">{children}</div>;
}
