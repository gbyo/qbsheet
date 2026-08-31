import { describe, expect, it } from 'vitest';
import {
  displaySideMappingVersion,
  displaySideStorageKey,
  identityDisplaySideMapping,
  loadDisplaySideMapping,
  mapSides,
  parseDisplaySideMapping,
  saveDisplaySideMapping,
  serializeDisplaySideMapping,
  swapDisplaySideMapping,
} from '../src/scorer/DisplaySideMapping';

function storage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
    removeItem: (key: string) => {
      delete values[key];
    },
  };
}

describe('display-side mapping', () => {
  it('swaps twice back to the identity mapping and remaps side-indexed values', () => {
    const swapped = swapDisplaySideMapping(identityDisplaySideMapping);
    expect(swapped).toEqual({ left: 'right', right: 'left' });
    expect(swapDisplaySideMapping(swapped)).toEqual(identityDisplaySideMapping);
    expect(mapSides({ left: 'canonical left', right: 'canonical right' }, swapped)).toEqual({
      left: 'canonical right',
      right: 'canonical left',
    });
  });

  it('round-trips the explicit portable shape and rejects malformed or newer values', () => {
    const serialized = serializeDisplaySideMapping({ left: 'right', right: 'left' });
    expect(serialized).toEqual({
      version: displaySideMappingVersion,
      mapping: { left: 'right', right: 'left' },
    });
    expect(parseDisplaySideMapping(serialized)).toEqual({ left: 'right', right: 'left' });
    expect(parseDisplaySideMapping({ ...serialized, version: displaySideMappingVersion + 1 })).toBeNull();
    expect(
      parseDisplaySideMapping({ version: displaySideMappingVersion, mapping: { left: 'left' } }),
    ).toBeNull();
    expect(parseDisplaySideMapping({ ...serialized, extra: true })).toBeNull();
    expect(
      parseDisplaySideMapping({
        version: displaySideMappingVersion,
        mapping: { left: 'left', right: 'right', extra: 'future' },
      }),
    ).toBeNull();
  });

  it('persists per game and treats bad storage as the ordinary orientation', () => {
    const gameStorage = storage();
    const gameKey = 'game one';
    expect(saveDisplaySideMapping(gameKey, { left: 'right', right: 'left' }, gameStorage)).toBe(true);
    expect(loadDisplaySideMapping(gameKey, gameStorage)).toEqual({ left: 'right', right: 'left' });
    expect(loadDisplaySideMapping('other game', gameStorage)).toEqual(identityDisplaySideMapping);

    gameStorage.values[displaySideStorageKey(gameKey)] = '{bad json';
    expect(loadDisplaySideMapping(gameKey, gameStorage)).toEqual(identityDisplaySideMapping);
    gameStorage.values[displaySideStorageKey(gameKey)] = JSON.stringify({
      version: displaySideMappingVersion + 1,
      mapping: { left: 'right', right: 'left' },
    });
    expect(loadDisplaySideMapping(gameKey, gameStorage)).toEqual(identityDisplaySideMapping);
  });
});
