import { useEffect, useRef, type RefObject } from 'react';

/**
 * One Director popover menu with real menu behavior.
 *
 * Every Director menu mounts this while open, so all of them share one contract: click outside
 * closes, Escape closes and returns focus to the opener, and Up/Down/Home/End move between the
 * enabled `role="menuitem"` buttons. The shell keeps a single `openMenu` value, so opening one
 * menu always closes the other — two popovers can never strand each other.
 */
export function DirectorMenu({
  label,
  className,
  openerRef,
  onClose,
  children,
}: {
  label: string;
  className?: string;
  openerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const didInitialFocusRef = useRef(false);

  useEffect(() => {
    onCloseRef.current = onClose;
    // Keyboard-opened menus start on the first item; mouse users keep their pointer position
    // but gain arrow-key travel from wherever focus lands. Once per mount only: later parent
    // renders re-register listeners without stealing focus back.
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
  }, [onClose, openerRef]);

  return (
    <div ref={menuRef} role="menu" aria-label={label} className={className}>
      {children}
    </div>
  );
}
