/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider } from '../components/Dialog';
import { DirectorShell } from './DirectorShell';

function nativeFile(contentBase64 = btoa('native shell bytes')) {
  return {
    fileName: 'shell.qbst',
    contentBase64,
    byteLength: atob(contentBase64).length,
  };
}

function setNativeInvoke(invoke: (command: string) => Promise<unknown>) {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke },
  });
}

function browserFile(name: string, bytes: number[], readError?: Error) {
  const file = new File(['file'], name);
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: readError
      ? vi.fn(async () => Promise.reject(readError))
      : vi.fn(async () => new Uint8Array(bytes).buffer),
  });
  return file;
}

function renderShell() {
  const onFile = vi.fn();
  const onError = vi.fn();
  const view = render(
    <ConfirmProvider>
      <DirectorShell
        tournament={{ id: 'tournament', name: 'Shell tournament', date: '2026-09-09', status: 'draft' }}
        activeSection="overview"
        onNavigate={vi.fn()}
        recentTournaments={[
          { id: 'tournament', name: 'Shell tournament', date: '2026-09-09', status: 'draft' },
        ]}
        archivedTournaments={[]}
        onSwitchTournament={vi.fn()}
        onNewTournament={vi.fn()}
        onOpenFile={onFile}
        onOpenFileError={onError}
        onManageTournaments={vi.fn()}
        onArchiveTournament={vi.fn()}
        canArchive={false}
        operatorName="Operator"
        operatorRole="Director"
        operatorInitials="O"
        onHelp={vi.fn()}
        search={<span />}
      >
        <div>Shell content</div>
      </DirectorShell>
    </ConfirmProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Tournament: Shell tournament/ }));
  return { onFile, onError, view };
}

function shellFileInput(view: ReturnType<typeof render>) {
  const input = view.container.querySelector('input[type="file"]');
  if (!input) throw new Error('Shell did not render its file input');
  return input;
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('Director shell tournament file menu item', () => {
  test('is a searchable, keyboard-navigable entry and keeps its input out of the menu tab order', () => {
    const { view } = renderShell();
    const menuItem = screen.getByRole('option', { name: 'Open tournament file…' });
    const input = shellFileInput(view);

    // A cmdk item: it filters and takes arrow travel like every other entry, which the old
    // hand-rolled <label> around the file input did not.
    expect(menuItem).toHaveAttribute('cmdk-item');
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input).toHaveAttribute('aria-hidden', 'true');
  });

  test('forwards native success once and closes the menu', async () => {
    const invoke = vi.fn(async () => nativeFile());
    setNativeInvoke(invoke);
    const { onFile } = renderShell();

    fireEvent.click(screen.getByRole('option', { name: 'Open tournament file…' }));
    await waitFor(() => expect(onFile).toHaveBeenCalledTimes(1));

    expect(onFile).toHaveBeenCalledWith({
      fileName: 'shell.qbst',
      bytes: new Uint8Array(new TextEncoder().encode('native shell bytes')),
    });
    expect(invoke).toHaveBeenCalledWith('open_tournament_file', {
      filters: [
        { name: 'Accepted files', extensions: ['qbst', 'qbj', 'yft', 'json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('treats native cancellation as a silent no-op', async () => {
    setNativeInvoke(vi.fn(async () => null));
    const { onFile, onError } = renderShell();

    fireEvent.click(screen.getByRole('option', { name: 'Open tournament file…' }));
    await Promise.resolve();

    expect(onFile).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  test('surfaces native failures without an unhandled rejection', async () => {
    setNativeInvoke(vi.fn(async () => Promise.reject(new Error('native dialog failed'))));
    const { onFile, onError } = renderShell();

    fireEvent.click(screen.getByRole('option', { name: 'Open tournament file…' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('native dialog failed'));

    expect(onFile).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('forwards browser success once and closes the menu', async () => {
    const { onFile, view } = renderShell();
    const input = shellFileInput(view);
    const file = browserFile('shell.qbj', [6, 7, 8]);
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });

    fireEvent.change(input);
    await waitFor(() => expect(onFile).toHaveBeenCalledTimes(1));

    expect(onFile).toHaveBeenCalledWith({ fileName: 'shell.qbj', bytes: new Uint8Array([6, 7, 8]) });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('treats browser cancellation as a silent no-op', () => {
    const { onFile, onError, view } = renderShell();
    const input = shellFileInput(view);
    Object.defineProperty(input, 'files', { configurable: true, value: [] });

    fireEvent.change(input);

    expect(onFile).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  test('surfaces browser read failures without importing or rejecting', async () => {
    const { onFile, onError, view } = renderShell();
    const input = shellFileInput(view);
    const file = browserFile('broken.qbj', [9], new Error('browser read failed'));
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });

    fireEvent.change(input);
    await waitFor(() => expect(onError).toHaveBeenCalledWith('browser read failed'));

    expect(onFile).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
