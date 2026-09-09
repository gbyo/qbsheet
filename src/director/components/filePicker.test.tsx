/** @vitest-environment jsdom */

import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FilePicker } from './FilePicker';
import { pickDirectorFiles } from './filePickerContract';

function setNativeInvoke(invoke: (command: string) => Promise<unknown>) {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke },
  });
}

function browserFile(name: string, bytes: number[]) {
  const file = new File(['file'], name);
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: vi.fn(async () => new Uint8Array(bytes).buffer),
  });
  return file;
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('pickDirectorFiles', () => {
  test('forwards native selection bytes exactly once', async () => {
    const invoke = vi.fn(async () => ({
      fileName: 'round.qbst',
      contentBase64: btoa('native bytes'),
    }));
    const onPick = vi.fn();
    setNativeInvoke(invoke);

    await pickDirectorFiles({ native: true, onPick });

    expect(invoke).toHaveBeenCalledWith('open_tournament_file');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith([
      { fileName: 'round.qbst', bytes: new Uint8Array(new TextEncoder().encode('native bytes')) },
    ]);
  });

  test('treats native cancellation as a silent no-op', async () => {
    setNativeInvoke(vi.fn(async () => null));
    const onPick = vi.fn();
    const onError = vi.fn();

    await expect(pickDirectorFiles({ native: true, onPick, onError })).resolves.toBeUndefined();

    expect(onPick).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('surfaces native bridge failures without rejecting', async () => {
    setNativeInvoke(vi.fn(async () => Promise.reject(new Error('dialog unavailable'))));
    const onPick = vi.fn();
    const onError = vi.fn();

    await expect(pickDirectorFiles({ native: true, onPick, onError })).resolves.toBeUndefined();

    expect(onPick).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('dialog unavailable');
  });

  test('forwards browser selection bytes exactly once', async () => {
    const onPick = vi.fn();
    const file = browserFile('round.qbj', [1, 2, 3]);

    await pickDirectorFiles({ native: false, files: [file], onPick });

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith([{ fileName: 'round.qbj', bytes: new Uint8Array([1, 2, 3]) }]);
  });

  test('treats browser cancellation as a silent no-op', async () => {
    const onPick = vi.fn();
    const onError = vi.fn();

    await expect(pickDirectorFiles({ native: false, files: [], onPick, onError })).resolves.toBeUndefined();

    expect(onPick).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('surfaces browser read failures without importing or rejecting', async () => {
    const file = browserFile('broken.qbj', [1]);
    const read = file.arrayBuffer as unknown as ReturnType<typeof vi.fn>;
    read.mockRejectedValue(new Error('read failed'));
    const onPick = vi.fn();
    const onError = vi.fn();

    await expect(
      pickDirectorFiles({ native: false, files: [file], onPick, onError }),
    ).resolves.toBeUndefined();

    expect(onPick).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('read failed');
  });
});

test('FilePicker resets its hidden input so the same browser file can be selected again', async () => {
  const onPick = vi.fn();
  const file = browserFile('round.qbj', [4, 5]);
  const view = render(
    <FilePicker accept=".qbj" onPick={onPick}>
      Open
    </FilePicker>,
  );
  const input = view.container.querySelector('input[type="file"]');
  if (!input) throw new Error('FilePicker did not render its input');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });

  fireEvent.change(input);
  await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
  expect(input).toHaveValue('');

  fireEvent.change(input);
  await waitFor(() => expect(onPick).toHaveBeenCalledTimes(2));
});
