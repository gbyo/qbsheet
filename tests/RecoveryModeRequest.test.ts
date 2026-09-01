import { describe, expect, test } from 'vitest';
import { isRecoveryModeRequested, normalModeHref, recoveryModeHref } from '../src/app/recoveryModeRequest';

describe('Recovery Mode bootstrap request', () => {
  test('requires the explicit recovery=1 query value', () => {
    expect(isRecoveryModeRequested({ search: '?recovery=1' })).toBe(true);
    expect(isRecoveryModeRequested({ search: '?recovery=0' })).toBe(false);
    expect(isRecoveryModeRequested({ search: '?recovery=true' })).toBe(false);
    expect(isRecoveryModeRequested({ search: '?other=1' })).toBe(false);
  });

  test('builds same-origin entry links without carrying unrelated URL state', () => {
    const location = { pathname: '/qbsheet/index.html' };
    expect(recoveryModeHref(location)).toBe('/qbsheet/index.html?recovery=1');
    expect(normalModeHref(location)).toBe('/qbsheet/index.html');
  });

  test('fails closed when a location is unavailable', () => {
    expect(isRecoveryModeRequested(null)).toBe(false);
    expect(recoveryModeHref(null)).toBe('/?recovery=1');
    expect(normalModeHref(null)).toBe('/');
  });
});
