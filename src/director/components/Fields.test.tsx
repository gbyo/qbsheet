import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DirtyFormProvider, Field, SaveState, useFormState } from './Fields';

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

test('fields with an error and hint describe controls with the rendered error only', () => {
  render(
    <Field label="Name" error="Name is required" hint="Use your full name">
      <input />
    </Field>,
  );

  const input = screen.getByLabelText('Name');
  const error = screen.getByText('Name is required');

  expect(input).toHaveAttribute('aria-describedby', error.id);
  expect(screen.queryByText('Use your full name')).toBeNull();
});

test('fields with only a hint describe controls with the rendered hint', () => {
  render(
    <Field label="Name" hint="Use your full name">
      <input />
    </Field>,
  );

  const input = screen.getByLabelText('Name');
  const hint = screen.getByText('Use your full name');

  expect(input).toHaveAttribute('aria-describedby', hint.id);
});

test('fields without an error or hint have no generated description and preserve caller descriptions', () => {
  const { rerender } = render(
    <Field label="Name">
      <input />
    </Field>,
  );

  expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-describedby');

  rerender(
    <Field label="Name">
      <input aria-describedby="caller-description" />
    </Field>,
  );

  expect(screen.getByLabelText('Name')).toHaveAttribute('aria-describedby', 'caller-description');
});
