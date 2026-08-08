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

  useEffect(() => {
    if (!open) return undefined;
    const onDocumentEvent = (domEvent: Event) => {
      if (domEvent instanceof KeyboardEvent) {
        if (domEvent.key === 'Escape') setOpen(false);
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
        type="button"
        className="scorer-action"
        aria-haspopup="menu"
        aria-controls="scorer-game-menu-list"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Game
      </button>
      {open && (
        <ul id="scorer-game-menu-list" className="scorer-menu-list" role="menu">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                className={item.destructive ? 'scorer-menu-item is-destructive' : 'scorer-menu-item'}
                onClick={() => {
                  setOpen(false);
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
