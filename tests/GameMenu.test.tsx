/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import GameMenu from '../src/scorer/GameMenu';

afterEach(cleanup);

describe('GameMenu focus and pointer ordering', () => {
  test('a Safari-style null-target blur does not remove the item before its click', () => {
    const endGame = vi.fn();
    render(
      <GameMenu
        items={[
          { label: 'Notes', icon: 'game', onSelect: vi.fn() },
          { label: 'End game early…', icon: 'game', onSelect: endGame },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Game' }));
    const notes = screen.getByRole('menuitem', { name: 'Notes' });
    const endGameItem = screen.getByRole('menuitem', { name: 'End game early…' });
    expect(document.activeElement).toBe(notes);

    fireEvent.mouseDown(endGameItem);
    fireEvent.blur(notes, { relatedTarget: null });

    expect(screen.getByRole('menuitem', { name: 'End game early…' })).toBe(endGameItem);
    fireEvent.click(endGameItem);

    expect(endGame).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('a known focus move outside the menu still dismisses it', () => {
    render(
      <>
        <GameMenu items={[{ label: 'Notes', icon: 'game', onSelect: vi.fn() }]} />
        <button type="button">Outside</button>
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Game' }));
    const notes = screen.getByRole('menuitem', { name: 'Notes' });
    const outside = screen.getByRole('button', { name: 'Outside' });

    fireEvent.blur(notes, { relatedTarget: outside });

    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('moves focus to a surviving item when the focused action disappears', () => {
    const notes = { label: 'Notes', icon: 'game' as const, onSelect: vi.fn() };
    const endGame = { label: 'End game early…', icon: 'game' as const, onSelect: vi.fn() };
    const { rerender } = render(<GameMenu items={[notes, endGame]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Game' }));
    const notesButton = screen.getByRole('menuitem', { name: 'Notes' });
    const endGameButton = screen.getByRole('menuitem', { name: 'End game early…' });
    fireEvent.keyDown(notesButton, { key: 'ArrowDown' });
    expect(endGameButton).toHaveFocus();

    rerender(<GameMenu items={[notes]} />);

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Notes' })).toHaveFocus();
  });
});
