import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';
import { IconButton } from './Controls';
import { normalizeSearchText } from './search';

/**
 * Director's single-choice controls.
 *
 * # Why not `<select>`
 *
 * A native `<select>` draws its popup with the operating system. In an
 * application whose menus, dialogs, and lists are all custom, that popup is the
 * one piece of chrome that looks like it came from somewhere else — different
 * type, different metrics, different highlight colour, and on Windows a
 * different colour scheme entirely. Director had 28 of them, several inside
 * table rows, and they were the most visible reason the app read as a browser
 * form collection.
 *
 * What replaces them keeps everything the native element was actually earning:
 * a real `combobox`/`listbox` relationship, `aria-activedescendant`,
 * type-ahead, Home/End, Escape, and a label. Focus never leaves the trigger, so
 * there is no focus-restoration bug to have.
 *
 * # Select vs Combobox
 *
 * `Select` when the operator can scan the options — a packet, a room, a status
 * filter. `Combobox` when they cannot: timezones, an existing player in a
 * roster of hundreds, a school. The difference is a filter field, not a
 * different interaction model.
 */

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** A second line: the packet's source, the room's building, the zone's offset. */
  detail?: string;
  disabled?: boolean;
  /**
   * Options carrying the same group are rendered under one label, even when
   * they are not contiguous in the option list: grouping is by label, in
   * first-appearance order, so callers never need to pre-sort options.
   */
  group?: string;
}

type Placement = 'bottom' | 'top';

/** Flip the popover above the trigger when there is not room below it. */
function usePlacement(open: boolean, triggerRef: React.RefObject<HTMLElement | null>): Placement {
  const [placement, setPlacement] = useState<Placement>('bottom');
  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    setPlacement(below < 260 && rect.top > below ? 'top' : 'bottom');
  }, [open, triggerRef]);
  return placement;
}

