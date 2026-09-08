import { describe, expect, test } from 'vitest';
import { inspectCheckpoints } from '../src/recovery/RecoverySources';
import { IRecoveryCheckpoint } from '../src/recovery/RecoveryTypes';

function checkpoint(id: string, capturedAt: string): IRecoveryCheckpoint {
  return {
    id,
    gameKey: 'game-1',
    capturedAt,
    serializedBackup: '{}',
    kind: 'rolling',
  };
}

describe('recovery checkpoint inspection ordering', () => {
  test('sorts valid checkpoint timestamps newest first and leaves malformed timestamps last', () => {
    const inspected = inspectCheckpoints([
      checkpoint('malformed', 'not-a-date'),
      checkpoint('older', '2026-09-01T10:00:00.000Z'),
      checkpoint('newer', '2026-09-01T11:00:00.000Z'),
    ]);

    expect(inspected.map((entry) => entry.checkpoint.id)).toEqual(['newer', 'older', 'malformed']);
  });
});
