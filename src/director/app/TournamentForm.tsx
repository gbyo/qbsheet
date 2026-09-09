import type { ReactNode } from 'react';
import { DateField, Field, FieldGrid, TextInput } from '../components/Fields';
import { TimeZoneField, isValidTimeZone } from '../components/TimeZoneField';

/**
 * The tournament identity form.
 *
 * # Why one component
 *
 * Creating a tournament used to be implemented twice: once on the startup
 * screen and once in the in-app `New tournament…` dialog. The two had different
 * spacing, different validation (only one trimmed the name, so a stray trailing
 * space could ride into the switcher, every export filename, and the archive
 * name), and different field affordances. Editing the same values was
 * implemented a *third* time in the tournament-details dialog and a *fourth* in
 * Settings — where the timezone was a `<datalist>` in one and a plain text
 * input in the other.
 *
 * One component now, in three modes. Startup creation, in-app creation, and
 * Settings editing are the same fields, the same validation, and the same
 * controls, because they are the same task.
 */

export interface TournamentFormValues {
  name: string;
  date: string;
  endDate: string;
  venue: string;
  organizer: string;
  questionSet: string;
  timeZone: string;
}

export function emptyTournamentForm(date: string, timeZone: string): TournamentFormValues {
  return { name: '', date, endDate: '', venue: '', organizer: '', questionSet: '', timeZone };
}

/** The default zone for a new tournament: whatever this computer is set to. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function validateTournamentForm(
  values: TournamentFormValues,
): Partial<Record<keyof TournamentFormValues, string>> {
  const errors: Partial<Record<keyof TournamentFormValues, string>> = {};
  if (!values.name.trim()) errors.name = 'Enter a tournament name.';
  if (values.timeZone && !isValidTimeZone(values.timeZone)) {
    errors.timeZone = 'Choose a timezone from the list.';
  }
  if (values.endDate && values.date && values.endDate < values.date) {
    errors.endDate = 'The end date cannot be before the start date.';
  }
  return errors;
}

/**
 * `mode="create"` shows only what a new tournament needs; `mode="edit"` adds
 * the details that come up later — an end date for multi-day events, the
 * question set, the timezone. Creation stays a four-field form because the
 * common case is a one-day event whose director wants to get to their teams.
 */
export function TournamentFields({
  values,
  onChange,
  errorFor,
  mode = 'edit',
  nameHint,
  autoFocusName = true,
  children,
}: {
  values: TournamentFormValues;
  onChange: <K extends keyof TournamentFormValues>(key: K, value: TournamentFormValues[K]) => void;
  errorFor: (key: keyof TournamentFormValues) => string | null;
  mode?: 'create' | 'edit';
  nameHint?: ReactNode;
  autoFocusName?: boolean;
  children?: ReactNode;
}) {
  return (
    <FieldGrid columns={mode === 'create' ? 'single' : 'auto'}>
      <Field
        label="Tournament name"
        error={errorFor('name')}
        hint={nameHint}
        spanAll
        render={({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            value={values.name}
            placeholder="Saturday invitational"
            data-autofocus={autoFocusName || undefined}
            onChange={(event) => onChange('name', event.target.value)}
          />
        )}
      />
      <Field
        label="Date"
        error={errorFor('date')}
        render={({ id, describedBy, invalid }) => (
          <DateField
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            value={values.date}
            onChange={(event) => onChange('date', event.target.value)}
          />
        )}
      />
      {mode === 'edit' && (
        <Field
          label="End date"
          optional
          hint="Only for events running over more than one day."
          error={errorFor('endDate')}
          render={({ id, describedBy, invalid }) => (
            <DateField
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              value={values.endDate}
              onChange={(event) => onChange('endDate', event.target.value)}
            />
          )}
        />
      )}
      <Field
        label="Venue"
        optional
        render={({ id }) => (
          <TextInput
            id={id}
            value={values.venue}
            placeholder="School or building"
            onChange={(event) => onChange('venue', event.target.value)}
          />
        )}
      />
      <Field
        label="Organizer"
        optional
        render={({ id }) => (
          <TextInput
            id={id}
            value={values.organizer}
            placeholder="Your name or organization"
            onChange={(event) => onChange('organizer', event.target.value)}
          />
        )}
      />
      {mode === 'edit' && (
        <>
          <Field
            label="Question set"
            optional
            render={({ id }) => (
              <TextInput
                id={id}
                value={values.questionSet}
                placeholder="e.g. ACF Fall 2025"
                onChange={(event) => onChange('questionSet', event.target.value)}
              />
            )}
          />
          <Field
            label="Tournament timezone"
            hint="Used for planned round times and exported schedules."
            error={errorFor('timeZone')}
            render={({ id, labelId, describedBy, invalid }) => (
              <TimeZoneField
                id={id}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
                invalid={invalid}
                value={values.timeZone}
                onChange={(zone) => onChange('timeZone', zone)}
              />
            )}
          />
        </>
      )}
      {children}
    </FieldGrid>
  );
}
