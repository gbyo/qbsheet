/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ConfirmTestProvider, type ConfirmRequest, useConfirm } from './Dialog';

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

  test('resolves true only after the confirm action, false on cancel', async () => {
    const onReady = vi.fn<(confirm: ConfirmFunction) => void>();
    render(
      <ConfirmProvider>
        <ConfirmHandle onReady={onReady} />
      </ConfirmProvider>,
    );
    const confirm = onReady.mock.calls[0][0];

    let approved!: Promise<boolean>;
    await act(async () => {
      approved = confirm(request('Delete team?'));
    });
    expect(screen.getByRole('alertdialog', { name: 'Delete team?' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve Delete team?' }));
    });
    await expect(approved).resolves.toBe(true);

    let cancelled!: Promise<boolean>;
    await act(async () => {
      cancelled = confirm(request('Remove room?'));
    });
    expect(screen.getByRole('alertdialog', { name: 'Remove room?' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await expect(cancelled).resolves.toBe(false);
  });

  test('treats Escape as cancellation', async () => {
    const onReady = vi.fn<(confirm: ConfirmFunction) => void>();
    render(
      <ConfirmProvider>
        <ConfirmHandle onReady={onReady} />
      </ConfirmProvider>,
    );
    const confirm = onReady.mock.calls[0][0];

    let escaped!: Promise<boolean>;
    await act(async () => {
      escaped = confirm(request('Delete team?'));
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Delete team?' });
    await act(async () => {
      // jsdom never synthesizes platform Escape; the `cancel` event is what
      // the native dialog delivers for it.
      fireEvent(dialog, new Event('cancel', { cancelable: true }));
    });
    await expect(escaped).resolves.toBe(false);
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

describe('useConfirm without a provider', () => {
  test('fails closed instead of auto-approving', async () => {
    const onReady = vi.fn<(confirm: ConfirmFunction) => void>();
    render(<ConfirmHandle onReady={onReady} />);
    const confirm = onReady.mock.calls[0][0];

    await expect(
      confirm({ title: 'Delete team?', confirmLabel: 'Delete team', tone: 'danger' }),
    ).resolves.toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('blocks a representative destructive action mounted in isolation', async () => {
    const onDelete = vi.fn();
    function DeleteTeam() {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={async () => {
            if (await confirm({ title: 'Delete team?', confirmLabel: 'Delete team', tone: 'danger' })) {
              onDelete();
            }
          }}
        >
          Delete team
        </button>
      );
    }

    render(<DeleteTeam />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete team' }));
    });

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('ConfirmTestProvider opts isolated mounts into an explicit canned response', async () => {
    const onReady = vi.fn<(confirm: ConfirmFunction) => void>();
    const approved = render(
      <ConfirmTestProvider response>
        <ConfirmHandle onReady={onReady} />
      </ConfirmTestProvider>,
    );
    await expect(onReady.mock.calls[0][0](request('A'))).resolves.toBe(true);
    approved.unmount();

    const denied = render(
      <ConfirmTestProvider response={false}>
        <ConfirmHandle onReady={onReady} />
      </ConfirmTestProvider>,
    );
    await expect(onReady.mock.calls[1][0](request('B'))).resolves.toBe(false);
    denied.unmount();
  });
});
