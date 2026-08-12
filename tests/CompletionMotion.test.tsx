/**
 * @vitest-environment jsdom
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
      onHome={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('accepted-result acknowledgement', () => {
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
