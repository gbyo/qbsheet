import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Command } from 'cmdk';
import { Icon } from './Icon';

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

  return (
    <Command
      ref={menuRef}
      id={id}
      /* Names the filter field: `cmdk` renders this as the input's visually hidden label. */
      label={`Search ${label.toLocaleLowerCase()}`}
      className={className}
      data-align={align}
      data-placement={placement}
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
}
