import type { ResultSubmission } from '../domain';
import type { IncomingArtifact } from './model';

/** Transfers records what arrived; Results records what that submission means. */
export function transferArtifactSubmission(
  artifact: IncomingArtifact,
  submissions: readonly ResultSubmission[],
): ResultSubmission | undefined {
  return artifact.submissionId
    ? submissions.find((submission) => submission.id === artifact.submissionId)
    : undefined;
}

export function transferArtifactNeedsAttention(
  artifact: IncomingArtifact,
  submissions: readonly ResultSubmission[],
): boolean {
  if (artifact.status === 'failed') return true;
  if (artifact.status !== 'staged') return false;
  const submission = transferArtifactSubmission(artifact, submissions);
  // Preserve attention for old/damaged documents whose link is no longer present.
  return !submission || submission.status === 'received' || submission.status === 'review';
}

export function transferArtifactResolution(
  artifact: IncomingArtifact,
  submissions: readonly ResultSubmission[],
): 'accepted' | 'rejected' | undefined {
  const status = transferArtifactSubmission(artifact, submissions)?.status;
  return status === 'accepted' || status === 'rejected' ? status : undefined;
}
