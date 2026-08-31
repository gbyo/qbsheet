import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ManualGameSetup from '../src/app/ManualGameSetup';

afterEach(cleanup);

describe('Create Game format summary', () => {
  test('shows the parsed scoring and room procedure before Start game', () => {
    render(<ManualGameSetup onStart={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Left team name'), { target: { value: 'Ninety Six' } });
    fireEvent.change(screen.getByLabelText('Right team name'), { target: { value: 'Greenwood' } });
    fireEvent.change(screen.getByLabelText('Ninety Six players'), {
      target: { value: 'Smith, John\nGarcia' },
    });
    fireEvent.change(screen.getByLabelText('Greenwood players'), { target: { value: 'Nguyen' } });

    const summary = screen.getByRole('heading', { name: 'Game format' }).closest('section');
    if (!(summary instanceof HTMLElement)) throw new Error('Game format summary is not in a section');

    expect(within(summary).getByText(/20 tossups/)).toBeInTheDocument();
    expect(within(summary).getByText(/\+10 \/ -5/)).toBeInTheDocument();
    expect(within(summary).getByText(/4 players/)).toBeInTheDocument();
    expect(within(summary).getByText(/30-point bonuses/)).toBeInTheDocument();
    expect(within(summary).getByText(/untimed/)).toBeInTheDocument();
    expect(within(summary).getByText(/no breaks/)).toBeInTheDocument();
  });
});
