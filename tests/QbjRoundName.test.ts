import { describe, expect, test } from 'vitest';
import { readQbjSource } from '../src/qbj/ParseQbjAssignment';
import { assignmentDocument } from './qbjDocuments';

describe('QBJ round names', () => {
  test('does not treat a digit-prefixed display name as a round number', () => {
    const source = readQbjSource(assignmentDocument({ roundName: '2026 Finals', omitRoundNumber: true }));

    expect(source.ok).toBe(true);
    if (!source.ok) return;
    expect(source.value.candidates).toHaveLength(1);
    expect(source.value.candidates[0].roundName).toBe('2026 Finals');
    expect(source.value.candidates[0].roundNumber).toBeUndefined();
  });

  test('still reads a bare numeric round name', () => {
    const source = readQbjSource(assignmentDocument({ roundName: ' 12 ', omitRoundNumber: true }));

    expect(source.ok).toBe(true);
    if (!source.ok) return;
    expect(source.value.candidates[0].roundNumber).toBe(12);
  });
});
