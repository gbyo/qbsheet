/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    />,
  );
}

afterEach(cleanup);

describe('accepted-result acknowledgement', () => {
  test('offers a clearly separate Excel scoresheet after completion', () => {
    show(record());

    expect(screen.getByRole('button', { name: 'Download Excel scoresheet' })).toBeInTheDocument();
    expect(screen.getByText(/Excel is a readable scoresheet for review/)).toBeInTheDocument();
  });

  test('puts the next connected-room action before the optional copy section', () => {
    show(record());

    const next = screen.getByRole('button', { name: 'Done' });
    const copy = screen.getByText('Download or export a copy');
    expect(next).toHaveClass('is-primary');
    expect(next.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(copy.closest('details')).not.toHaveAttribute('open');
  });

  test('the existing accepted status receives the stamp only for a freshly accepted result', () => {
    show(record(), true);

    const accepted = screen.getByText('Result sent').closest('.final-accepted');
    expect(accepted).toHaveClass('is-newly-accepted');
    expect(accepted).toHaveAttribute('data-acceptance-motion', 'new');
    expect(accepted?.querySelector('.final-accepted-mark')).toBeTruthy();
  });

  test('remounting an already accepted result does not replay the stamp', () => {
    show(record());

    expect(screen.getByText('Result sent').closest('.final-accepted')).not.toHaveClass('is-newly-accepted');
  });

  test('offline/manual completion cannot display server acceptance', () => {
    show(record({ connected: false, serverDelivery: 'none' }), true);

    expect(document.querySelector('.final-accepted')).toBeNull();
  });
});

describe('pending-result delivery', () => {
  test('can return to the scorekeeper while the handoff gate remains locked', () => {
    const onBackToScorekeeper = vi.fn();
    render(
      <CompletionScreen
        record={record({
          serverDelivery: 'pending',
          serverDeliveryLedger: { attemptCount: 2, retryable: true, outcome: 'pending' },
        })}
        onUpdate={vi.fn()}
        onBackToScorekeeper={onBackToScorekeeper}
        onHome={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    const back = screen.getByRole('button', { name: 'Back to scorekeeper' });
    expect(back).toBeEnabled();
    fireEvent.click(back);
    expect(onBackToScorekeeper).toHaveBeenCalledOnce();
  });

  test('explains automatic retry while keeping the handoff gate closed', () => {
    show(
      record({
        serverDelivery: 'pending',
        serverDeliveryLedger: { attemptCount: 2, retryable: true, outcome: 'pending' },
      }),
    );

    expect(screen.getByText(/QBSheet will keep trying automatically while it is open/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Download QBJ$/ })).toBeTruthy();
  });

  test('acceptance updates the receipt and unlocks continuation', () => {
    const view = show(
      record({
        serverDelivery: 'pending',
        serverDeliveryLedger: { attemptCount: 1, retryable: true, outcome: 'pending' },
      }),
    );

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
      />,
    );

    expect(screen.getByText('Result sent')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });
});
