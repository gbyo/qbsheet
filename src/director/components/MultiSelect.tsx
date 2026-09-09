import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Button } from './Controls';
import { Checkbox } from './Choice';
import type { SelectOption } from './Select';
import { normalizeSearchText } from './search';

/**
 * Searchable multi-selection.
 *
 * # What this replaced
 *
 * `<select multiple size={4}>`. Director used one of those to pick the audience
 * for a QBSheet Live announcement — a four-row scrolling box, in a tournament
 * that may have forty teams, where deselecting required knowing to hold a
 * modifier key, and where nothing on screen said which teams were chosen.
 * The same control also stood in for day-event target teams, which for a large
 * field became an unstructured wall of checkboxes.
 *
 * What is here instead: a trigger showing the actual selection as tags, a
 * filter field, a checklist, and an explicit "Everybody"/"Select all" default.
 * Underneath, every row is a real checkbox in a labelled group, so the
 * selection is announced and reachable by keyboard.
 *
 * # The "all" affordance
 *
 * Most audiences are everybody, and most target-team sets are everybody, so an
 * empty selection *means* everybody and says so on the trigger. `allLabel`
 * names it in the operator's terms.
 */

export function MultiSelect<T extends string = string>({
  values,
  options,
  onChange,
  placeholder = 'Select…',
  /** Shown when nothing is selected and an empty selection means "all". */
  allLabel,
  searchPlaceholder = 'Filter…',
  emptyMessage = 'No matches.',
  disabled = false,
  id,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  maxTags = 3,
  className = '',
}: {
  values: T[];
  options: SelectOption<T>[];
  onChange: (values: T[]) => void;
  placeholder?: string;
  allLabel?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  maxTags?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popoverId = useId();
  const groupLabelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (wrapRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close]);

  const selected = useMemo(() => new Set(values), [values]);
  const filtered = useMemo(() => {
    const needle = normalizeSearchText(query.trim());
    if (!needle) return options;
    return options.filter(
      (option) =>
        normalizeSearchText(option.label).includes(needle) ||
        normalizeSearchText(option.detail ?? '').includes(needle),
    );
  }, [options, query]);

  const toggle = (value: T) => {
    if (options.find((option) => option.value === value)?.disabled) return;
    onChange(selected.has(value) ? values.filter((entry) => entry !== value) : [...values, value]);
  };

  const enabledOptions = options.filter((option) => !option.disabled);
  const selectedOptions = options.filter((option) => selected.has(option.value));
  const selectedEnabledOptions = enabledOptions.filter((option) => selected.has(option.value));
  const hasUnselectedEnabledOptions = enabledOptions.some((option) => !selected.has(option.value));
  const shownTags = selectedOptions.slice(0, maxTags);
  const overflow = selectedOptions.length - shownTags.length;

  const summary =
    selectedOptions.length === 0 ? (allLabel ?? placeholder) : `${selectedOptions.length} selected`;

  return (
    <div ref={wrapRef} className={`director-select ${className}`.trim()}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="director-multiselect-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={ariaLabel ? `${ariaLabel}: ${summary}` : undefined}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {selectedOptions.length === 0 ? (
          allLabel ? (
            <span className="director-multiselect-tags">
              <span className="director-tag director-tag-all">
                <Icon name="users" size={12} />
                <span>{allLabel}</span>
              </span>
            </span>
          ) : (
            <span className="director-multiselect-placeholder">{placeholder}</span>
          )
        ) : (
          <span className="director-multiselect-tags">
            {shownTags.map((option) => (
              <span className="director-tag" key={option.value}>
                <span>{option.label}</span>
              </span>
            ))}
            {overflow > 0 && (
              <span className="director-tag">
                <span>+{overflow} more</span>
              </span>
            )}
          </span>
        )}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          className="director-multiselect-popover"
          data-placement="bottom"
          role="dialog"
          aria-label={ariaLabelledBy ? undefined : (ariaLabel ?? 'Selection')}
          aria-labelledby={ariaLabelledBy}
        >
          <div className="director-combobox-search">
            <div className="director-search-field">
              <Icon name="search" size={15} />
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <div className="director-multiselect-list" role="group" aria-labelledby={groupLabelId}>
            <span id={groupLabelId} className="director-visually-hidden">
              {ariaLabel ?? 'Options'}
            </span>
            {filtered.length === 0 ? (
              <p className="director-combobox-empty">{emptyMessage}</p>
            ) : (
              filtered.map((option) => (
                <Checkbox
                  key={option.value}
                  checked={selected.has(option.value)}
                  disabled={option.disabled}
                  label={option.label}
                  hint={option.detail}
                  onChange={() => toggle(option.value)}
                />
              ))
            )}
          </div>
          <div className="director-multiselect-footer">
            <span className="director-text-meta">
              {selectedOptions.length === 0 && allLabel
                ? allLabel
                : `${selectedEnabledOptions.length} of ${enabledOptions.length} selected`}
            </span>
            <div className="director-actions">
              {values.length > 0 && (
                <Button variant="quiet" size="sm" onClick={() => onChange([])}>
                  {allLabel ? `Reset to ${allLabel.toLocaleLowerCase()}` : 'Clear'}
                </Button>
              )}
              {hasUnselectedEnabledOptions && (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => onChange(enabledOptions.map((option) => option.value))}
                >
                  Select all
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  close();
                  triggerRef.current?.focus({ preventScroll: true });
                }}
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * An always-visible searchable checklist.
 *
 * The same selection model as `MultiSelect` without the popover, for the cases
 * where the selection is the point of the surface rather than one field in a
 * form — picking which teams a lunch break applies to, choosing export
 * contents. Scrolls internally rather than growing into a wall.
 */
