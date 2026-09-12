/**
 * The return path for file-sourced schedules: fill the blanks in a NEW `.yft` copy.
 *
 * Proven against stock YellowFruit (`Round.addMatch` is an unconditional `matches.push` with
 * no id check, reached from the import modal's `finishImport`): importing a completed QBJ for
 * a Match id that already sits in the file as a blank would APPEND a second game, not fill
 * the first. So file-sourced games never take the import-batch path. Instead this fills the
 * exact scheduled Match objects by id into a new file the director opens and verifies.
 *
 * The surgery is textual and minimal: parse, replace the matching inline Match objects,
 * serialize. The source text is never modified; every unrelated field and object passes
 * through untouched because nothing is ever reduced to an internal model and re-emitted.
 * The result is validated through QBSheet's own YFT importer before it is returned.
 */

import { readYellowFruitTournament } from '@qbsheet/tournament-formats';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface YftFill {
  matchId: string;
  /** The completed Match object from the room's finished QBJ. */
  match: Record<string, unknown>;
}

/** Pull the single top-level Match object out of a completed QBJ file. */
export function completedMatchOf(
  bytes: string,
): { ok: true; match: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.objects)) {
    return { ok: false, error: 'That file is not a QBJ document.' };
  }
  const matches = parsed.objects.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === 'Match',
  );
  if (matches.length !== 1) {
    return {
      ok: false,
      error: `That file holds ${matches.length} games; only one-game files can fill a schedule.`,
    };
  }
  return { ok: true, match: matches[0] };
}

/**
 * Fill scheduled blank Matches by id, returning the new file's text.
 *
 * Each fill replaces the exact inline Match object with the completed one, keeping the
 * blank's `YfData` sidecar when the result carries none of its own. Anything missing —
 * an unknown Match id, a referenced rather than inline match, an unreadable file — is an
 * error naming the game, and nothing is returned.
 */
export function fillScheduledMatches(
  sourceText: string,
  fills: readonly YftFill[],
): { ok: true; text: string; filled: string[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    return { ok: false, error: 'The YellowFruit file is not valid JSON.' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.objects)) {
    return { ok: false, error: 'The YellowFruit file has no tournament objects in it.' };
  }
  // Structured-clone the document so the caller's source text stays the only input and the
  // output is built from a private copy. JSON values only: a `.yft` holds nothing else.
  const document = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  const objects = document.objects as unknown[];
  const tournaments = objects.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === 'Tournament',
  );
  if (tournaments.length === 0) {
    return { ok: false, error: 'The YellowFruit file has no tournament in it.' };
  }

  const filled: string[] = [];
  for (const fill of fills) {
    let target: Record<string, unknown> | null = null;
    for (const tournament of tournaments) {
      const phases = Array.isArray(tournament.phases) ? tournament.phases : [];
      for (const phase of phases) {
        if (!isRecord(phase) || !Array.isArray(phase.rounds)) continue;
        for (const round of phase.rounds) {
          if (!isRecord(round) || !Array.isArray(round.matches)) continue;
          for (const match of round.matches) {
            if (isRecord(match) && match.id === fill.matchId) target = match;
          }
        }
      }
    }
    if (!target) {
      return { ok: false, error: `Match ${fill.matchId} is not scheduled in this YellowFruit file anymore.` };
    }
    const completed = fill.match;
    const blankYfData = isRecord(target.YfData) ? target.YfData : undefined;
    for (const key of Object.keys(target)) delete target[key];
    for (const [key, value] of Object.entries(completed)) target[key] = value;
    if (completed.YfData === undefined && blankYfData !== undefined) target.YfData = blankYfData;
    target.id = fill.matchId;
    filled.push(fill.matchId);
  }

  const text = JSON.stringify(document);
  const check = readYellowFruitTournament(text);
  if (!check.ok) {
    return {
      ok: false,
      error: `The filled file no longer reads as YellowFruit: ${check.errors[0]?.message ?? 'unknown error'}`,
    };
  }
  return { ok: true, text, filled };
}
