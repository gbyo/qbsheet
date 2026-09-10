/**
 * Gate for direct HSQuizbowl Resource Center stats upload (#767).
 *
 * Research outcome (verified 2026-09-10, see
 * `docs/HSQUIZBOWL_DIRECT_UPLOAD.md`): the Resource Center exposes no
 * documented third-party upload API, API token system, or OAuth flow.
 * Publishing is an owner-scoped, phpBB-authenticated browser workflow
 * (`Edit tournament listing` → `Manage stat reports` → `Add stat report`).
 *
 * This module therefore fails closed: every entry point reports direct upload
 * as unsupported and points at the safe manual handoff from #766. No upload
 * implementation may land here until the Resource Center documents or
 * explicitly approves a stable authentication/upload contract and the ten
 * Phase 1 questions in the research doc are answered in the repository.
 *
 * The one hard rule this gate exists to enforce: QBSheet must never emulate
 * an API by handling forum passwords, scraping or copying browser cookies,
 * replaying CSRF tokens from undocumented forms, or embedding a hidden
 * logged-in browser. See `FORBIDDEN_HSQB_CREDENTIAL_MECHANISMS`.
 */

/** Public entry point of the Quizbowl Resource Center database. */
export const HSQB_RESOURCE_CENTER_URL = 'https://hsquizbowl.org/db/';

/** Date the "no supported API" finding was last verified (`YYYY-MM-DD`). */
export const HSQB_DIRECT_UPLOAD_RESEARCH_DATE = '2026-09-10';

/** Machine-readable gate state. Only ever `'unsupported'` until #767 re-opens. */
export type HsqbDirectUploadStatus = 'unsupported' | 'supported';
export const HSQB_DIRECT_UPLOAD_STATUS: HsqbDirectUploadStatus = 'unsupported';

/** Research record future contributors must update before re-checking. */
export const HSQB_DIRECT_UPLOAD_DOC = 'docs/HSQUIZBOWL_DIRECT_UPLOAD.md';

/** Verified manual navigation path for the tournament entry owner. */
export const HSQB_MANUAL_UPLOAD_STEPS: readonly string[] = [
  'Sign into the forum account that owns the tournament entry.',
  'Select the tournament.',
  'Choose `Edit tournament listing`.',
  'Choose `Manage stat reports`.',
  'Choose `Add stat report`.',
  'Upload the prepared HTML files generated for the report.',
];

/**
 * Verified Resource Center field mapping. Only the Scoreboard mapping is
 * attested by a public walkthrough; every other slot is filled by semantic
 * report role, never by filename-substring guessing.
 */
export const HSQB_MANUAL_FIELD_MAPPING: readonly { field: string; file: string }[] = [
  { field: 'Scoreboard', file: 'the report file ending in `_games.html`' },
];

export type HsqbCredentialMechanism =
  | 'oauth-scoped-token'
  | 'api-token'
  | 'maintainer-delegated'
  | 'forum-password'
  | 'browser-cookie'
  | 'session-copy'
  | 'csrf-replay'
  | 'hidden-browser-login';

/**
 * Mechanisms that are never acceptable for Resource Center upload, even if
 * they appear to work. Listed explicitly so review can reject them by name.
 */
export const FORBIDDEN_HSQB_CREDENTIAL_MECHANISMS: readonly HsqbCredentialMechanism[] = [
  'forum-password',
  'browser-cookie',
  'session-copy',
  'csrf-replay',
  'hidden-browser-login',
];

/**
 * Whether a credential mechanism may be used for direct upload. Currently
 * `false` for everything: no mechanism has been approved because no supported
 * API exists. When a maintainer-approved contract lands, only the approved
 * mechanism(s) may flip, and the forbidden set above must stay rejected.
 */
export function isHsqbCredentialMechanismAllowed(mechanism: HsqbCredentialMechanism): boolean {
  return !FORBIDDEN_HSQB_CREDENTIAL_MECHANISMS.includes(mechanism) && isDirectHsqbUploadSupported();
}