/** Close on outside pointer-down, and on Escape, restoring focus to the trigger. */
function useDismiss(open: boolean, close: () => void, refs: React.RefObject<HTMLElement | null>[]) {
  const closeRef = useRef(close);
  useLayoutEffect(() => {
    closeRef.current = close;
  }, [close]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/**
 * Group options by label, preserving first-appearance group order and option
 * order within each group.
 *
 * Non-contiguous options sharing a label merge into one group (and separate
 * ungrouped runs merge into one ungrouped section), so every emitted group
 * key is unique and React reconciliation stays stable across filtering and
 * rerenders.
 */
function groupOptions<T extends string>(
  options: SelectOption<T>[],
): [string | undefined, SelectOption<T>[]][] {
  const groups: [string | undefined, SelectOption<T>[]][] = [];
  const indexByGroup = new Map<string | undefined, number>();
  for (const option of options) {
    const existing = indexByGroup.get(option.group);
    if (existing !== undefined) groups[existing][1].push(option);
    else {
      indexByGroup.set(option.group, groups.length);
      groups.push([option.group, [option]]);
    }
  }
  return groups;
}

function OptionRow<T extends string>({
  option,
  id,
  selected,
  active,
  onSelect,
  multi = false,
}: {
  option: SelectOption<T>;
  id: string;
  selected: boolean;
  active: boolean;
  onSelect: (value: T) => void;
  multi?: boolean;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={option.disabled || undefined}
      className="director-select-option"
      data-active={active || undefined}
      onPointerDown={(event) => {
        // Pointer-down rather than click so the trigger never loses focus.
        event.preventDefault();
        if (!option.disabled) onSelect(option.value);
      }}
    >
      <span>
        {option.label}
        {option.detail && <small>{option.detail}</small>}
      </span>
      {(selected || multi) && (
        <span className="director-select-option-check" aria-hidden="true">
          {selected ? <Icon name="check" size={15} /> : null}
        </span>
      )}
    </div>
  );
}

export function Select<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled = false,
  size = 'md',
  id,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  invalid = false,
  className = '',
  /** Rendered instead of the selected option's label — for a richer trigger. */
  renderValue,
}: {
  value: T | '' | null | undefined;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  invalid?: boolean;
  className?: string;
  renderValue?: (option: SelectOption<T> | undefined) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const optionIdBase = useId();
  const selected = options.find((option) => option.value === value);
  const enabled = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const [activeValue, setActiveValue] = useState<T | null>(null);
  const placement = usePlacement(open, triggerRef);
  const typeahead = useRef({ buffer: '', at: 0 });

  const close = useCallback(() => {
    setOpen(false);
    setActiveValue(null);
  }, []);
  useDismiss(open, close, [triggerRef, popoverRef]);

  const activeIndex = activeValue ? enabled.findIndex((option) => option.value === activeValue) : -1;
  const optionId = (option: SelectOption<T>) => `${optionIdBase}-${option.value}`;

  const openWith = (initial: T | null) => {
    if (disabled) return;
    setActiveValue(initial ?? (selected?.value as T) ?? enabled[0]?.value ?? null);
    setOpen(true);
  };

  const commit = (next: T) => {
    onChange(next);
    close();
    triggerRef.current?.focus({ preventScroll: true });
  };

  const move = (delta: number) => {
    if (!enabled.length) return;
    const from = activeIndex >= 0 ? activeIndex : enabled.findIndex((o) => o.value === value);
    const next = (from + delta + enabled.length) % enabled.length;
    setActiveValue(enabled[next]?.value ?? null);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        event.preventDefault();
        openWith(null);
      }
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close();
        triggerRef.current?.focus({ preventScroll: true });
        return;
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Home':
        event.preventDefault();
        setActiveValue(enabled[0]?.value ?? null);
        return;
      case 'End':
        event.preventDefault();
        setActiveValue(enabled.at(-1)?.value ?? null);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (activeValue) commit(activeValue);
        return;
      case 'Tab':
        close();
        return;
      default:
        break;
    }
    // Type-ahead, the way a native select behaves: repeated keys inside a short
    // window extend the search rather than restarting it.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const state = typeahead.current;
      state.buffer = now - state.at > 800 ? event.key : state.buffer + event.key;
      state.at = now;
      const needle = normalizeSearchText(state.buffer);
      const match =
        enabled.find((option) => normalizeSearchText(option.label).startsWith(needle)) ??
        enabled.find((option) => normalizeSearchText(option.label).includes(needle));
      if (match) {
        event.preventDefault();
        setActiveValue(match.value);
      }
    }
  };

  // Keep the active option in view during keyboard travel.
  useEffect(() => {
    if (!open || !activeValue) return;
    popoverRef.current
      ?.querySelector<HTMLElement>(`[data-active="true"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeValue]);

  const triggerContent = renderValue ? renderValue(selected) : (selected?.label ?? placeholder);

  return (
    <div
      className={['director-select', size === 'sm' ? 'director-select-sm' : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="director-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeValue ? `${optionIdBase}-${activeValue}` : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
        data-placeholder={!selected || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openWith(null))}
        onKeyDown={onKeyDown}
      >
        <span>{triggerContent}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div
          ref={popoverRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : ariaLabelledBy}
          className="director-select-popover"
          data-placement={placement}
        >
          {options.length === 0 && <p className="director-combobox-empty">No options available.</p>}
          {groupOptions(options).map(([group, groupItems]) => (
            <div key={group ?? '_'} role={group ? 'group' : undefined} aria-label={group}>
              {group && <p className="director-select-group-label">{group}</p>}
              {groupItems.map((option) => (
                <OptionRow
                  key={option.value}
                  option={option}
                  id={optionId(option)}
                  selected={option.value === value}
                  active={option.value === activeValue}
                  onSelect={commit}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A searchable single-choice control.
 *
 * The input *is* the combobox: typing filters, arrows travel, Enter commits,
 * Escape reverts to the committed value. Used for timezones (hundreds of
 * options), existing players during roster reconciliation, and schools/clubs —
 * all places that previously used either a `<datalist>`, whose popup is
 * browser-drawn and unstyleable, or a raw `<select>` the operator had to scroll.
 */
export function Combobox<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = 'Search…',
  disabled = false,
  id,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  invalid = false,
  allowClear = false,
  emptyMessage = 'No matches.',
  className = '',
}: {
  value: T | '' | null | undefined;
  options: SelectOption<T>[];
  onChange: (value: T | '') => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  invalid?: boolean;
  allowClear?: boolean;
  emptyMessage?: string;
  className?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const optionIdBase = useId();
  const placement = usePlacement(open, wrapRef);

  const filtered = useMemo(() => {
    const needle = normalizeSearchText(query.trim());
    if (!needle) return options;
    return options.filter(
      (option) =>
        normalizeSearchText(option.label).includes(needle) ||
        normalizeSearchText(option.value).includes(needle) ||
        normalizeSearchText(option.detail ?? '').includes(needle),
    );
  }, [options, query]);
  const enabled = useMemo(() => filtered.filter((option) => !option.disabled), [filtered]);
  const [pendingActive, setPendingActive] = useState<T | null>(null);
  /*
   * The highlighted option is derived, not stored.
   *
   * Filtering can remove whatever was highlighted, and resetting it from an
   * effect meant an extra render on every keystroke. Instead the stored value
   * is only honoured while it still matches something, and the first result is
   * the highlight otherwise — which is also the behaviour a filter should have.
   */
  const activeValue: T | null =
    pendingActive && enabled.some((option) => option.value === pendingActive)
      ? pendingActive
      : (enabled[0]?.value ?? null);
  const setActiveValue = setPendingActive;
  const activeIndex = activeValue ? enabled.findIndex((option) => option.value === activeValue) : -1;

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setPendingActive(null);
  }, []);
  useDismiss(open, close, [wrapRef, popoverRef]);

  const commit = (next: T) => {
    onChange(next);
    close();
    inputRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (!enabled.length) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = (activeIndex + delta + enabled.length) % enabled.length;
      setActiveValue(enabled[next]?.value ?? null);
      return;
    }
    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActiveValue(enabled[0]?.value ?? null);
      return;
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      setActiveValue(enabled.at(-1)?.value ?? null);
      return;
    }
    if (event.key === 'Enter') {
      if (open && activeValue) {
        event.preventDefault();
        commit(activeValue);
      }
      return;
    }
    if (event.key === 'Tab') close();
  };

  useEffect(() => {
    if (!open || !activeValue) return;
    popoverRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeValue]);

  return (
    <div ref={wrapRef} className={`director-select ${className}`.trim()}>
      <div className="director-combobox-field">
        <Icon name="search" size={15} />
        <input
          ref={inputRef}
          id={id}
          className={`director-input ${invalid ? 'director-input-invalid' : ''}`.trim()}
          role="combobox"
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && activeValue ? `${optionIdBase}-${activeValue}` : undefined}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          placeholder={selected ? selected.label : placeholder}
          value={open ? query : (selected?.label ?? '')}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {allowClear && selected && !disabled && (
          <span className="director-combobox-clear">
            <IconButton
              icon="x"
              size="sm"
              label={`Clear ${ariaLabel ?? 'selection'}`}
              onClick={() => {
                onChange('');
                close();
              }}
            />
          </span>
        )}
      </div>
      {open && (
        <div
          ref={popoverRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel ? 'Available organization options' : undefined}
          aria-labelledby={ariaLabel ? undefined : ariaLabelledBy}
          className="director-select-popover"
          data-placement={placement}
        >
          {filtered.length === 0 ? (
            <p className="director-combobox-empty">{emptyMessage}</p>
          ) : (
            groupOptions(filtered).map(([group, groupItems]) => (
              <div key={group ?? '_'} role={group ? 'group' : undefined} aria-label={group}>
                {group && <p className="director-select-group-label">{group}</p>}
                {groupItems.map((option) => (
                  <OptionRow
                    key={option.value}
                    option={option}
                    id={`${optionIdBase}-${option.value}`}
                    selected={option.value === value}
                    active={option.value === activeValue}
                    onSelect={commit}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
