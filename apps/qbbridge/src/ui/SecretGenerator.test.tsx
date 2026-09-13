import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import SecretGenerator from './SecretGenerator';

describe('SecretGenerator', () => {
  test('keeps generate and copy actions distinguishable when several generators share a page', async () => {
    const user = userEvent.setup();
    render(
      <>
        <SecretGenerator label="setup token" generate={() => 'setup-value'} />
        <SecretGenerator label="tournament ID" generate={() => 'tournament-value'} />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Generate setup token' }));
    await user.click(screen.getByRole('button', { name: 'Generate tournament ID' }));

    expect(screen.getByRole('button', { name: 'Generate another setup token' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate another tournament ID' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy setup token' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy tournament ID' })).toBeInTheDocument();
  });
});
