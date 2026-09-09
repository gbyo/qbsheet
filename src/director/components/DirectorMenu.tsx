import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Command } from 'cmdk';
import { Icon } from './Icon';

const FLOATING_GAP = 4;
const FLOATING_MARGIN = 8;

export type FloatingMenuPosition = {
  left: number;
  top: number;
  placement: 'bottom' | 'top';
};

/** Calculate a viewport-safe position for a fixed-position menu. Kept pure so edge cases are easy to test. */
export function getFloatingMenuPosition(
  opener: DOMRect,
  menu: Pick<DOMRect, 'width' | 'height'>,
  align: 'start' | 'end',
  preferredPlacement: 'bottom' | 'top',
  viewport = { width: window.innerWidth, height: window.innerHeight },
): FloatingMenuPosition {
  const roomBelow = viewport.height - opener.bottom - FLOATING_GAP - FLOATING_MARGIN;
  const roomAbove = opener.top - FLOATING_GAP - FLOATING_MARGIN;
  const placement =
    preferredPlacement === 'bottom'
      ? roomBelow < menu.height && roomAbove > roomBelow
        ? 'top'
        : 'bottom'
      : roomAbove < menu.height && roomBelow > roomAbove
        ? 'bottom'
        : 'top';
  const unclampedLeft = align === 'end' ? opener.right - menu.width : opener.left;
  const left = Math.min(
    Math.max(FLOATING_MARGIN, unclampedLeft),
    Math.max(FLOATING_MARGIN, viewport.width - menu.width - FLOATING_MARGIN),
  );
  const unclampedTop =
    placement === 'bottom' ? opener.bottom + FLOATING_GAP : opener.top - menu.height - FLOATING_GAP;
  const top = Math.min(
    Math.max(FLOATING_MARGIN, unclampedTop),
    Math.max(FLOATING_MARGIN, viewport.height - menu.height - FLOATING_MARGIN),
  );
  return { left, top, placement };
}

/**
 * One Director popover menu with real menu behavior.
 *
 * Every Director menu mounts this while open, so all of them share one contract: click outside
 * closes, Escape closes and returns focus to the opener, Tab closes without intercepting normal
 * keyboard travel, and Up/Down/Home/End move between the enabled items. The shell keeps a single
 * `openMenu` value, so opening one menu always closes the other — two popovers can never strand
 * each other.
 *
 * # Why every menu is a search field
 *
 * The menus are where all the low-frequency work went (see `Menu.tsx`), so they are the one place
 * an operator has to *find* something rather than recognize it — and the tournament switcher's list
 * grows with every tournament the machine has ever opened. So the popover is a `cmdk` command list:
 * type and the items filter by fuzzy score, best match first, with the top match already selected
 * so Enter runs it.
 *
 * That means the items are `role="option"` inside a `role="listbox"` filtered by a `role="combobox"`
 * input — not `role="menu"`/`role="menuitem"`. A menu whose contents change as you type is a
 * combobox, and calling it a menu to a screen reader while the visible list narrows underfoot would
 * be a lie. Arrow travel, Home/End, the active-descendant announcement and the filtering all come
 * from `cmdk`; what stays here is the popover's own contract — dismissal, focus return, placement.
 *
 * Escape is two-stage when a search is in flight: the first one clears the query (the list you were
 * looking at comes back), the second closes. With an empty field it closes immediately, which is
 * the only behavior most menus ever see.
 */
export function DirectorMenu({
  label,
  className,
  id,
  align = 'start',
  placement = 'bottom',
  floating = false,
  openerRef,
  onClose,
  searchPlaceholder,
  children,
}: {
  label: string;
  className?: string;
  id?: string;
  /** Which edge the popover is anchored to; read by the stylesheet. */
  align?: 'start' | 'end';
  placement?: 'bottom' | 'top';
  /** Render in the document layer and position against the trigger viewport. */
  floating?: boolean;
  openerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Overrides the filter field's placeholder, e.g. "Search tournaments". */
  searchPlaceholder?: string;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const searchRef = useRef('');
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState<FloatingMenuPosition | null>(null);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    searchRef.current = search;
  }, [search]);

  // Once per mount: the popover opens onto its filter field, so a keyboard operator can type
  // immediately and a mouse operator gains arrow travel from the first match. Later parent renders
  // do not steal focus back — a menu entry that opens a dialog has to be able to hand it over.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        menuRef.current &&
        target &&
        !menuRef.current.contains(target) &&
        !(openerRef.current && openerRef.current.contains(target))
      ) {
        onCloseRef.current();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        // A query in flight is what Escape undoes first: the operator is narrowing a list, and
        // losing the whole popover on a mistyped letter would cost them the menu as well.
        if (searchRef.current) {
          setSearch('');
          return;
        }
        onCloseRef.current();
        openerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'Tab') {
        // Keep native Tab/Shift+Tab travel, but dismiss the temporary surface before focus moves.
        onCloseRef.current();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [openerRef]);

  useLayoutEffect(() => {
    if (!floating) return;
    const updatePosition = () => {
      const opener = openerRef.current;
      const menu = menuRef.current;
      if (!opener || !menu) return;
      const next = getFloatingMenuPosition(
        opener.getBoundingClientRect(),
        menu.getBoundingClientRect(),
        align,
        placement,
      );
      setPosition(next);
    };
    let frame = 0;
    const schedulePosition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updatePosition);
    };
    schedulePosition();
    window.addEventListener('resize', schedulePosition);
    document.addEventListener('scroll', schedulePosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedulePosition);
      document.removeEventListener('scroll', schedulePosition, true);
    };
  }, [align, floating, placement, openerRef, search]);

  const menuStyle: CSSProperties | undefined = !floating
    ? undefined
    : position
      ? { left: position.left, top: position.top }
      : { left: FLOATING_MARGIN, top: FLOATING_MARGIN, opacity: 0, pointerEvents: 'none' };

  const menu = (
    <Command
      ref={menuRef}
      id={id}
      /* Names the filter field: `cmdk` renders this as the input's visually hidden label. */
      label={`Search ${label.toLocaleLowerCase()}`}
      className={className}
      data-align={align}
      data-floating={floating || undefined}
      data-placement={position?.placement ?? placement}
      style={menuStyle}
      loop
    >
      <div className="director-menu-search">
        <Icon name="search" size={15} />
        <Command.Input
          ref={inputRef}
          value={search}
          onValueChange={setSearch}
          className="director-menu-search-input"
          placeholder={searchPlaceholder ?? 'Search'}
        />
      </div>
      <Command.List label={label} className="director-menu-list">
        <Command.Empty className="director-menu-empty">Nothing matches “{search}”.</Command.Empty>
        {children}
      </Command.List>
    </Command>
  );
  const portalRoot = openerRef.current?.closest<HTMLDialogElement>('dialog') ?? document.body;
  return floating ? createPortal(menu, portalRoot) : menu;
}
