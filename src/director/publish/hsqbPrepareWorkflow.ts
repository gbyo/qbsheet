import {
  resourceCenterRequiredKinds,
  resourceCenterRoleLabels,
  type ResourceCenterReportFile,
  type ResourceCenterReportKind,
} from '@qbsheet/tournament-formats';
import type { SectionId } from '../app/navigation';
import {
  HSQB_MANUAL_FIELD_MAPPING,
  HSQB_MANUAL_UPLOAD_STEPS,
  HSQB_RESOURCE_CENTER_URL,
} from './hsqbUploadGate';

export { HSQB_MANUAL_UPLOAD_STEPS, HSQB_RESOURCE_CENTER_URL };

/**
 * Prepare-for-HSQuizbowl workflow helpers (issue #766, epic #760).
 *
 * The dialog in `PrepareHsqbDialog.tsx` renders the operator workflow; this
 * module holds the pure parts so they stay unit-testable without a DOM:
 * where each preflight diagnostic sends the director for a fix, and which
 * generated file belongs in which Resource Center upload field.
 */

export interface HsqbFixDestination {
  section: SectionId;
  /** Button label, naming the place rather than restating the problem. */
  label: string;
}

/**
 * Recovery navigation for preflight diagnostics, following the same
 * principle as the rest of Director: a blocking problem names where to fix
 * it instead of leaving the message in a toast. Only diagnostics with a
 * genuine operator-side fix are mapped; structural/generator diagnostics
 * (missing roles, malformed documents, dangling links) intentionally map to
 * nothing — there is no Director surface that fixes those.
 */
const FIX_BY_CODE: Readonly<Record<string, HsqbFixDestination>> = {
  'no-accepted-games': { section: 'results', label: 'Go to Results' },
  'unresolved-game-winner': { section: 'results', label: 'Go to Results' },
  'game-missing-from-scoreboard': { section: 'results', label: 'Go to Results' },
  'game-duplicated-in-scoreboard': { section: 'results', label: 'Go to Results' },
  'standings-game-mismatch': { section: 'results', label: 'Go to Results' },
  'team-total-mismatch': { section: 'results', label: 'Go to Results' },
  'player-total-mismatch': { section: 'results', label: 'Go to Results' },
  'team-missing-from-games': { section: 'results', label: 'Go to Results' },
  'player-missing-from-individuals': { section: 'results', label: 'Go to Results' },
  'unknown-tossups-heard': { section: 'results', label: 'Go to Results' },
  'unknown-player-tossups-heard': { section: 'results', label: 'Go to Results' },
  'partial-player-detail': { section: 'results', label: 'Go to Results' },
  'forfeit-representation': { section: 'results', label: 'Go to Results' },
  'overtime-scope': { section: 'results', label: 'Go to Results' },
  'missing-tournament-identity': { section: 'settings', label: 'Go to Settings' },
  'mixed-scoring-definitions': { section: 'format', label: 'Go to Format' },
  'unrepresentable-scoring-layout': { section: 'format', label: 'Go to Format' },
};

/** Fix destination for one preflight diagnostic code, if an operator fix exists. */
export function hsqbFixDestination(code: string): HsqbFixDestination | null {
  return FIX_BY_CODE[code] ?? null;
}

export interface HsqbUploadFieldMapping {
  /** Semantic report role; the mapping key is never a filename substring. */
  kind: ResourceCenterReportKind;
  /** Resource Center upload field for this role. */
  field: string;
  fileName: string;
  requiredForResourceCenter: boolean;
  /**
   * True only for the Scoreboard mapping — the one attested by a public
   * walkthrough (Resource Center `Scoreboard` takes the `*_games.html`
   * file). Every other row follows the same verified report-role
   * vocabulary, but only Scoreboard is independently attested.
   */
  attested: boolean;
}

/** Fields the Resource Center upload form is known to expose, in form order. */
const KNOWN_UPLOAD_FIELDS: Readonly<Record<ResourceCenterReportKind, string>> = {
  standings: 'Standings',
  individuals: 'Individuals',
  scoreboard: HSQB_MANUAL_FIELD_MAPPING.find((entry) => entry.field === 'Scoreboard')?.field ?? 'Scoreboard',
  teamDetail: 'Team Detail',
  playerDetail: 'Player Detail',
  rounds: 'Round Report',
  statKey: 'Stat Key',
};

/**
 * Upload-field mapping for one report set, generated from each file's
 * semantic role (`kind`) — never by parsing filenames. Required roles come
 * first in upload-form order; the optional Stat Key companion sorts last.
 */
export function hsqbUploadFieldMapping(files: readonly ResourceCenterReportFile[]): HsqbUploadFieldMapping[] {
  const byKind = new Map<ResourceCenterReportKind, ResourceCenterReportFile>();
  for (const file of files) {
    if (!byKind.has(file.kind)) byKind.set(file.kind, file);
  }
  return resourceCenterRequiredKinds
    .map((kind) => {
      const file = byKind.get(kind);
      if (!file) return null;
      return {
        kind,
        field: KNOWN_UPLOAD_FIELDS[kind] ?? resourceCenterRoleLabels[kind],
        fileName: file.fileName,
        requiredForResourceCenter: file.requiredForResourceCenter,
        attested: kind === 'scoreboard',
      };
    })
    .filter((entry): entry is HsqbUploadFieldMapping => entry !== null);
}

export type HsqbSetStatus = 'ready' | 'warnings' | 'blocked';

/** One set's preflight status: blockers veto, warnings ride along. */
export function hsqbSetStatus(blockingCount: number, warningCount: number): HsqbSetStatus {
  if (blockingCount > 0) return 'blocked';
  return warningCount > 0 ? 'warnings' : 'ready';
}
