import type { DirectorState } from '../domain';
import type { IncomingArtifact } from './model';

const pendingSubmissionStatuses = new Set<DirectorState['submissions'][number]['status']>([
  'received',
  'review',
]);

/**
 * Transfers owns file provenance; Results owns the decision lifecycle.
 *
 * A staged artifact only needs transfer attention while its linked Result submission still needs a
 * decision. Keeping this derived prevents the Transfers badge from becoming a second, stale result
 * inbox after Results accepts or rejects the submission.
 */
export function transferArtifactNeedsAttention(state: DirectorState, artifact: IncomingArtifact): boolean {
  if (artifact.status === 'failed') return true;
  if (artifact.status !== 'staged') return false;
  if (!artifact.submissionId) return true;
  const submission = state.submissions.find((entry) => entry.id === artifact.submissionId);
  return !submission || pendingSubmissionStatuses.has(submission.status);
}

export function transferArtifactDecisionLabel(
  state: DirectorState,
  artifact: IncomingArtifact,
): string | null {
  if (artifact.status !== 'staged' || !artifact.submissionId) return null;
  const submission = state.submissions.find((entry) => entry.id === artifact.submissionId);
  if (!submission || pendingSubmissionStatuses.has(submission.status)) return null;
  switch (submission.status) {
    case 'accepted':
      return 'Accepted in Results';
    case 'rejected':
      return 'Rejected in Results';
    case 'duplicate':
      return 'Duplicate in Results';
    case 'superseded':
      return 'Superseded in Results';
    default:
      return null;
  }
}
