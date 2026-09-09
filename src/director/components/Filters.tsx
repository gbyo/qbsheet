import { createContext, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { IconButton } from './Controls';
import { normalizeSearchText } from './search';

export { normalizeSearchText } from './search';

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
    const needle = normalizeSearchText(query.trim());
    if (!needle) return items;
    return items.filter((item) =>
      fields(item).some((field) => normalizeSearchText(field ?? '').includes(needle)),
    );
  }, [items, query, fields]);
}

const TabGroupContext = createContext<string | null>(null);

/** Provides one stable ID namespace to a tab list and its panels. */
export function TabGroup({ id, children }: { id?: string; children: ReactNode }) {
  const generatedId = useId();
  const tabsId = id ?? `director-tabs-${generatedId}`;
  return <TabGroupContext.Provider value={tabsId}>{children}</TabGroupContext.Provider>;
}

function useTabGroupId(explicitId?: string): string {
  const contextId = useContext(TabGroupContext);
  const generatedId = useId();
  return explicitId ?? contextId ?? `director-tabs-${generatedId}`;
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
  id,
}: {
  value: T;
  tabs: { value: T; label: ReactNode; count?: number; countTone?: 'neutral' | 'warning' | 'danger' }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  /** A stable, document-unique ID shared with the matching TabPanel tabsId. */
  id?: string;
}) {
  const tabsId = useTabGroupId(id);
  const selectAt = (index: number, current: HTMLButtonElement) => {
    const next = tabs[index];
    if (!next) return;
    onChange(next.value);
    current.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]').item(index)?.focus();
  };
  const move = (delta: number, current: HTMLButtonElement) => {
    const index = tabs.findIndex((tab) => tab.value === value);
    selectAt((index + delta + tabs.length) % tabs.length, current);
  };
  return (
    <div id={tabsId} className="director-tablist" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          id={`${tabsId}-tab-${tab.value}`}
          aria-selected={tab.value === value}
          aria-controls={`${tabsId}-tabpanel-${tab.value}`}
          tabIndex={tab.value === value ? 0 : -1}
          className="director-tab"
          onClick={() => onChange(tab.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              move(1, event.currentTarget);
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              move(-1, event.currentTarget);
            } else if (event.key === 'Home') {
              event.preventDefault();
              selectAt(0, event.currentTarget);
            } else if (event.key === 'End') {
              event.preventDefault();
              selectAt(tabs.length - 1, event.currentTarget);
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

export function TabPanel<T extends string>({
  value,
  children,
  tabsId,
}: {
  value: T;
  children: ReactNode;
  /** Match the id on the associated Tabs, or provide it through TabGroup. */
  tabsId?: string;
}) {
  const groupId = useTabGroupId(tabsId);
  return (
    <div
      role="tabpanel"
      id={`${groupId}-tabpanel-${value}`}
      aria-labelledby={`${groupId}-tab-${value}`}
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