/** Whether QBSheet may publish directly to the Resource Center. Always false. */
export function isDirectHsqbUploadSupported(): boolean {
  return HSQB_DIRECT_UPLOAD_STATUS === 'supported';
}

export interface HsqbDirectUploadBlock {
  status: HsqbDirectUploadStatus;
  reason: string;
  researchDate: string;
  researchDoc: string;
  resourceCenterUrl: string;
  manualSteps: readonly string[];
  /** A failed direct attempt must always leave the manual path usable. */
  manualFallbackAvailable: true;
}

/** Structured explanation of why direct upload is unavailable. */
export function describeDirectHsqbUploadBlock(): HsqbDirectUploadBlock {
  return {
    status: HSQB_DIRECT_UPLOAD_STATUS,
    reason:
      'Direct HSQuizbowl stats upload is unsupported: no documented third-party upload API exists ' +
      '(#767). Prepare the report files in Director and upload them through the Resource Center ' +
      'browser form as the tournament entry owner.',
    researchDate: HSQB_DIRECT_UPLOAD_RESEARCH_DATE,
    researchDoc: HSQB_DIRECT_UPLOAD_DOC,
    resourceCenterUrl: HSQB_RESOURCE_CENTER_URL,
    manualSteps: HSQB_MANUAL_UPLOAD_STEPS,
    manualFallbackAvailable: true,
  };
}

/**
 * Guard for future call sites. Throws unconditionally while direct upload is
 * unsupported so no code path can silently treat local file generation as a
 * publication.
 */
export function assertDirectHsqbUploadSupported(): never {
  const block = describeDirectHsqbUploadBlock();
  throw new Error(
    `${block.reason} See ${block.researchDoc} (verified ${block.researchDate}). ` +
      `Manual upload: ${block.resourceCenterUrl}`,
  );
}

/**
 * Minimal reference to a locally prepared report. The gate takes the artifact
 * by reference and never consumes it, so a blocked attempt provably leaves
 * the manual download/upload path usable.
 */
export interface HsqbPreparedReportRef {
  scopeLabel: string;
  baseName: string;
  fileNames: readonly string[];
}

export interface HsqbDirectUploadAttempt extends HsqbDirectUploadBlock {
  ok: false;
  /** The passed artifact is returned untouched for immediate manual upload. */
  artifactPreserved: true;
  artifact: HsqbPreparedReportRef;
}

/**
 * The only sanctioned "upload attempt" while the gate is closed. It performs
 * no network I/O, mutates nothing, and hands the artifact back so the
 * director can fall back to the manual workflow immediately.
 */
export function requestDirectHsqbUpload(artifact: HsqbPreparedReportRef): HsqbDirectUploadAttempt {
  return { ...describeDirectHsqbUploadBlock(), ok: false, artifactPreserved: true, artifact };
}

export interface HsqbProviderPublishResponse {
  httpOk: boolean;
  parserErrors: readonly string[];
  publicReportUrl?: string;
}

/**
 * Public success state must rest on a verified provider response, never on a
 * bare 2xx and never on local file generation. Per-file/parser errors veto
 * success even when the transport looked fine.
 */
export function isVerifiedHsqbPublishSuccess(response: HsqbProviderPublishResponse): boolean {
  return (
    response.httpOk && response.parserErrors.length === 0 && typeof response.publicReportUrl === 'string'
  );
}

/**
 * Narrow provider boundary for a future supported integration (see #767 Phase
 * 3). Canonical stats/report rendering stays offline and testable; provider
 * auth and network details stay out of the tournament-domain model; and the
 * same prepared artifact used by manual export is what gets published.
 *
 * No implementation of this interface may land until the gate flips with a
 * documented maintainer-approved contract.
 */
export interface ResourceCenterPublisher {
  listWritableTournaments(): Promise<readonly { id: string; name: string }[]>;
  listReports(tournamentId: string): Promise<readonly { id: string; name: string }[]>;
  publishReport(tournamentId: string, report: HsqbPreparedReportRef): Promise<HsqbProviderPublishResponse>;
}