export function Checklist<T extends string = string>({
  values,
  options,
  onChange,
  searchPlaceholder = 'Filter…',
  emptyMessage = 'No matches.',
  legend,
  hint,
  columns = false,
  allLabel,
  searchThreshold = 8,
}: {
  values: T[];
  options: SelectOption<T>[];
  onChange: (values: T[]) => void;
  searchPlaceholder?: string;
  emptyMessage?: string;
  legend: ReactNode;
  hint?: ReactNode;
  columns?: boolean;
  allLabel?: string;
  /** Below this many options the filter field is noise, so it is not rendered. */
  searchThreshold?: number;
}) {
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(values), [values]);
  const filtered = useMemo(() => {
    const needle = normalizeSearchText(query.trim());
    if (!needle) return options;
    return options.filter((option) => normalizeSearchText(option.label).includes(needle));
  }, [options, query]);
  const showSearch = options.length >= searchThreshold;

  return (
    <fieldset className="director-fieldset">
      <legend>{legend}</legend>
      {hint && <p className="director-field-hint">{hint}</p>}
      {showSearch && (
        <div className="director-search-field director-checklist-search">
          <Icon name="search" size={15} />
          <input
            type="search"
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {allLabel && (
        <Checkbox
          checked={values.length === 0}
          label={allLabel}
          onChange={(next) => {
            if (next) onChange([]);
          }}
        />
      )}
      <div className={columns ? 'director-choice-list-columns' : 'director-choice-list'}>
        {filtered.length === 0 ? (
          <p className="director-field-hint">{emptyMessage}</p>
        ) : (
          filtered.map((option) => (
            <Checkbox
              key={option.value}
              checked={selected.has(option.value)}
              disabled={option.disabled}
              label={option.label}
              hint={option.detail}
              onChange={() =>
                onChange(
                  selected.has(option.value)
                    ? values.filter((entry) => entry !== option.value)
                    : [...values, option.value],
                )
              }
            />
          ))
        )}
      </div>
      {options.length > 0 && (
        <p className="director-field-hint">
          {values.length === 0 && allLabel ? allLabel : `${values.length} of ${options.length} selected`}
        </p>
      )}
    </fieldset>
  );
}
