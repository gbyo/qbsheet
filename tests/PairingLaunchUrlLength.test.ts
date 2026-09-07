import { describe, expect, test } from 'vitest';
import { parsePairingLaunchUrl } from '../src/app/PairingLaunch';

describe('pairing launch URL length', () => {
  test('only the pairing fragment is subject to the launch length limit', () => {
    const server = 'http://192.168.1.24:3000';
    const fragment = `#qbtcp-pair?v=1&server=${encodeURIComponent(server)}&code=48213906`;
    const longDeploymentPath = `https://scores.example.school/${'a'.repeat(2100)}`;

    expect(parsePairingLaunchUrl(`${longDeploymentPath}${fragment}`)).toEqual({
      kind: 'intent',
      intent: { version: 1, server, code: '48213906' },
    });
  });

  test('an oversized pairing fragment is still refused', () => {
    const server = encodeURIComponent('http://192.168.1.24:3000');
    const oversized = `https://scores.example.school/#qbtcp-pair?v=1&server=${server}&code=48213906&pad=${'a'.repeat(4096)}`;

    expect(parsePairingLaunchUrl(oversized)).toEqual({
      kind: 'problem',
      message: 'This QBSheet pairing link is invalid.',
    });
  });
});
