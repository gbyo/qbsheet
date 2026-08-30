import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import GameMenu, { joinMenuGroups, IGameMenuItem } from './GameMenu';

function item(label: string, options: Partial<IGameMenuItem> = {}): IGameMenuItem {
  return { label, icon: 'game', onSelect: vi.fn(), ...options };
}

describe('GameMenu', () => {
  test('renders quiet group labels outside the menu item sequence', () => {
    const items = joinMenuGroups(
      [[item('Game details')], [item('Full scoresheet review')], [item('Export / backup…')]],
      ['GAME', 'REVIEW', 'FILES'],
    );

    render(<GameMenu items={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'Game' }));

    expect(screen.getAllByRole('separator')).toHaveLength(2);
    expect(screen.getAllByText(/^(GAME|REVIEW|FILES)$/)).toHaveLength(3);
    expect(screen.getByText('GAME')).not.toHaveAttribute('tabindex');
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: 'Game details' })).toHaveFocus();
  });

  test('arrow navigation skips disabled entries and group labels', () => {
    const first = item('First');
    const disabled = item('Unavailable', { disabled: true });
    const last = item('Last');
    render(<GameMenu items={joinMenuGroups([[first], [disabled, last]], ['GAME', 'REVIEW'])} />);

    fireEvent.click(screen.getByRole('button', { name: 'Game' }));
    const firstButton = screen.getByRole('menuitem', { name: 'First' });
    const lastButton = screen.getByRole('menuitem', { name: 'Last' });
    fireEvent.keyDown(firstButton, { key: 'ArrowDown' });
    expect(lastButton).toHaveFocus();
    fireEvent.keyDown(lastButton, { key: 'ArrowUp' });
    expect(firstButton).toHaveFocus();
  });

  test('uses More as the compact trigger label without changing its accessible action', () => {
    render(<GameMenu items={[item('Details')]} compactLabel="More" />);

    expect(screen.getByRole('button', { name: 'Game' })).toBeInTheDocument();
  });
});
