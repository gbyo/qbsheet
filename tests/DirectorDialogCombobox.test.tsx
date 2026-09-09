/** @vitest-environment jsdom */

import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { Combobox } from '../src/director/components/Select';
import { Dialog } from '../src/director/components/Dialog';

const options = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'bravo', label: 'Bravo' },
];

function dispatchCancel(dialog: HTMLElement) {
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
}

describe('Director Dialog and Combobox Escape handling', () => {
  test('an open Combobox owns the first Escape, then the Dialog owns the second', async () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Edit" onClose={onClose}>
        <Combobox value="alpha" options={options} onChange={() => undefined} ariaLabel="Team" />
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByRole('combobox', { name: 'Team' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    const firstEscape = createEvent.keyDown(input, { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(input, firstEscape);
    expect(firstEscape.defaultPrevented).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(input).toHaveValue('Alpha');

    const secondEscape = createEvent.keyDown(input, { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(input, secondEscape);
    expect(secondEscape.defaultPrevented).toBe(false);
    dispatchCancel(dialog);
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('Escape from a focused closed Combobox reaches the enclosing Dialog and restores focus', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open editor</button>
          {open && (
            <Dialog title="Edit" onClose={() => setOpen(false)}>
              <Combobox value="alpha" options={options} onChange={() => undefined} ariaLabel="Team" />
            </Dialog>
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open editor' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByRole('combobox', { name: 'Team' });
    const closePopup = createEvent.keyDown(input, { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(input, closePopup);
    expect(screen.queryByRole('listbox')).toBeNull();

    const closeDialog = createEvent.keyDown(input, { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(input, closeDialog);
    expect(closeDialog.defaultPrevented).toBe(false);
    dispatchCancel(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  });
});
