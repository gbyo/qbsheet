/**
 * One menu for everything a scorekeeper does rarely.
 *
 * A row of permanent buttons for lightning, forfeits, notes and adjustments would put four rarely
 * pressed controls at the same weight as the ones pressed every question, and put a destructive one
 * a stray tap away from a scoring button.
 *
 * Only what the current format and state allow is offered: no lightning entry for a tournament
 * without lightning rounds, no "End regulation" for an untimed game that ends on a tossup count.
 */
import { useEffect, useRef, useState } from 'react';

export interface IGameMenuItem {
  label: string;
  onSelect: () => void;
  /** Rendered in red and separated from the rest. */
  destructive?: boolean;
}

export default function GameMenu(props: { items: IGameMenuItem[] }) {
  const { items } = props;
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuItems = useRef<Array<HTMLButtonElement | null>>([]);

  const focusMenuItem = (index: number) => {
    const count = items.length;
    if (count === 0) return;
    menuItems.current[(index + count) % count]?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    menuItems.current[0]?.focus();
    const onDocumentEvent = (domEvent: Event) => {
      if (domEvent instanceof KeyboardEvent) {
        if (domEvent.key === 'Escape') {
          domEvent.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
        return;
      }
      if (container.current && !container.current.contains(domEvent.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onDocumentEvent);
    document.addEventListener('mousedown', onDocumentEvent);
    return () => {
      document.removeEventListener('keydown', onDocumentEvent);
      document.removeEventListener('mousedown', onDocumentEvent);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="scorer-menu" ref={container}>
      <button
        id="scorer-game-menu-button"
        ref={trigger}
        type="button"
        className="scorer-action"
        aria-haspopup="menu"
        aria-controls="scorer-game-menu-list"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        Game
      </button>
      {open && (
        <ul
          id="scorer-game-menu-list"
          className="scorer-menu-list"
          role="menu"
          aria-labelledby="scorer-game-menu-button"
        >
          {items.map((item, index) => (
            <li key={item.label} role="none">
              <button
                type="button"
                ref={(element) => {
                  menuItems.current[index] = element;
                }}
                role="menuitem"
                className={item.destructive ? 'scorer-menu-item is-destructive' : 'scorer-menu-item'}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    focusMenuItem(index + 1);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    focusMenuItem(index - 1);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    focusMenuItem(0);
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    focusMenuItem(items.length - 1);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setOpen(false);
                    trigger.current?.focus();
                  }
                }}
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
