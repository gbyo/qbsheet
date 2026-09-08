import {
  importArchiveBytes,
  importDirectorTournament,
  importQbjText,
  importYellowFruitText,
} from '../format/interchange';
import { errorNotice, type AnnounceInput } from '../notices';
import type { DirectorTournamentInput } from '@qbsheet/tournament-formats';
import type { PickedFile } from '../components/FilePicker';

/**
 * Opening a tournament file.
 *
 * # Why this is one function
 *
 * This logic existed three times: on the startup screen, in the sidebar
 * tournament menu, and in the narrow-window More menu — each with its own
 * slightly different error strings and its own ordering of the format sniffing.
 * The startup copy trimmed the tournament name; one of the others did not. Two
 * of them handled `.yft`; the third handled it differently.
 *
 * There is now one implementation and one Open flow, and every entry point —
 * the startup screen, the tournament menu, the desktop file dialog — calls it.
 *
 * Every supported format is preserved exactly: portable `.qbst` archives, QBJ,
 * YellowFruit, raw Director state snapshots, and Director tournament payloads,
 * with QBJ as the fallback sniff for unrecognised JSON.
 */

export interface OpenTournamentResult {
  ok: boolean;
  announcement: AnnounceInput;
}

function isDirectorStateLike(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'schemaVersion' in value &&
    'tournament' in value &&
    'teams' in value &&
    'scheduledGames' in value,
  );
}

function isDirectorTournamentLike(value: unknown): value is DirectorTournamentInput {
  return Boolean(value && typeof value === 'object' && 'tournament' in value && !('schemaVersion' in value));
}

/** Adds the compatibility-warning count to a success message when there is one. */
export function importWarningMessage(message: string, warnings: string[]): string {
  return warnings.length > 0
    ? `${message} ${warnings.length} compatibility warning${warnings.length === 1 ? '' : 's'} retained.`
    : message;
}

/**
 * Import a chosen tournament file into the open Director document.
 *
 * `importSnapshot` is the controller's own commit path, so persistence,
 * recovery checkpointing, and audit behaviour are unchanged.
 */
export function openTournamentFile(
  file: PickedFile,
  importSnapshot: (state: unknown) => boolean,
): OpenTournamentResult {
  const fail = (message: string): OpenTournamentResult => ({ ok: false, announcement: errorNotice(message) });
  const extension = file.fileName.toLocaleLowerCase().split('.').at(-1);

  try {
    if (extension === 'qbst') {
      const report = importArchiveBytes(file.bytes);
      if (!report.ok || !report.state) return fail(report.errors.join(' ') || 'That archive is not valid.');
      if (!importSnapshot(report.state)) return fail('That archive could not be imported.');
      return { ok: true, announcement: importWarningMessage('Portable archive imported.', report.warnings) };
    }

    const text = new TextDecoder().decode(file.bytes);

    if (extension === 'qbj') {
      const report = importQbjText(text);
      if (!report.ok || !report.state) return fail(report.errors.join(' ') || 'That QBJ file is not valid.');
      if (!importSnapshot(report.state)) return fail('That QBJ file could not be imported.');
      return { ok: true, announcement: importWarningMessage('QBJ tournament imported.', report.warnings) };
    }

    if (extension === 'yft') {
      const report = importYellowFruitText(text);
      if (!report.ok || !report.state) {
        return fail(report.errors.join(' ') || 'That YellowFruit file is not valid.');
      }
      if (!importSnapshot(report.state)) return fail('That YellowFruit tournament could not be imported.');
      return {
        ok: true,
        announcement: importWarningMessage('YellowFruit tournament imported.', report.warnings),
      };
    }

    const parsed: unknown = JSON.parse(text);
    if (isDirectorStateLike(parsed)) {
      if (!importSnapshot(parsed)) return fail('That Director state could not be imported.');
      return { ok: true, announcement: 'Director tournament imported.' };
    }
    if (isDirectorTournamentLike(parsed)) {
      if (!importSnapshot(importDirectorTournament(parsed))) {
        return fail('That tournament data could not be imported.');
      }
      return { ok: true, announcement: 'Tournament data imported.' };
    }
    // Unrecognised JSON gets one more chance as QBJ, which is how several
    // exporters name their files.
    const report = importQbjText(text);
    if (!report.ok || !report.state) {
      return fail(report.errors.join(' ') || 'That file is not a supported tournament archive.');
    }
    if (!importSnapshot(report.state)) return fail('That QBJ tournament could not be imported.');
    return { ok: true, announcement: importWarningMessage('QBJ tournament imported.', report.warnings) };
  } catch (reason: unknown) {
    return fail(reason instanceof Error ? reason.message : 'That file could not be opened.');
  }
}

/** The accept list every Open affordance uses. */
export const TOURNAMENT_FILE_ACCEPT = '.qbst,.qbj,.yft,.json';
