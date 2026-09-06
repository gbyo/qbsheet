/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HelpDialog } from '../src/director/help/HelpDialog';

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

describe('Director help dialog', () => {
  test('reports one close when controlled state catches up after the close button', () => {
    const onClose = vi.fn();
    const { rerender } = render(<HelpDialog open onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<HelpDialog open={false} onClose={onClose} />);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('cancel uses the callback from the commit that is on screen', () => {
    const firstClose = vi.fn();
    const currentClose = vi.fn();

    function Harness({ onClose, cancelDuringLayout }: { onClose: () => void; cancelDuringLayout: boolean }) {
      useLayoutEffect(() => {
        if (!cancelDuringLayout) return;
        screen.getByRole('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
      }, [cancelDuringLayout]);
      return <HelpDialog open onClose={onClose} />;
    }

    const { rerender } = render(<Harness onClose={firstClose} cancelDuringLayout={false} />);
    rerender(<Harness onClose={currentClose} cancelDuringLayout />);

    expect(firstClose).not.toHaveBeenCalled();
    expect(currentClose).toHaveBeenCalledTimes(1);
  });
});
