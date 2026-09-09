import { describe, expect, it } from 'vitest';
import type { ResultSubmission } from '../domain';
import { normalizeTransferState } from '@qbsheet/tournament-domain';
import type { IncomingArtifact } from './model';
import { transferArtifactNeedsAttention } from './attention';

const makeArtifact = (overrides: Partial<IncomingArtifact> = {}): IncomingArtifact => ({
  id: 'artifact-1',
  sourceKind: 'removable-drive',
  sourceLabel: 'USB',
  fileName: 'result.qbj',
  byteLength: 10,
  digest: 'digest',
  detectedAt: '2026-09-01T00:00:00.000Z',
  classification: 'ready',
  warnings: [],
  status: 'staged',
  submissionId: 'submission-1',
  ...overrides,
});

const makeSubmission = (status: ResultSubmission['status'], id = 'submission-1'): ResultSubmission => ({
  id,
  gameId: 'game-1',
  receivedAt: '2026-09-01T00:00:00.000Z',
  fingerprint: 'fingerprint',
  status,
  rawSubmission: {},
});

describe('transfer artifact attention', () => {
  it.each(['received', 'review'])('keeps %s submissions actionable', (status) => {
    expect(
      transferArtifactNeedsAttention(makeArtifact(), [makeSubmission(status as ResultSubmission['status'])]),
    ).toBe(true);
  });

  it.each(['accepted', 'rejected'])('resolves when Results marks it %s', (status) => {
    expect(
      transferArtifactNeedsAttention(makeArtifact(), [makeSubmission(status as ResultSubmission['status'])]),
    ).toBe(false);
  });

  it('keeps conflicts, failures, and missing links actionable', () => {
    expect(transferArtifactNeedsAttention(makeArtifact(), [makeSubmission('review')])).toBe(true);
    expect(transferArtifactNeedsAttention(makeArtifact({ status: 'failed' }), [])).toBe(true);
    expect(transferArtifactNeedsAttention(makeArtifact({ submissionId: undefined }), [])).toBe(true);
  });

  it('does not count dismissed or duplicate artifacts after persistence reload', () => {
    const persisted = normalizeTransferState({
      artifacts: [
        makeArtifact({ id: 'accepted' }),
        makeArtifact({ id: 'duplicate', status: 'ignored', classification: 'duplicate' }),
        makeArtifact({ id: 'dismissed', status: 'ignored' }),
      ],
    });
    expect(
      persisted.artifacts.filter((entry) =>
        transferArtifactNeedsAttention(entry, [makeSubmission('accepted')]),
      ),
    ).toHaveLength(0);
  });

  it('follows the reassociated submission identity', () => {
    const reassociated = makeArtifact({ scheduledGameId: 'new-game' });
    expect(transferArtifactNeedsAttention(reassociated, [makeSubmission('accepted')])).toBe(false);
    expect(transferArtifactNeedsAttention(reassociated, [makeSubmission('accepted', 'other')])).toBe(true);
  });
});
