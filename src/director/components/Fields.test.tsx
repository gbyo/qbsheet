import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DirtyFormProvider, SaveState, useFormState } from './Fields';

afterEach(cleanup);

function FormHarness({ accepted = true }: { accepted?: boolean }) {
  const form = useFormState({
    initial: { value: 'saved' },
    onSubmit: vi.fn(() => accepted),
    formId: 'test-form',
    formLabel: 'Test form',
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        form.submit();
      }}
    >
      <input
        aria-label="Value"
        value={form.draft.value}
        onChange={(event) => form.set('value', event.target.value)}
      />
      <SaveState state={form.saveState} />
      <button type="submit">Save</button>
      <button type="button" onClick={() => form.reset()}>
        Reset
      </button>
    </form>
  );
}

function renderForm(accepted = true) {
  return render(
    <DirtyFormProvider>
      <FormHarness accepted={accepted} />
    </DirtyFormProvider>,
  );
}

test('shared form state marks edits, reports Saved after accepted save, and resets drafts', () => {
  renderForm();
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'draft' } });
  expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('status')).toHaveTextContent('Saved');

  fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'another draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(screen.getByLabelText('Value')).toHaveValue('draft');
});

test('rejected shared-form saves leave the draft dirty', () => {
  renderForm(false);
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'rejected draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
});
