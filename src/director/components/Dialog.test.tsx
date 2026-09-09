/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, type ConfirmRequest, useConfirm } from './Dialog';

afterEach(cleanup);

const request = (title: string): ConfirmRequest => ({
  title,
  body: `${title} body`,
  confirmLabel: `Approve ${title}`,
});

type ConfirmFunction = (request: ConfirmRequest) => Promise<boolean>;

function ConfirmHandle({ onReady }: { onReady: (confirm: ConfirmFunction) => void }) {
  const confirm = useConfirm();
  useEffect(() => onReady(confirm), [confirm, onReady]);
  return null;
}

describe('ConfirmProvider', () => {
  test('queues same-tick requests and settles each caller in FIFO order', async () => {
    const onReady = vi.fn<(confirm: ConfirmFunction) => void>();
    render(
      <ConfirmProvider>
        <ConfirmHandle onReady={onReady} />
      </ConfirmProvider>,
    );
    const confirm = onReady.mock.calls[0][0];
    let firstSettled = 0;
    let secondSettled = 0;
    let thirdSettled = 0;
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    let third!: Promise<boolean>;

    await act(async () => {
      first = confirm(request('A')).then((value) => {
        firstSettled += 1;
        return value;
      });
      second = confirm(request('B')).then((value) => {
        secondSettled += 1;
        return value;
      });
      third = confirm(request('C')).then((value) => {
        thirdSettled += 1;
        return value;
      });
    });

    expect(screen.getByRole('alertdialog', { name: 'A' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve A' }));
    });
    expect(screen.getByRole('alertdialog', { name: 'B' })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(screen.getByRole('alertdialog', { name: 'C' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve C' }));
    });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    await expect(third).resolves.toBe(true);
    expect([firstSettled, secondSettled, thirdSettled]).toEqual([1, 1, 1]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('cancels all pending callers when the provider unmounts', async () => {
    const onReady = vi.fn<(confirm: ConfirmFunction) => void>();
    const view = render(
      <ConfirmProvider>
        <ConfirmHandle onReady={onReady} />
      </ConfirmProvider>,
    );
    const confirm = onReady.mock.calls[0][0];
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;

    await act(async () => {
      first = confirm(request('A'));
      second = confirm(request('B'));
    });
    expect(screen.getByRole('alertdialog', { name: 'A' })).toBeInTheDocument();

    await act(async () => {
      view.unmount();
    });

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });
});
