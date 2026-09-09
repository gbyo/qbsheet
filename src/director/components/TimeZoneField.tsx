import { useMemo } from 'react';
import { Combobox, type SelectOption } from './Select';

/**
 * A searchable, validated timezone chooser.
 *
 * # What it replaces
 *
 * Two different controls for the same value: a `<datalist>`-backed text input
 * in Settings — whose suggestion popup is drawn by the browser, cannot be
 * styled, and silently accepts anything typed — and a plain text input in the
 * tournament-details dialog, which accepted `Chicago` or `EST5EDT` or a typo
 * with equal enthusiasm.
 *
 * The list comes from `Intl.supportedValuesOf('timeZone')` where the engine
 * offers it, so it is the platform's real zone list rather than a hard-coded
 * subset. Each option carries its current offset, because "America/Phoenix" is
 * only meaningful to someone who already knows what it means. The tournament's
 * current zone is always present and labelled even if the runtime does not list
 * it, so an imported tournament never loses its zone by being opened on a
 * different machine.
 */

function offsetLabel(zone: string, reference: Date): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(reference);
    return parts.find((part) => part.type === 'timeZoneName')?.value;
  } catch {
    return undefined;
  }
}

export function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.('timeZone');
    if (zones && zones.length) return zones;
  } catch {
    // Falls through to the short list below.
  }
  // A deliberately small fallback for engines without `supportedValuesOf`: the
  // zones a North American quiz bowl tournament is actually run in, plus UTC.
  return [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
    'America/Toronto',
    'America/Vancouver',
    'Europe/London',
    'Europe/Berlin',
    'Asia/Kolkata',
    'Asia/Singapore',
    'Australia/Sydney',
  ];
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function TimeZoneField({
  value,
  onChange,
  id,
  ariaLabel = 'Tournament timezone',
  ariaLabelledBy,
  ariaDescribedBy,
  invalid = false,
  disabled = false,
}: {
  value: string;
  onChange: (zone: string) => void;
  id?: string;
  ariaLabel?: string;
  /** The field's own label, so the popover is named by it rather than nothing. */
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const options = useMemo<SelectOption[]>(() => {
    const now = new Date();
    const zones = supportedTimeZones();
    const withCurrent = zones.includes(value) || !value ? zones : [value, ...zones];
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return withCurrent.map((zone) => {
      const offset = offsetLabel(zone, now);
      const notes = [offset, zone === local ? 'this computer' : null].filter(Boolean).join(' · ');
      return {
        value: zone,
        label: zone.replaceAll('_', ' '),
        detail: notes || undefined,
        group: zone.includes('/') ? zone.split('/')[0]?.replaceAll('_', ' ') : 'Other',
      };
    });
  }, [value]);

  return (
    <Combobox
      value={value}
      options={options}
      onChange={(next) => onChange(next || value)}
      id={id}
      ariaLabel={ariaLabelledBy ? undefined : ariaLabel}
      ariaLabelledBy={ariaLabelledBy}
      ariaDescribedBy={ariaDescribedBy}
      invalid={invalid}
      disabled={disabled}
      placeholder="Search timezones…"
      emptyMessage="No timezone matches that. Try a city or region."
    />
  );
}
