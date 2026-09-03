import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, test } from 'vitest';
import { DirectorMenu } from './DirectorMenu';

function Harness({ items = ['Alpha', 'Bravo', 'Charlie'] }: { items?: string[] }) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={openerRef}
        type="button"
        aria-haspopup="menu"
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
          {items.map((item) => (
            <button key={item} role="menuitem" type="button" className="director-menu-item">
              {item}
            </button>
          ))}
        </DirectorMenu>
      )}
    </>
  );
}

describe('DirectorMenu', () => {
  test('Escape closes and returns focus to the opener', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  test('clicking outside closes without stealing focus', () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <Harness />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('ArrowDown/ArrowUp/Home/End travel between items', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    // Opening focuses the first item.
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Bravo' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Charlie' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Charlie' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
  });
});
