import { afterEach, describe, expect, test, vi } from 'vitest';
import { correctPlayerName, correctTeamName } from '../src/scoring/identityCorrection';
import type { IGameSetup } from '../src/scoring/deriveGame';

function emulateTurkishLocaleCasing(): void {
  vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
    return String(this).replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase();
  });
}

const setup: IGameSetup = {
  left: { name: 'Alpha', players: ['Sam', 'I'] },
  right: { name: 'I', players: [] },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('identity correction case matching', () => {
  test('rejects duplicate team names independently of browser locale', () => {
    emulateTurkishLocaleCasing();

    const result = correctTeamName({ setup, events: [] }, 'left', 'i');

    expect(result).toEqual({
      ok: false,
      problems: ['Both teams would have the same name, and a result cannot tell them apart.'],
    });
  });

  test('detects player-name collisions independently of browser locale', () => {
    emulateTurkishLocaleCasing();

    const result = correctPlayerName({ setup, events: [] }, 'left', 'Sam', 'i');

    expect(result).toEqual({
      ok: false,
      problems: ['I is already on this roster.'],
      mergeAvailable: true,
    });
  });
});
