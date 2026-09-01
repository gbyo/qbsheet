import { describe, expect, it } from 'vitest';
import { createDirectorShellSnapshot, snapshotFileName } from './snapshot';

describe('Director shell checkpoints', () => {
  const now = new Date('2026-09-01T18:30:00.000Z');

  it('uses a versioned portable shape', () => {
    expect(createDirectorShellSnapshot(now)).toEqual({
      schemaVersion: 1,
      product: 'QBSheet Director',
      generatedAt: '2026-09-01T18:30:00.000Z',
      purpose: 'desktop-shell-checkpoint',
    });
  });

  it('gives snapshots a date-oriented filename', () => {
    expect(snapshotFileName(now)).toBe('qbsheet-director-2026-09-01.json');
  });
});
