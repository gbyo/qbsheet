import {
  buildResourceCenterReport,
  defaultReportOptions,
  preflightResourceCenterReport,
  reportPageOrder,
  sanitizeResourceCenterBaseName,
  zipStatReportBundle,
  type ReportOptions,
  type ResourceCenterPreflight,
  type ResourceCenterReportFile,
} from '@qbsheet/tournament-formats';
import type { DirectorState } from '../domain';
import { buildCanonicalRoundStatsSnapshot } from './canonicalRoundReports';
import { withReportPresentation } from './reportPresentation';

export interface CanonicalResourceCenterArtifact {
  fileName: string;
  baseName: string;
  scopeLabel: string;
  files: ResourceCenterReportFile[];
  bytes: Uint8Array;
  /**
   * Explicit preflight (issue #764): blocking errors vs warnings, reconciled against
   * the same canonical snapshot the files render. Callers must refuse the download
   * while `preflight.ok` is false and surface warnings alongside a successful one.
   */
  preflight: ResourceCenterPreflight;
}

/**
 * Build the Resource Center upload set from the canonical Director snapshot (issue #762).
 *
 * This is a view of the same accepted-results snapshot Director/Live/CSV render — never a
 * second calculator. The printable page selection is forced back to the full six-view set:
 * a narrowed printable report must not drop Resource Center upload roles or their
 * cross-links. The `_statkey.html` companion ships for SQBS completeness but stays
 * optional (see the formats-level contract and #764).
 */
export function buildCanonicalResourceCenterReport(
  state: DirectorState,
  generatedAt = new Date().toISOString(),
  options: ReportOptions = defaultReportOptions,
): CanonicalResourceCenterArtifact {
  const baseName = sanitizeResourceCenterBaseName(state.tournament?.name ?? 'tournament');
  const snapshot = withReportPresentation(
    state,
    buildCanonicalRoundStatsSnapshot(state, undefined, generatedAt),
    { ...options, pages: [...reportPageOrder] },
  );
  const artifact = buildResourceCenterReport(snapshot, { baseName, includeStatKey: true });
  return {
    fileName: `${baseName}-resource-center.zip`,
    baseName: artifact.baseName,
    scopeLabel: artifact.scopeLabel,
    files: artifact.files,
    bytes: zipStatReportBundle(
      artifact.files.map((file) => ({ name: file.fileName, content: file.content })),
    ),
    preflight: preflightResourceCenterReport(artifact, snapshot),
  };
}
