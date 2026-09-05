/** @vitest-environment jsdom */

import { render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import NativeDialog from '../src/app/NativeDialog';

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

afterEach(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

describe('NativeDialog lifecycle', () => {
  test('does not issue a close request when the parent unmounts it', () => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
    const close = vi.fn(function close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    });
    HTMLDialogElement.prototype.close = close;

    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();

    const view = render(
      <NativeDialog title="Example" onClose={onClose}>
        <p>Dialog contents</p>
      </NativeDialog>,
    );

    view.unmount();

    expect(close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
