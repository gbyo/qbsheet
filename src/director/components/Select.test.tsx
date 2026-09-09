/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Combobox, Select } from './Select';

afterEach(() => {
  vi.restoreAllMocks();
});

function spyOnKeyWarnings() {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  return errors;
}

function expectNoDuplicateKeyWarnings(errors: string[]) {
  expect(errors.filter((message) => /duplicate|same key/i.test(message))).toEqual([]);
}

function openSelect(ui: ReactElement) {
  render(ui);
  fireEvent.click(screen.getByRole('combobox'));
  return screen.getByRole('listbox');
}

describe('Select grouping', () => {
  test('merges a repeated named group instead of emitting duplicate keys', () => {
    const errors = spyOnKeyWarnings();
    const onChange = vi.fn();
    const listbox = openSelect(
      <Select
        value={null}
        ariaLabel="Packet"
        options={[
          { value: 'a1', label: 'A1', group: 'Group A' },
          { value: 'b1', label: 'B1', group: 'Group B' },
          { value: 'a2', label: 'A2', group: 'Group A' },
        ]}
        onChange={onChange}
      />,
    );

    expect(within(listbox).getAllByRole('group', { name: 'Group A' })).toHaveLength(1);
    expect(within(listbox).getByRole('group', { name: 'Group A' })).toHaveTextContent('A1');
    expect(within(listbox).getByRole('group', { name: 'Group A' })).toHaveTextContent('A2');
    expect(within(listbox).getByRole('group', { name: 'Group B' })).toBeInTheDocument();
    expectNoDuplicateKeyWarnings(errors);

    fireEvent.pointerDown(within(listbox).getByRole('option', { name: 'A2' }));
    expect(onChange).toHaveBeenCalledWith('a2');
  });

  test('merges ungrouped runs separated by a named group', () => {
    const errors = spyOnKeyWarnings();
    const listbox = openSelect(
      <Select
        value={null}
        ariaLabel="Choice"
        options={[
          { value: 'x', label: 'X' },
          { value: 'g', label: 'G', group: 'Named' },
          { value: 'y', label: 'Y' },
        ]}
        onChange={() => {}}
      />,
    );

    expect(within(listbox).getByRole('option', { name: 'X' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Y' })).toBeInTheDocument();
    expect(within(listbox).getAllByRole('group', { name: 'Named' })).toHaveLength(1);
    expectNoDuplicateKeyWarnings(errors);
  });

  test('filtering that removes the middle group keeps one merged group', () => {
    const errors = spyOnKeyWarnings();
    render(
      <Combobox
        value=""
        ariaLabel="Zone"
        options={[
          { value: 'a1', label: 'Alpha one', group: 'Group A' },
          { value: 'b1', label: 'Beta one', group: 'Group B' },
          { value: 'a2', label: 'Alpha two', group: 'Group A' },
        ]}
        onChange={() => {}}
      />,
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'alpha' } });
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).queryByRole('group', { name: 'Group B' })).toBeNull();
    expect(within(listbox).getAllByRole('group', { name: 'Group A' })).toHaveLength(1);
    expect(within(listbox).getByRole('option', { name: 'Alpha one' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Alpha two' })).toBeInTheDocument();
    expectNoDuplicateKeyWarnings(errors);
  });
});
