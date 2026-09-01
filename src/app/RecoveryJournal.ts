/**
 * Read-only inspection of QBSheet's synchronous game journal.
 *
 * `loadGame` intentionally collapses malformed, unsupported, and stale data into `null` so the
 * scorer can start conservatively. Recovery Mode has a different job: it must tell a scorekeeper
 * whether a raw entry exists and why it was not trusted, without changing what normal startup does.
 * This module therefore validates the same known fields, but never writes or clears anything.
 */
import {
  exportJournals,
  gameSessionMaxAgeMs,
  gameSessionVersion,
  legacyGameSessionVersion,
} from '../scorer/GameSession';
import type { IGameSetup } from '../scoring/deriveGame';
import type { ScoreEvent } from '../scoring/ScoreEvents';
import { validEvent, validSetup } from '../scorer/ScorerRecovery';

export type JournalInspectionStatus = 'valid' | 'stale' | 'unsupported' | 'malformed';

export interface IJournalInspection {
  /** Internal journal identity. Recovery UI deliberately does not render this value. */
  gameKey: string;
  status: JournalInspectionStatus;
  updatedAt?: string;
  setup?: IGameSetup;
  events?: ScoreEvent[];
}

export type JournalRecoveryFact =
  | { kind: 'valid'; latest: IJournalInspection; questionNumber?: number }
  | { kind: 'unverified'; entries: number }
  | { kind: 'missing' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function latestQuestion(events: readonly ScoreEvent[]): number | undefined {
  const question = events.reduce((highest, event) => Math.max(highest, event.questionNumber), 0);
  return question > 0 ? question : undefined;
}

/** Inspect one raw journal entry without mutating it or attempting to repair it. */
export function inspectJournal(gameKey: string, raw: string, now: Date = new Date()): IJournalInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { gameKey, status: 'malformed' };
  }

  if (!isRecord(parsed)) return { gameKey, status: 'malformed' };

  const version = parsed.version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    (version !== gameSessionVersion && version !== legacyGameSessionVersion)
  ) {
    return { gameKey, status: 'unsupported' };
  }
  if (parsed.gameKey !== gameKey) return { gameKey, status: 'malformed' };
  if (!validSetup(parsed.setup)) return { gameKey, status: 'malformed' };
  if (!Array.isArray(parsed.events) || !parsed.events.every(validEvent)) {
    return { gameKey, status: 'malformed' };
  }
  if (typeof parsed.updatedAt !== 'string') return { gameKey, status: 'malformed' };

  const updated = new Date(parsed.updatedAt).getTime();
  if (!Number.isFinite(updated)) return { gameKey, status: 'malformed' };
  const age = now.getTime() - updated;
  if (age < 0) return { gameKey, status: 'malformed', updatedAt: parsed.updatedAt };

  const setup = parsed.setup;
  const events = parsed.events;
  const common = { gameKey, updatedAt: parsed.updatedAt, setup, events };
  if (age > gameSessionMaxAgeMs) return { ...common, status: 'stale' };
  return { ...common, status: 'valid' };
}

/** Inspect the already-enumerated raw journal map. The map is never written back. */
export function inspectJournals(
  journals: Readonly<Record<string, string>>,
  now: Date = new Date(),
): IJournalInspection[] {
  return Object.entries(journals).map(([gameKey, raw]) => inspectJournal(gameKey, raw, now));
}

/** Read the same raw entries the crash export uses, but attach safe status for the UI. */
export function inspectBrowserJournals(now: Date = new Date()): {
  raw: Record<string, string>;
  entries: IJournalInspection[];
} {
  const raw = exportJournals();
  return { raw, entries: inspectJournals(raw, now) };
}

/** Turn source inspection into the one factual sentence the crash screen needs. */
export function summarizeJournalRecovery(entries: readonly IJournalInspection[]): JournalRecoveryFact {
  if (entries.length === 0) return { kind: 'missing' };
  const valid = entries
    .filter(
      (entry): entry is IJournalInspection & { status: 'valid'; events: ScoreEvent[] } =>
        entry.status === 'valid' && entry.events !== undefined,
    )
    .sort((first, second) => {
      const firstAt = new Date(first.updatedAt ?? '').getTime();
      const secondAt = new Date(second.updatedAt ?? '').getTime();
      return secondAt - firstAt;
    });
  const latest = valid[0];
  if (!latest) return { kind: 'unverified', entries: entries.length };
  return { kind: 'valid', latest, questionNumber: latestQuestion(latest.events) };
}

/** The crash export remains a raw journal export, not a QBJ and not a validated replacement. */
export function journalFileContents(journals: Record<string, string>, now: Date): string {
  return `${JSON.stringify(
    {
      qbsheetRecoveryExport: 1,
      exportedAt: now.toISOString(),
      note: 'Raw scoring journals, exactly as stored. Not a QBJ. Hand this to a tournament director.',
      games: journals,
    },
    null,
    2,
  )}\n`;
}

/** `qbsheet-recovery-2026-08-20T14-32-05.json`. Sortable, and obviously not a result file. */
export function journalFileName(now: Date): string {
  return `qbsheet-recovery-${now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')}.json`;
}
