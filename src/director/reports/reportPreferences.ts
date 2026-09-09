import {
  defaultReportOptions,
  normalizeReportOptions,
  type ReportOptions,
} from '@qbsheet/tournament-formats';

const reportPreferenceVersion = 1;
const reportPreferencePrefix = `qbsheet:report-options:v${reportPreferenceVersion}:`;

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function reportPreferenceKey(tournamentId: string): string {
  return `${reportPreferencePrefix}${tournamentId}`;
}

/**
 * Report options are operator/UI preferences, not tournament facts. They live in localStorage so
 * changing a visible column cannot create an audit event, alter competitive state, or travel in a
 * tournament archive. The tournament id scopes the preference to the event on this Director.
 */
export function loadReportOptions(
  tournamentId: string,
  storage: PreferenceStorage | null = browserStorage(),
): ReportOptions {
  if (!tournamentId || !storage) return { ...defaultReportOptions, pages: [...defaultReportOptions.pages] };
  try {
    const raw = storage.getItem(reportPreferenceKey(tournamentId));
    return raw
      ? normalizeReportOptions(JSON.parse(raw))
      : { ...defaultReportOptions, pages: [...defaultReportOptions.pages] };
  } catch {
    return { ...defaultReportOptions, pages: [...defaultReportOptions.pages] };
  }
}

export function saveReportOptions(
  tournamentId: string,
  options: ReportOptions,
  storage: PreferenceStorage | null = browserStorage(),
): ReportOptions {
  const normalized = normalizeReportOptions(options);
  if (!tournamentId || !storage) return normalized;
  try {
    storage.setItem(reportPreferenceKey(tournamentId), JSON.stringify(normalized));
  } catch {
    // A blocked/full localStorage must not block exporting the tournament with the chosen options.
  }
  return normalized;
}
