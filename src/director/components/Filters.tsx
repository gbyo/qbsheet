import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { IconButton } from './Controls';

/**
 * Page-local list filtering.
 *
 * # Why this is not the global search
 *
 * It used to be. The top-bar search box's value was threaded into the Teams
 * view as a `search` prop, so typing "Lincoln" to *navigate* to a team also
 * filtered the Teams table underneath the results popover — two different
 * intentions on one piece of state, and the page silently changed under a
 * popover the operator was reading.
 *
 * They are now separate concerns and separate controls:
 *
 *   - The top bar is a **command/entity navigator**. It finds a thing and goes
 *     there. It never changes a page's contents.
 *   - This is a **list filter**. It narrows what is on the page and does not
 *     navigate.
 */

export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name, e.g. "Filter teams". Required — this is a real control. */
  label: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`director-search-field ${className}`.trim()}>
      <Icon name="search" size={15} />
      <input
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder ?? label}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange('');
          }
        }}
      />
      {value && (
        <span className="director-search-clear">
          <IconButton
            icon="x"
            size="sm"
            label={`Clear ${label.toLocaleLowerCase()}`}
            onClick={() => onChange('')}
          />
        </span>
      )}
    </div>
  );
}

export function FilterBar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`director-filter-bar ${className}`.trim()}>{children}</div>;
}

/**
 * The bar above a list: filters left, actions right, and an honest count of
 * what the filters left behind.
 */
export function Toolbar({
  filters,
  actions,
  count,
}: {
  filters?: ReactNode;
  actions?: ReactNode;
  count?: ReactNode;
}) {
  return (
    <div className="director-toolbar">
      <div className="director-toolbar-group">
        {filters}
        {count != null && <span className="director-toolbar-count">{count}</span>}
      </div>
      {actions && <div className="director-toolbar-group">{actions}</div>}
    </div>
  );
}

/** Case- and accent-insensitive substring filtering over chosen fields. */
export function useTextFilter<T>(
  items: T[],
  query: string,
  fields: (item: T) => (string | undefined | null)[],
) {
  return useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      fields(item).some((field) => (field ?? '').toLocaleLowerCase().includes(needle)),
    );
  }, [items, query, fields]);
}

/**
 * One tab implementation, with the keyboard behaviour tabs are supposed to
 * have: Left/Right move, Home/End jump, and only the selected tab is in the tab
 * order.
 *
 * Used where a destination has peer workflows that each deserve their own view —
 * Results (needs review / games / protests / history), Standings, Transfers.
 * Anything that is really a filter over one list is a `Select`, not a tab.
 */
export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  ariaLabel,
}: {
  value: T;
  tabs: { value: T; label: ReactNode; count?: number; countTone?: 'neutral' | 'warning' | 'danger' }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const move = (delta: number) => {
    const index = tabs.findIndex((tab) => tab.value === value);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) onChange(next.value);
  };
  return (
    <div className="director-tablist" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          id={`director-tab-${tab.value}`}
          aria-selected={tab.value === value}
          aria-controls={`director-tabpanel-${tab.value}`}
          tabIndex={tab.value === value ? 0 : -1}
          className="director-tab"
          onClick={() => onChange(tab.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              move(1);
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              move(-1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              if (tabs[0]) onChange(tabs[0].value);
            } else if (event.key === 'End') {
              event.preventDefault();
              const last = tabs.at(-1);
              if (last) onChange(last.value);
            }
          }}
        >
          {tab.label}
          {tab.count != null && tab.count > 0 && (
            <span className="director-tab-count" data-tone={tab.countTone}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function TabPanel<T extends string>({ value, children }: { value: T; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={`director-tabpanel-${value}`}
      aria-labelledby={`director-tab-${value}`}
      tabIndex={0}
      className="director-stack"
    >
      {children}
    </div>
  );
}

/** Local filter state plus the reset the toolbar needs. */
export function useFilterState<T extends Record<string, string>>(initial: T) {
  const [filters, setFilters] = useState<T>(initial);
  const active = useMemo(
    () => Object.entries(filters).filter(([key, value]) => value !== initial[key]).length,
    [filters, initial],
  );
  return {
    filters,
    set: <K extends keyof T>(key: K, value: T[K]) => setFilters((current) => ({ ...current, [key]: value })),
    reset: () => setFilters(initial),
    activeCount: active,
  };
}
