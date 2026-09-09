import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import type { IncomingArtifact } from './model';
import { transferArtifactDecisionLabel, transferArtifactNeedsAttention } from './artifactAttention';

function artifact(overrides: Partial<IncomingArtifact> = {}): IncomingArtifact {
  return {
    id: 'artifact-1',
    sourceKind: 'file-picker',
    sourceLabel: 'Imported file',
    fileName: 'round-1-room-101.qbj',
    byteLength: 128,
    digest: 'digest-1',
    detectedAt: '2026-09-09T12:00:00.000Z',
    classification: 'ready',
    warnings: [],
    status: 'staged',
    submissionId: 'submission-1',
    ...overrides,
  };
}

function stateWithSubmission(status: DirectorState['submissions'][number]['status']): DirectorState {
  const state = emptyDirectorState();
  state.submissions.push({
    id: 'submission-1',
    gameId: 'game-1',
    receivedAt: '2026-09-09T12:00:00.000Z',
    fingerprint: 'fingerprint-1',
    status,
    rawSubmission: { source: 'test' },
  });
  return state;
}

describe('transfer artifact attention', () => {
  test.each(['received', 'review'] as const)(
    'keeps a staged artifact actionable while its Result submission is %s',
    (status) => {
      const state = stateWithSubmission(status);
      expect(transferArtifactNeedsAttention(state, artifact())).toBe(true);
      expect(transferArtifactDecisionLabel(state, artifact())).toBeNull();
    },
  );

  test.each([
    ['accepted', 'Accepted in Results'],
    ['rejected', 'Rejected in Results'],
    ['duplicate', 'Duplicate in Results'],
    ['superseded', 'Superseded in Results'],
  ] as const)('resolves staged transfer attention when Results marks it %s', (status, label) => {
    const state = stateWithSubmission(status);
    expect(transferArtifactNeedsAttention(state, artifact())).toBe(false);
    expect(transferArtifactDecisionLabel(state, artifact())).toBe(label);
  });

  test('keeps failed transfer artifacts actionable without a Result submission', () => {
    const state = emptyDirectorState();
    expect(
      transferArtifactNeedsAttention(
        state,
        artifact({ status: 'failed', submissionId: undefined, classification: 'invalid' }),
      ),
    ).toBe(true);
  });

  test('does not treat an explicitly ignored artifact as unresolved Result work', () => {
    const state = stateWithSubmission('review');
    expect(transferArtifactNeedsAttention(state, artifact({ status: 'ignored' }))).toBe(false);
  });

  test('fails safe when a staged artifact references a missing submission', () => {
    const state = emptyDirectorState();
    expect(transferArtifactNeedsAttention(state, artifact())).toBe(true);
    expect(transferArtifactDecisionLabel(state, artifact())).toBeNull();
  });
});
