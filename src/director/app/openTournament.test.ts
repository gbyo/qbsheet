import { describe, expect, test, vi } from 'vitest';
import { openTournamentFile, TOURNAMENT_FILE_ACCEPT } from './openTournament';

describe('openTournamentFile', () => {
  test('keeps content validation authoritative when a native escape hatch selects bad content', () => {
    const importSnapshot = vi.fn(() => true);
    const result = openTournamentFile(
      { fileName: 'wrong-extension.qbj', bytes: new TextEncoder().encode('not JSON') },
      importSnapshot,
    );

    expect(result.ok).toBe(false);
    expect(importSnapshot).not.toHaveBeenCalled();
  });

  test('retains the existing open-tournament accepted formats', () => {
    expect(TOURNAMENT_FILE_ACCEPT).toBe('.qbst,.qbj,.yft,.json');
  });
});
