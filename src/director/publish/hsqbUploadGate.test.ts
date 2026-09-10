/**
 * Gate tests for direct HSQuizbowl stats upload (#767, outcome B).
 *
 * The Resource Center exposes no supported third-party upload API, so every
 * entry point in `hsqbUploadGate` must fail closed: direct upload reports
 * itself unsupported, forbidden credential mechanisms stay rejected, success
 * is never inferred from local file generation, and a blocked attempt always
 * hands the prepared artifact back for the manual browser workflow.
 */
import { describe, expect, test } from 'vitest';
import {
  assertDirectHsqbUploadSupported,
  describeDirectHsqbUploadBlock,
  FORBIDDEN_HSQB_CREDENTIAL_MECHANISMS,
  HSQB_DIRECT_UPLOAD_DOC,
  HSQB_DIRECT_UPLOAD_RESEARCH_DATE,
  HSQB_DIRECT_UPLOAD_STATUS,
  HSQB_MANUAL_FIELD_MAPPING,
  HSQB_MANUAL_UPLOAD_STEPS,
  HSQB_RESOURCE_CENTER_URL,
  isDirectHsqbUploadSupported,
  isHsqbCredentialMechanismAllowed,
  isVerifiedHsqbPublishSuccess,
  requestDirectHsqbUpload,
  type HsqbCredentialMechanism,
  type HsqbPreparedReportRef,
} from './hsqbUploadGate';

const ALL_MECHANISMS: readonly HsqbCredentialMechanism[] = [
  'oauth-scoped-token',
  'api-token',
  'maintainer-delegated',
  'forum-password',
  'browser-cookie',
  'session-copy',
  'csrf-replay',
  'hidden-browser-login',
];

function sampleArtifact(): HsqbPreparedReportRef {
  return {
    scopeLabel: 'Combined',
    baseName: 'invitational-combined',
    fileNames: [
      'invitational-combined_standings.html',
      'invitational-combined_individuals.html',
      'invitational-combined_games.html',
    ],
  };
}

describe('direct HSQuizbowl upload gate', () => {
  test('direct upload is reported unsupported with a dated research pointer', () => {
    expect(isDirectHsqbUploadSupported()).toBe(false);
    expect(HSQB_DIRECT_UPLOAD_STATUS).toBe('unsupported');

    const block = describeDirectHsqbUploadBlock();
    expect(block.status).toBe('unsupported');
    expect(block.researchDate).toBe(HSQB_DIRECT_UPLOAD_RESEARCH_DATE);
    expect(block.researchDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(block.researchDoc).toBe(HSQB_DIRECT_UPLOAD_DOC);
    expect(block.resourceCenterUrl).toBe(HSQB_RESOURCE_CENTER_URL);
    expect(block.reason).toContain('#767');
    expect(block.manualFallbackAvailable).toBe(true);
  });

  test('the guard throws instead of letting a call site proceed', () => {
    expect(() => assertDirectHsqbUploadSupported()).toThrowError(/#767/);
    expect(() => assertDirectHsqbUploadSupported()).toThrowError(/browser form/);
  });

  test('a blocked attempt performs no upload and preserves the manual path', () => {
    const artifact = sampleArtifact();
    const frozen = structuredClone(artifact);
    Object.freeze(artifact.fileNames);

    const attempt = requestDirectHsqbUpload(artifact);

    expect(attempt.ok).toBe(false);
    expect(attempt.status).toBe('unsupported');
    expect(attempt.artifactPreserved).toBe(true);
    expect(attempt.manualFallbackAvailable).toBe(true);
    // The artifact is handed back untouched for immediate manual upload.
    expect(attempt.artifact).toBe(artifact);
    expect(artifact).toEqual(frozen);
  });

  test('forbidden credential mechanisms are enumerated and all mechanisms are rejected', () => {
    expect(FORBIDDEN_HSQB_CREDENTIAL_MECHANISMS).toContain('forum-password');
    expect(FORBIDDEN_HSQB_CREDENTIAL_MECHANISMS).toContain('browser-cookie');
    expect(FORBIDDEN_HSQB_CREDENTIAL_MECHANISMS).toContain('session-copy');
    expect(FORBIDDEN_HSQB_CREDENTIAL_MECHANISMS).toContain('csrf-replay');
    expect(FORBIDDEN_HSQB_CREDENTIAL_MECHANISMS).toContain('hidden-browser-login');

    for (const mechanism of ALL_MECHANISMS) {
      expect(isHsqbCredentialMechanismAllowed(mechanism)).toBe(false);
    }
  });

  test('success requires a verified provider response, never a bare 2xx or local generation', () => {
    // A bare 2xx with per-file parser errors is not a publication.
    expect(isVerifiedHsqbPublishSuccess({ httpOk: true, parserErrors: ['games.html rejected'] })).toBe(false);
    // A bare 2xx without the public report link is not a publication.
    expect(isVerifiedHsqbPublishSuccess({ httpOk: true, parserErrors: [] })).toBe(false);
    // A transport failure is not a publication even with a stale URL.
    expect(
      isVerifiedHsqbPublishSuccess({
        httpOk: false,
        parserErrors: [],
        publicReportUrl: 'https://hsquizbowl.org/db/tournaments/1/stats/all_games/',
      }),
    ).toBe(false);
    // Only transport success plus clean parser results plus a public link counts.
    expect(
      isVerifiedHsqbPublishSuccess({
        httpOk: true,
        parserErrors: [],
        publicReportUrl: 'https://hsquizbowl.org/db/tournaments/1/stats/all_games/',
      }),
    ).toBe(true);
  });

  test('the manual handoff names the verified owner workflow and Scoreboard mapping', () => {
    const steps = HSQB_MANUAL_UPLOAD_STEPS.join('\n');
    expect(steps).toContain('Edit tournament listing');
    expect(steps).toContain('Manage stat reports');
    expect(steps).toContain('Add stat report');

    const scoreboard = HSQB_MANUAL_FIELD_MAPPING.find((entry) => entry.field === 'Scoreboard');
    expect(scoreboard?.file).toContain('_games.html');
  });
});
