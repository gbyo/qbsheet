/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MultiSelect } from './MultiSelect';

const options = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'bravo', label: 'Bravo' },
  { value: 'charlie', label: 'Charlie' },
];

function openMultiSelect(values: string[], onChange = vi.fn()) {
  render(<MultiSelect values={values} options={options} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select…' }));
  return { dialog: screen.getByRole('dialog'), onChange };
}

describe('MultiSelect', () => {
  test('normal selection uses the native checkbox and reports the selected value', () => {
    const { dialog, onChange } = openMultiSelect([]);
    const checkbox = within(dialog).getByRole('checkbox', { name: 'Bravo' });

    expect(checkbox).toBeEnabled();
    fireEvent.click(checkbox);

    expect(onChange).toHaveBeenCalledWith(['bravo']);
  });

  test('Select all selects every enabled option and counts only selectable options', () => {
    const mixedOptions = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'bravo', label: 'Bravo', disabled: true },
      { value: 'charlie', label: 'Charlie' },
      { value: 'delta', label: 'Delta', disabled: true },
    ];
    const onChange = vi.fn();
    const view = render(<MultiSelect values={[]} options={mixedOptions} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Select…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('0 of 2 selected')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Bravo' })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: 'Delta' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Select all' }));
    expect(onChange).toHaveBeenCalledWith(['alpha', 'charlie']);

    view.rerender(<MultiSelect values={['alpha', 'charlie']} options={mixedOptions} onChange={onChange} />);
    expect(within(screen.getByRole('dialog')).getByText('2 of 2 selected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull();
  });

  test('does not expose Select all when all options are disabled', () => {
    const allDisabledOptions = options.map((option) => ({ ...option, disabled: true }));
    const { dialog } = (() => {
      render(<MultiSelect values={[]} options={allDisabledOptions} onChange={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Select…' }));
      return { dialog: screen.getByRole('dialog') };
    })();

    expect(within(dialog).getByText('0 of 0 selected')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Select all' })).toBeNull();
    for (const checkbox of within(dialog).getAllByRole('checkbox')) {
      expect(checkbox).toBeDisabled();
    }
  });

  test('hides Select all when the only remaining options are disabled', () => {
    const mixedOptions = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'bravo', label: 'Bravo', disabled: true },
    ];
    render(<MultiSelect values={['alpha']} options={mixedOptions} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('1 of 1 selected')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Select all' })).toBeNull();
    expect(within(dialog).getByRole('checkbox', { name: 'Bravo' })).toBeDisabled();
  });

  test('updates select-all availability when disabled state changes', () => {
    const disabledOptions = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'bravo', label: 'Bravo', disabled: true },
    ];
    const enabledOptions = disabledOptions.map((option) => ({ ...option, disabled: false }));
    const onChange = vi.fn();
    const view = render(<MultiSelect values={['alpha']} options={disabledOptions} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull();

    view.rerender(<MultiSelect values={['alpha']} options={enabledOptions} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Select all' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(onChange).toHaveBeenCalledWith(['alpha', 'bravo']);
  });

  test('keeps a newly disabled selection out of the selectable count', () => {
    const enabledOptions = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'bravo', label: 'Bravo' },
    ];
    const disabledOptions = enabledOptions.map((option) => ({
      ...option,
      disabled: option.value === 'bravo',
    }));
    const view = render(
      <MultiSelect values={['alpha', 'bravo']} options={enabledOptions} onChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Alpha Bravo' }));
    expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull();

    view.rerender(<MultiSelect values={['alpha', 'bravo']} options={disabledOptions} onChange={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('1 of 1 selected')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Bravo' })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: 'Bravo' })).toBeChecked();
    expect(within(dialog).queryByRole('button', { name: 'Select all' })).toBeNull();
  });
});
