import { describe, expect, test } from 'vitest';
import {
  invalidPairingLaunchMessage,
  pairingLaunchNamespace,
  parsePairingLaunch,
} from '../src/app/PairingLaunch';

describe('pairing launch namespace boundaries', () => {
  test('ignores an oversized fragment that only shares the namespace prefix', () => {
    const fragment = `#${pairingLaunchNamespace}ing?${'x'.repeat(2048)}`;

    expect(parsePairingLaunch(fragment)).toEqual({ kind: 'none' });
  });

  test('still refuses an oversized fragment in the exact pairing namespace', () => {
    const fragment = `#${pairingLaunchNamespace}?${'x'.repeat(2048)}`;

    expect(parsePairingLaunch(fragment)).toEqual({
      kind: 'problem',
      message: invalidPairingLaunchMessage,
    });
  });
});
