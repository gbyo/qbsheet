/**
 * @vitest-environment jsdom
 */

/**
 * The forms in the Director shell itself, held to one contract.
 *
 * New tournament and Tournament details open on their first field, submit on Enter, disable the
 * primary action while the required name is blank, and trim the name they store. Operator profile
 * did none of the first three — it opened with focus nowhere, ignored Enter, and offered a Save
 * button that accepted the click and returned without saving, closing, or saying anything — and the
 * start screen did not do the fourth. A control that looks live and silently refuses is worse than
 * one that is visibly unavailable.
 */
import { IDBFactory } from 'fake-indexeddb';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import DirectorApp from '../src/director/app/DirectorApp';

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;
const originalScrollTo = window.scrollTo;

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  window.scrollTo = () => {};
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

afterEach(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
  window.scrollTo = originalScrollTo;
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** The shell with a tournament open, which is the only state that has an operator menu. */
async function openDirector() {
  render(<DirectorApp />);
  await waitFor(() => expect(screen.getByText('Create or open a tournament')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Tournament name'), {
    target: { value: 'Ninety Six Invitational' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create tournament' }));
  await waitFor(() => expect(screen.getByRole('navigation', { name: 'Tournament sections' })).toBeTruthy());
}

async function openOperatorDialog() {
  await openDirector();
  fireEvent.click(screen.getByRole('button', { name: /^Operator:/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Operator profile…' }));
  return screen.getByLabelText('Display name') as HTMLInputElement;
}

/**
 * The start screen stored whatever whitespace was typed.
 *
 * `New tournament…` trims; this screen did not, so a stray leading space rode into the sidebar
 * switcher, the breadcrumb, every export filename, and the archive name — none of which show it.
 */
test('a tournament name is stored trimmed, as the New tournament dialog stores it', async () => {
  render(<DirectorApp />);
  await waitFor(() => expect(screen.getByText('Create or open a tournament')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Tournament name'), {
    target: { value: '  Ninety Six Invitational  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create tournament' }));

  const switcher = await screen.findByRole('button', { name: /^Tournament: / });
  expect(switcher.getAttribute('aria-label')).toBe('Tournament: Ninety Six Invitational. Switch tournament');
});

test('the dialog opens on its first field', async () => {
  const displayName = await openOperatorDialog();

  expect(document.activeElement).toBe(displayName);
});

test('Save is unavailable while the name is blank rather than silently refusing the click', async () => {
  const displayName = await openOperatorDialog();
  fireEvent.change(displayName, { target: { value: '   ' } });

  const save = screen.getByRole('button', { name: 'Save' });
  expect(save).toBeDisabled();
  fireEvent.click(save);
  // Still open, still on the dialog: nothing was saved and nothing pretended to be.
  expect(screen.getByLabelText('Display name')).toBeTruthy();
});

test('Enter in a field saves, the way it does in the other Director dialogs', async () => {
  const displayName = await openOperatorDialog();
  fireEvent.change(displayName, { target: { value: 'Gibson Bell' } });
  fireEvent.submit(displayName.closest('form') as HTMLFormElement);

  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Operator profile saved.'));
  expect(screen.queryByLabelText('Display name')).toBeNull();
});
