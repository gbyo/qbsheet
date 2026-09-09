import { fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { DirectorMenu } from './DirectorMenu';
import { MenuItem, MenuNote, MenuSectionLabel } from './Menu';

function Harness({
  items = ['Alpha', 'Bravo', 'Charlie'],
  onSelect,
}: {
  items?: string[];
  onSelect?: (item: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={openerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          (openerRef as React.MutableRefObject<HTMLElement | null>).current = event.currentTarget;
          setOpen((value) => !value);
        }}
      >
        Open
      </button>
      {open && (
        <DirectorMenu label="Test menu" openerRef={openerRef} onClose={() => setOpen(false)}>
          <MenuSectionLabel>Letters</MenuSectionLabel>
          {items.map((item) => (
            <MenuItem key={item} onSelect={() => onSelect?.(item)}>
              {item}
            </MenuItem>
          ))}
          <MenuNote>Three of them.</MenuNote>
        </DirectorMenu>
      )}
    </>
  );
}

function CallbackHarness({ onClose }: { onClose: () => void }) {
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(false);

  useLayoutEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }, [onClose]);

  return (
    <>
      <button ref={openerRef} type="button">
        Open
      </button>
      <DirectorMenu label="Test menu" openerRef={openerRef} onClose={onClose}>
        <MenuItem onSelect={() => {}}>Alpha</MenuItem>
      </DirectorMenu>
    </>
  );
}

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
}

function search() {
  return screen.getByRole('combobox', { name: 'Search test menu' });
}

describe('DirectorMenu', () => {
  test('opens onto the filter field with every entry offered', () => {
    render(<Harness />);
    open();

    expect(search()).toHaveFocus();
    expect(screen.getAllByRole('option').map((item) => item.textContent)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
  });

  test('typing narrows the entries and selects the best match for Enter', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    open();

    fireEvent.change(search(), { target: { value: 'brav' } });

    expect(screen.getAllByRole('option').map((item) => item.textContent)).toEqual(['Bravo']);
    expect(screen.getByRole('option', { name: 'Bravo' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('Bravo');
  });

  test('a search that matches nothing says so instead of emptying the menu', () => {
    render(<Harness />);
    open();

    fireEvent.change(search(), { target: { value: 'zulu' } });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Nothing matches “zulu”.')).toBeInTheDocument();
  });

  test('the furniture describing the unfiltered list stands down while searching', () => {
    render(<Harness />);
    open();
    expect(screen.getByText('Letters')).toBeInTheDocument();
    expect(screen.getByText('Three of them.')).toBeInTheDocument();

    fireEvent.change(search(), { target: { value: 'a' } });

    expect(screen.queryByText('Letters')).toBeNull();
    expect(screen.queryByText('Three of them.')).toBeNull();
  });

  test('Escape clears a search in flight before it closes the menu', () => {
    render(<Harness />);
    open();
    fireEvent.change(search(), { target: { value: 'brav' } });

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(screen.getByRole('listbox', { name: 'Test menu' })).toBeInTheDocument();
    expect(search()).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(3);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  test('Escape closes and returns focus to the opener', () => {
    render(<Harness />);
    open();
    expect(screen.getByRole('listbox', { name: 'Test menu' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  test('Tab closes without preventing normal keyboard travel', () => {
    render(<Harness />);
    open();

    const tabWasNotPrevented = fireEvent.keyDown(document.activeElement!, { key: 'Tab' });

    expect(tabWasNotPrevented).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('clicking outside closes without stealing focus', () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <Harness />
      </>,
    );
    open();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('ArrowDown/ArrowUp/Home/End travel between entries', () => {
    render(<Harness />);
    open();
    const selected = () => screen.getByRole('option', { selected: true }).textContent;

    // Opening selects the first entry; focus stays in the field so typing keeps filtering.
    expect(selected()).toBe('Alpha');
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(selected()).toBe('Bravo');
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(selected()).toBe('Charlie');
    // `loop` is on, so the end wraps rather than dead-ends.
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(selected()).toBe('Alpha');
    fireEvent.keyDown(search(), { key: 'End' });
    expect(selected()).toBe('Charlie');
    fireEvent.keyDown(search(), { key: 'Home' });
    expect(selected()).toBe('Alpha');
    expect(search()).toHaveFocus();
  });

  test('clicking an entry runs it', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    open();

    fireEvent.click(screen.getByRole('option', { name: 'Charlie' }));

    expect(onSelect).toHaveBeenCalledWith('Charlie');
  });

  test('Escape uses the close callback from the current commit', () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const view = render(<CallbackHarness onClose={firstClose} />);

    view.rerender(<CallbackHarness onClose={secondClose} />);

    expect(firstClose).not.toHaveBeenCalled();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });
});
