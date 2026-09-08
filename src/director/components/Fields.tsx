import {
  cloneElement,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon } from './Icon';

/**
 * Fields, validation, and save semantics.
 *
 * # The save contract, stated once
 *
 * Director used to save on blur in some places, on change in others, on an
 * explicit Save in others, and instantly for operational actions — with nothing
 * telling the operator which they were looking at. The rules now:
 *
 *   1. **Forms** (dialogs, settings sections) collect changes and commit on
 *      Save. While they are dirty they say so, and Cancel/Escape discards.
 *      Enter submits.
 *   2. **Inline edits** are for a single low-risk field — renaming a round,
 *      a score cell. They commit on blur or Enter, revert on Escape, and
 *      confirm visibly that they committed.
 *   3. **Operations** apply immediately and are `Switch`es or buttons, never
 *      checkboxes in a form.
 *
 * `useFormState` implements (1); `InlineEdit` implements (2); `Switch` in
 * `Choice.tsx` implements (3).
 */

export function Field({
  label,
  children,
  hint,
  error,
  optional = false,
  htmlFor,
  spanAll = false,
  /**
   * Render-prop form, for controls that take their ids as props — the custom
   * `Select`, `Combobox`, `MultiSelect`, and `TimeZoneField`.
   *
   * Plain `children` are the common case and are wired up automatically: a
   * single element child has `id`, `aria-describedby`, and `aria-invalid`
   * injected, so `<Field label="Room name"><TextInput …/></Field>` is properly
   * labelled without every call site repeating the plumbing.
   */
  render,
}: {
  label: ReactNode;
  children?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  htmlFor?: string;
  spanAll?: boolean;
  render?: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const generated = useId();
  const id = htmlFor ?? generated;
  const hintId = `${generated}-hint`;
  const errorId = `${generated}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  /*
   * Without this, a `children` field rendered a `<label for=…>` pointing at an
   * id nothing carried: visually a labelled field, but an unlabelled control to
   * a screen reader, and unreachable via `getByLabelText`. Cloning is the least
   * invasive fix — a child that already sets its own `id` keeps it.
   */
  const labelled =
    !render && isValidElement(children)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          id: (children.props as { id?: string }).id ?? id,
          'aria-describedby':
            (children.props as { ['aria-describedby']?: string })['aria-describedby'] ?? describedBy,
          'aria-invalid':
            (children.props as { ['aria-invalid']?: boolean })['aria-invalid'] ?? (error ? true : undefined),
        })
      : children;

  return (
    <div className={`director-field ${spanAll ? 'director-field-span-all' : ''}`.trim()}>
      <label className="director-field-label" htmlFor={id}>
        <span>{label}</span>
        {optional && <span className="director-field-optional">optional</span>}
      </label>
      {render ? render({ id, describedBy, invalid: Boolean(error) }) : labelled}
      {error ? (
        <p className="director-field-error" id={errorId}>
          <Icon name="danger" size={13} />
          {error}
        </p>
      ) : (
        hint && (
          <p className="director-field-hint" id={hintId}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function TextInput({ invalid, className = '', ...rest }, ref) {
  return (
    <input
      {...rest}
      ref={ref}
      className={['director-input', invalid ? 'director-input-invalid' : '', className]
        .filter(Boolean)
        .join(' ')}
      aria-invalid={invalid || undefined}
    />
  );
});

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function TextArea({ invalid, className = '', ...rest }, ref) {
  return (
    <textarea
      {...rest}
      ref={ref}
      className={['director-textarea', invalid ? 'director-input-invalid' : '', className]
        .filter(Boolean)
        .join(' ')}
      aria-invalid={invalid || undefined}
    />
  );
});

/** Right-aligned tabular figures, so columns of numbers line up. */
export const NumberInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function NumberInput({ invalid, className = '', ...rest }, ref) {
  return (
    <input
      {...rest}
      ref={ref}
      type="number"
      inputMode="numeric"
      className={[
        'director-input',
        'director-input-numeric',
        invalid ? 'director-input-invalid' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-invalid={invalid || undefined}
    />
  );
});

/**
 * Date and time entry.
 *
 * These keep `type="date"` / `type="time"`. The platform picker is genuinely
 * better than a hand-built calendar — it knows the locale, the first day of the
 * week, and the keyboard conventions of the OS — and unlike a `<select>` popup
 * it is a transient overlay rather than a permanent part of the page's
 * appearance. The field chrome around it is Director's.
 */
export const DateField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function DateField({ invalid, className = '', ...rest }, ref) {
  return (
    <input
      {...rest}
      ref={ref}
      type="date"
      className={['director-input', invalid ? 'director-input-invalid' : '', className]
        .filter(Boolean)
        .join(' ')}
      aria-invalid={invalid || undefined}
    />
  );
});

export const TimeField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function TimeField({ invalid, className = '', ...rest }, ref) {
  return (
    <input
      {...rest}
      ref={ref}
      type="time"
      className={['director-input', invalid ? 'director-input-invalid' : '', className]
        .filter(Boolean)
        .join(' ')}
      aria-invalid={invalid || undefined}
    />
  );
});

/** A responsive grid of fields. `columns="single"` for dialogs. */
export function FieldGrid({
  children,
  columns = 'auto',
}: {
  children: ReactNode;
  columns?: 'auto' | 'single';
}) {
  return (
    <div className={`director-form-grid ${columns === 'single' ? 'director-form-grid-single' : ''}`.trim()}>
      {children}
    </div>
  );
}

/** Cancel then primary, right-aligned. The only form action order in Director. */
export function FormActions({
  children,
  state,
}: {
  children: ReactNode;
  /** Optional save-state note, shown at the left of the row. */
  state?: ReactNode;
}) {
  return (
    <div className="director-form-actions">
      {state}
      {children}
    </div>
  );
}

/**
 * Says whether a change has been committed.
 *
 * The point of the redesign's save rules is that the operator never has to
 * guess, which requires actually telling them. `dirty` while a form has
 * uncommitted changes; `saved` briefly after a commit.
 */
export function SaveState({ state }: { state: 'clean' | 'dirty' | 'saved' | 'saving' }) {
  if (state === 'clean') return null;
  const text = state === 'dirty' ? 'Unsaved changes' : state === 'saving' ? 'Saving…' : 'Saved';
  return (
    <span className="director-save-state" data-state={state} role="status">
      {state === 'saved' && <Icon name="check" size={13} />}
      {text}
    </span>
  );
}

/** A validation summary above a form's fields. Focusable so errors can be announced. */
export function FormErrors({ errors, title }: { errors: string[]; title?: string }) {
  if (!errors.length) return null;
  return (
    <div className="director-form-errors" role="alert" tabIndex={-1}>
      <strong>{title ?? (errors.length === 1 ? 'Fix this before saving' : 'Fix these before saving')}</strong>
      <ul>
        {errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Form state with the Director save contract built in.
 *
 * Holds a draft, reports whether it differs from the committed value, validates
 * on submit, and reports `saved` for a moment afterwards so the operator sees
 * the commit land.
 */
export function useFormState<T extends object>({
  initial,
  validate,
  onSubmit,
}: {
  initial: T;
  validate?: (draft: T) => Partial<Record<keyof T, string>> & { _form?: string[] };
  onSubmit: (draft: T) => boolean | void;
}) {
  const [draft, setDraft] = useState<T>(initial);
  const [touched, setTouched] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>> & { _form?: string[] }>({});
  const [saved, setSaved] = useState(false);
  // The committed baseline lives in state, not a ref, so `dirty` is a pure
  // comparison of two rendered values.
  const [committed, setCommitted] = useState<T>(initial);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(committed), [draft, committed]);

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  }, []);

  const reset = useCallback((next?: T) => {
    setCommitted((current) => {
      const base = next ?? current;
      setDraft(base);
      return base;
    });
    setErrors({});
    setTouched(false);
  }, []);

  const submit = useCallback(() => {
    setTouched(true);
    const found = validate?.(draft) ?? {};
    const hasError = Object.entries(found).some(([key, value]) =>
      key === '_form' ? Array.isArray(value) && value.length > 0 : Boolean(value),
    );
    setErrors(found);
    if (hasError) return false;
    const ok = onSubmit(draft);
    if (ok === false) return false;
    setCommitted(draft);
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 2400);
    return true;
  }, [draft, onSubmit, validate]);

  const formErrors = errors._form ?? [];
  return {
    draft,
    set,
    setDraft,
    reset,
    submit,
    dirty,
    touched,
    errors,
    formErrors,
    saveState: (saved ? 'saved' : dirty ? 'dirty' : 'clean') as 'clean' | 'dirty' | 'saved',
    errorFor: <K extends keyof T>(key: K) => (touched ? ((errors[key] as string | undefined) ?? null) : null),
  };
}

/**
 * Inline editing, for the cases the edit model allows it: one field, low risk,
 * one step. Anything larger goes in a dialog.
 *
 * Commits on blur and on Enter; Escape reverts and restores the previous value.
 * The commit is confirmed visibly rather than silently, because a value that
 * saved on blur with no feedback is indistinguishable from one that did not.
 */
export function InlineEdit({
  value,
  onCommit,
  label,
  placeholder,
  disabled = false,
  numeric = false,
  className = '',
}: {
  value: string;
  onCommit: (next: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  numeric?: boolean;
  className?: string;
}) {
  // While the field has focus the operator owns the text; the rest of the time
  // the committed value does. Deriving that avoids syncing state from an effect
  // and, with it, the class of bug where an external update is swallowed
  // because the field happened to be mounted.
  const [editingDraft, setEditingDraft] = useState<string | null>(null);
  const shown = editingDraft ?? value;
  const commit = () => {
    const trimmed = (editingDraft ?? value).trim();
    setEditingDraft(null);
    if (trimmed && trimmed !== value) onCommit(trimmed);
  };
  return (
    <input
      className={['director-input', 'director-input-sm', numeric ? 'director-input-numeric' : '', className]
        .filter(Boolean)
        .join(' ')}
      aria-label={label}
      value={shown}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => setEditingDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setEditingDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
