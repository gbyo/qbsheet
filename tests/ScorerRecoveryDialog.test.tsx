/** @vitest-environment jsdom */

import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecoveryDialog } from '../src/scorer/OperationsDialogs';
import { scorerRecoveryKey, legacyScorerRecoveryVersion } from '../src/scorer/ScorerRecovery';

const setup = {
  left: { name: 'Central A', players: ['Alice'] },
  right: { name: 'East A', players: ['Bob'] },
};

const expectedIdentity = {
  tournamentId: 'tournament-1',
  matchId: 'round-8-match',
  leftTeamName: 'Central A',
  rightTeamName: 'East A',
};

describe('manual scorer recovery review', () => {
  test('requires explicit review for a legacy file and leaves the safe action as cancel', async () => {
    const onRestore = vi.fn();
    render(
      <RecoveryDialog
        expectedIdentity={expectedIdentity}
        tournamentName="Spring Invitational"
        roundName="Round 8"
        onRestore={onRestore}
        onClose={() => undefined}
      />,
    );

    const contents = JSON.stringify({
      [scorerRecoveryKey]: {
        version: legacyScorerRecoveryVersion,
        setup,
        events: [],
      },
    });
    const file = {
      name: 'round-2-central-east.qbj',
      lastModified: Date.parse('2026-09-08T14:42:00.000Z'),
      text: () => Promise.resolve(contents),
    } as unknown as File;
    fireEvent.change(screen.getByLabelText('QBJ backup'), { target: { files: [file] } });

    expect(await screen.findByText(/cannot be proven to belong/i)).toBeInTheDocument();
    expect(screen.getByText('Round 8 · Central A vs East A')).toBeInTheDocument();
    expect(screen.getByText(/round-2-central-east\.qbj/)).toBeInTheDocument();
    expect(screen.getByText(/No Director match ID/)).toBeInTheDocument();
    expect(onRestore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('QBJ backup')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('QBJ backup'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Restore after review' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restore after review' }));
    expect(onRestore).toHaveBeenCalledWith([]);
  });
});
