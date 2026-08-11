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
import { Fragment, useEffect, useRef, useState } from 'react';
import ControlIcon, { type ControlIconName } from './ControlIcon';

export interface IGameMenuItem {
  label: string;
  icon: ControlIconName;
  onSelect: () => void;
  /** Rendered in red and separated from the rest. */
  destructive?: boolean;
  /**
   * Draw a rule above this entry.
   *
   * A line and not a heading. The groups here are obvious once they are apart — files with files,
   * the two things that end a game with each other — and naming them would put five pieces of
   * permanent text in a menu whose entries are the only thing anybody is reading. It is also not a
   * submenu: a rare action that has been filed inside a second level is a rare action a scorekeeper
   * has to remember the filing of, at the one moment they are least able to.
   */
  dividerBefore?: boolean;
}

/**
 * Lay groups out in one list, ruled between the ones that survived.
 *
 * Which groups exist depends on the format and the state — an untimed game has no End regulation, a
 * finished one has nothing left to end — so the rules cannot be decided when the entries are
 * written. Deciding here means a divider is only ever drawn where something above it and something
 * below it both actually rendered, and an empty group leaves no trace at all rather than a doubled
 * line or one hanging off the top.
 */
export function joinMenuGroups(groups: ReadonlyArray<readonly IGameMenuItem[]>): IGameMenuItem[] {
  const joined: IGameMenuItem[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    const needsRule = joined.length > 0;
    group.forEach((item, index) => {
      joined.push(needsRule && index === 0 ? { ...item, dividerBefore: true } : item);
    });
  }
  return joined;
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
        <ControlIcon name="game" />
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
            <Fragment key={item.label}>
              {/*
                A rule, and nothing that can be reached. `role="separator"` is what tells assistive
                technology this is a grouping mark rather than a thing to do, and it is deliberately
                outside the `menuItems` refs below: arrow keys, Home and End walk the entries only,
                because a menu that made somebody press Down twice to get past a line would have made
                the line a control.
              */}
              {item.dividerBefore && index > 0 && (
                <li role="separator" className="scorer-menu-separator" aria-orientation="horizontal" />
              )}
              <li role="none">
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
                  <ControlIcon name={item.icon} />
                  <span>{item.label}</span>
                </button>
              </li>
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
