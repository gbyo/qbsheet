/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { DocumentTransitionLoading } from '../src/director/app/DirectorApp';

describe('Director document transition loading copy', () => {
  test('uses routine opening language for an ordinary tournament switch', () => {
    render(<DocumentTransitionLoading transition={{ kind: 'switching', tournamentId: 'tournament-b' }} />);

    expect(screen.getByRole('status')).toHaveTextContent('Opening tournament…');
    expect(screen.getByRole('status')).not.toHaveTextContent(/recovery/i);
  });

  test('keeps checkpoint restoration language specific to recovery', () => {
    render(
      <DocumentTransitionLoading
        transition={{ kind: 'restoring-checkpoint', checkpointId: 'checkpoint-1' }}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Restoring recovery point…');
  });

  test('describes whole-document recovery edits separately from opening', () => {
    render(<DocumentTransitionLoading transition={{ kind: 'recovery-edit', reason: 'Repair bracket' }} />);

    expect(screen.getByRole('status')).toHaveTextContent('Applying recovery edit…');
  });
});
