/**
 * @vitest-environment jsdom
 */

/**
 * How a result *changing* reads, as opposed to what it says.
 *
 * Two claims live here. The acceptance stamp is drawn once, for the submission that was accepted
 * while the room was watching, and never replayed for a record that was already accepted when the
 * screen opened — a stamp that fires on every visit is decoration rather than feedback. And the
 * delivery status is a polite live region, so a pending result that lands announces itself without
 * taking focus off whatever the scorekeeper was reaching for.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import CompletionScreen from '../src/app/CompletionScreen';
import { IStoredGameRecord } from '../src/game/GameStore';
import { validPackage } from './packages';

function record(overrides: Partial<IStoredGameRecord> = {}): IStoredGameRecord {
  return {
    version: 1,
    id: 'motion-result',
    identity: 'motion-result',
    attempt: 1,
    gameKey: 'motion-session',
    package: validPackage(),
    setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
    events: [],
    connected: true,
    createdAt: '2026-08-12T12:00:00.000Z',
    updatedAt: '2026-08-12T12:30:00.000Z',
    completedAt: '2026-08-12T12:30:00.000Z',
    finalQbj: { tossups_read: 20 },
    finalScore: { left: 120, right: 90 },
    serverDelivery: 'sent',
    ...overrides,
  };
}

function show(candidate: IStoredGameRecord, acceptedJustNow = false) {
  return render(
    <CompletionScreen
      record={candidate}
      acceptedJustNow={acceptedJustNow}
      onUpdate={vi.fn()}
      onBackToScorekeeper={vi.fn()}
      onHome={vi.fn()}
      continueLabel="Back to Room 204"
    />,
  );
}

afterEach(cleanup);

describe('the acceptance stamp', () => {
  test('is drawn for a result that was accepted while the room was watching', () => {
    show(record(), true);

    const accepted = screen.getByText(/Result sent/).closest('.final-accepted');
    expect(accepted).toHaveClass('is-newly-accepted');
    expect(accepted).toHaveAttribute('data-acceptance-motion', 'new');
    expect(accepted?.querySelector('.final-accepted-mark')).toBeTruthy();
  });

  test('is not replayed when an already accepted result is opened again', () => {
    show(record());

    expect(screen.getByText(/Result sent/).closest('.final-accepted')).not.toHaveClass('is-newly-accepted');
  });

  /**
   * The class means tournament control accepted this. A screen that has never spoken to tournament
   * control must not be able to grow it, whatever the navigation claimed on the way in.
   */
  test('cannot appear on a game that has no tournament control behind it', () => {
    show(record({ connected: false, serverDelivery: 'none' }), true);

    expect(document.querySelector('.final-accepted')).toBeNull();
  });
});

describe('a delivery that changes under the scorekeeper', () => {
  test('the status is one polite live region rather than a set of shouting fragments', () => {
    show(record({ serverDelivery: 'pending' }));

    const status = document.querySelector('.completion-status');
    expect(status).toHaveAttribute('role', 'status');
    // One region, announced once. Nested alerts would announce the same change twice.
    expect(status?.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  test('the screen changes in place when the result is accepted, without a reload or a new screen', () => {
    const view = show(record({ serverDelivery: 'pending' }));

    expect(screen.getByText('Sending result…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to Room 204' })).toBeNull();

    view.rerender(
      <CompletionScreen
        record={record({
          serverDelivery: 'sent',
          serverDeliveryLedger: {
            attemptCount: 2,
            retryable: false,
            outcome: 'accepted',
            acceptedAt: '2026-08-12T12:31:00.000Z',
          },
        })}
        acceptedJustNow={false}
        onUpdate={vi.fn()}
        onBackToScorekeeper={vi.fn()}
        onHome={vi.fn()}
        continueLabel="Back to Room 204"
      />,
    );

    expect(screen.getByText(/Result sent/)).toBeInTheDocument();
    expect(screen.queryByText('Sending result…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to Room 204' })).toBeEnabled();
    expect(document.querySelectorAll('.shell-button.is-primary')).toHaveLength(1);
  });
});
