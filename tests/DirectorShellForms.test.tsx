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
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Create a tournament' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Tournament name'), {
    target: { value: 'Ninety Six Invitational' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create tournament' }));
  await waitFor(() => expect(screen.getByRole('navigation', { name: 'Director sections' })).toBeTruthy());
}

/**
 * Operator identity is edited in Settings, which is the canonical surface for
 * it — the menu entry deep-links there rather than opening a second copy of the
 * same form in a dialog.
 */
async function openOperatorForm() {
  await openDirector();
  fireEvent.click(screen.getByRole('button', { name: /^Operator:/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Operator profile…' }));
  return (await screen.findByLabelText('Display name')) as HTMLInputElement;
}

/**
 * The start screen stored whatever whitespace was typed.
 *
 * `New tournament…` trims; this screen did not, so a stray leading space rode into the sidebar
 * switcher, the breadcrumb, every export filename, and the archive name — none of which show it.
 */
test('a tournament name is stored trimmed, as the New tournament dialog stores it', async () => {
  render(<DirectorApp />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Create a tournament' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Tournament name'), {
    target: { value: '  Ninety Six Invitational  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create tournament' }));

  const switcher = await screen.findByRole('button', { name: /^Tournament: / });
  expect(switcher.getAttribute('aria-label')).toContain('Tournament: Ninety Six Invitational.');
});

test('the operator menu entry lands on the operator settings, not a second copy of them', async () => {
  const displayName = await openOperatorForm();

  expect(displayName).toBeTruthy();
  // One canonical surface: the dialog that used to duplicate this form is gone.
  expect(document.querySelector('dialog[open]')).toBeNull();
});

test('Save is unavailable while the name is blank rather than silently refusing the click', async () => {
  const displayName = await openOperatorForm();
  fireEvent.change(displayName, { target: { value: '   ' } });

  const save = screen.getByRole('button', { name: 'Save operator' });
  expect(save).toBeDisabled();
  fireEvent.click(save);
  // Nothing was saved and nothing pretended to be.
  expect(screen.getByLabelText('Display name')).toBeTruthy();
});

test('Enter in a field saves, the way it does in every other Director form', async () => {
  const displayName = await openOperatorForm();
  fireEvent.change(displayName, { target: { value: 'Gibson Bell' } });
  fireEvent.submit(displayName.closest('form') as HTMLFormElement);

  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('Operator identity saved locally.'),
  );
  expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Gibson Bell');
});
