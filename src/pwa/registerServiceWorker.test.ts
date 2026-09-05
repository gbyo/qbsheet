import { afterEach, describe, expect, test, vi } from 'vitest';
import { runAfterPageLoad } from './registerServiceWorker';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runAfterPageLoad', () => {
  test('runs immediately when the page has already loaded', () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    const callback = vi.fn();

    runAfterPageLoad(callback);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('waits for load and only runs once while the page is still loading', () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    const callback = vi.fn();

    runAfterPageLoad(callback);
    expect(callback).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('load'));
    window.dispatchEvent(new Event('load'));

    expect(callback).toHaveBeenCalledTimes(1);
  });
});
