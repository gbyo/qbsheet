/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { StateLabel } from './Controls';

afterEach(() => {
  vi.restoreAllMocks();
});

test('state identifiers are normalized independently of locale-specific casing', () => {
  vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
    const value = String(this);
    return value === 'INFO' ? 'ınfo' : value.toLowerCase();
  });

  const { container } = render(<StateLabel state="INFO" />);
  const state = container.querySelector('.director-state');

  expect(state?.getAttribute('data-state')).toBe('info');
  expect(state?.getAttribute('data-tone')).toBe('info');
});
