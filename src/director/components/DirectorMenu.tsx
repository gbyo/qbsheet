import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * One Director popover menu with real menu behavior.
 *
 * Every Director menu mounts this while open, so all of them share one contract: click outside
 * closes, Escape closes and returns focus to the opener, Tab closes without intercepting normal
 * keyboard travel, and Up/Down/Home/End move between the enabled `role="menuitem"` buttons. The
 * shell keeps a single `openMenu` value, so opening one menu always closes the other — two popovers
 * can never strand each other.
 */
export function DirectorMenu({
  label,
  className,
  id,
  align = 'start',
  placement = 'bottom',
  openerRef,
  onClose,
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
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const didInitialFocusRef = useRef(false);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    // Keyboard-opened menus start on the first item; mouse users keep their pointer position
    // but gain arrow-key travel from wherever focus lands. Once per mount only: later parent
    // renders do not steal focus back.
    if (!didInitialFocusRef.current) {
      didInitialFocusRef.current = true;
      menuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
        ?.focus({ preventScroll: true });
    }
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
        onCloseRef.current();
        openerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'Tab') {
        // A menu is a temporary surface. Let the browser perform ordinary Tab/Shift+Tab travel,
        // but dismiss the surface first so focus never moves behind a popover that remains open.
        onCloseRef.current();
        return;
      }
      if (
        event.key !== 'ArrowDown' &&
        event.key !== 'ArrowUp' &&
        event.key !== 'Home' &&
        event.key !== 'End'
      ) {
        return;
      }
      const items = menuRef.current
        ? Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'))
        : [];
      if (items.length === 0) return;
      event.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      const index = active ? items.indexOf(active) : -1;
      const next =
        event.key === 'ArrowDown'
          ? items[(index + 1) % items.length]
          : event.key === 'ArrowUp'
            ? items[(index - 1 + items.length) % items.length]
            : event.key === 'Home'
              ? items[0]
              : items[items.length - 1];
      next?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [openerRef]);

  return (
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label={label}
      className={className}
      data-align={align}
      data-placement={placement}
    >
      {children}
    </div>
  );
}
