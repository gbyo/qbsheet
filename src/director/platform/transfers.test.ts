import { describe, expect, it, vi } from 'vitest';
import { NativeTransferFileSystem } from './transfers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('native transfer volume enumeration', () => {
  it('coalesces overlapping drive enumerations and refreshes after completion', async () => {
    const first = deferred<unknown>();
    const invoke = vi
      .fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce([
        { mountPoint: '/Volumes/NEXT', name: 'Next drive', removable: true, readOnly: false },
      ]);
    const fileSystem = new NativeTransferFileSystem({ invoke });

    const initial = fileSystem.listVolumes();
    const overlapping = fileSystem.listVolumes();

    expect(invoke).toHaveBeenCalledTimes(1);
    first.resolve([{ mountPoint: '/Volumes/FIRST', name: 'First drive', removable: true, readOnly: false }]);
    await expect(initial).resolves.toEqual([
      { mountPoint: '/Volumes/FIRST', name: 'First drive', removable: true, readOnly: false },
    ]);
    await expect(overlapping).resolves.toEqual([
      { mountPoint: '/Volumes/FIRST', name: 'First drive', removable: true, readOnly: false },
    ]);

    await expect(fileSystem.listVolumes()).resolves.toEqual([
      { mountPoint: '/Volumes/NEXT', name: 'Next drive', removable: true, readOnly: false },
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('allows the next enumeration to retry after a failure', async () => {
    const invoke = vi
      .fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('volume service unavailable'))
      .mockResolvedValueOnce([]);
    const fileSystem = new NativeTransferFileSystem({ invoke });

    await expect(fileSystem.listVolumes()).rejects.toThrow('volume service unavailable');
    await expect(fileSystem.listVolumes()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
