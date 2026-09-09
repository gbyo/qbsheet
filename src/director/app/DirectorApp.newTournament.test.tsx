import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { NewTournamentDialog } from './DirectorApp';
import type { DirectorController } from '../state/useDirectorController';

function controllerReturning(created: boolean): DirectorController {
  return {
    createTournament: vi.fn(() => created),
  } as unknown as DirectorController;
}

describe('NewTournamentDialog creation contract', () => {
  test('keeps the draft open and does not announce success when creation is rejected', () => {
    const controller = controllerReturning(false);
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(<NewTournamentDialog controller={controller} onClose={onClose} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('Tournament name'), { target: { value: 'Rejected tournament' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create tournament' }));

    expect(controller.createTournament).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Rejected tournament')).toBeInTheDocument();
  });

  test('announces creation exactly once after the controller accepts it', () => {
    const controller = controllerReturning(true);
    const onCreated = vi.fn();
    render(<NewTournamentDialog controller={controller} onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('Tournament name'), { target: { value: 'Accepted tournament' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create tournament' }));

    expect(controller.createTournament).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith('Accepted tournament');
  });
});
