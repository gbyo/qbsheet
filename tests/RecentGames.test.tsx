import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import RecentGames from '../src/app/RecentGames';
import { IStoredGameRecord } from '../src/game/GameStore';
import { validPackage } from './packages';

function record(overrides: Partial<IStoredGameRecord> = {}): IStoredGameRecord {
  return {
    version: 1,
    id: 'match:sm-4471',
    identity: 'match:sm-4471',
    attempt: 1,
    gameKey: 'sess-1',
    package: validPackage(),
    setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
    events: [],
    connected: true,
    createdAt: '2026-08-11T14:00:00.000Z',
    updatedAt: '2026-08-11T15:00:00.000Z',
    completedAt: '2026-08-11T14:00:00.000Z',
    finalQbj: { tossups_read: 20 },
    finalScore: { left: 100, right: 90 },
    serverDelivery: 'sent',
    ...overrides,
  };
}

function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

describe('Recent Games operational ledger', () => {
  test('keeps server, QBJ, handoff, and replay attempt facts distinct', () => {
    render(
      <RecentGames
        records={[
          record({
            id: 'match:sm-4471#2',
            attempt: 2,
            serverDeliveryLedger: {
              attemptCount: 2,
              acceptedAt: '2026-08-11T14:42:00.000Z',
              acceptedAsDuplicate: true,
              matchId: 'sm-4471',
              fingerprint: 'opaque-fingerprint',
              outcome: 'accepted',
            },
            qbjDownloadedAt: '2026-08-11T14:43:00.000Z',
            handoffAcknowledgedAt: '2026-08-11T14:44:00.000Z',
          }),
          record({
            id: 'match:sm-4471',
            serverDelivery: 'sent',
            serverDeliveryLedger: undefined,
            qbjDownloadedAt: undefined,
            handoffAcknowledgedAt: undefined,
          }),
        ]}
        onOpen={vi.fn()}
        canRetry={() => false}
      />,
    );

    expect(screen.getAllByText('Receipts and attempts')).toHaveLength(2);
    expect(screen.getByText(`Already received · ${localTime('2026-08-11T14:42:00.000Z')}`)).toBeInTheDocument();
    expect(screen.getByText('2 attempts · Match sm-4471')).toBeInTheDocument();
    expect(screen.getByText(`Downloaded · ${localTime('2026-08-11T14:43:00.000Z')}`)).toBeInTheDocument();
    expect(screen.getByText(`Confirmed · ${localTime('2026-08-11T14:44:00.000Z')}`)).toBeInTheDocument();
    expect(screen.getAllByText('Accepted')).toHaveLength(1);
    expect(screen.queryByText('opaque-fingerprint')).toBeNull();
  });

  test('offers an explicit retry only when the private capability says it is useful', async () => {
    const onRetry = vi.fn(async () => undefined);
    render(
      <RecentGames
        records={[
          record({
            serverDelivery: 'pending',
            serverDeliveryLedger: {
              attemptCount: 1,
              lastAttemptedAt: '2026-08-11T14:42:00.000Z',
              retryable: true,
              outcome: 'pending',
            },
          }),
          record({ id: 'match:other', serverDelivery: 'rejected' }),
        ]}
        onOpen={vi.fn()}
        onRetry={onRetry}
        canRetry={(candidate) => candidate.id === 'match:sm-4471'}
      />,
    );

    expect(
      screen.getByText(`Not delivered yet · Last tried ${localTime('2026-08-11T14:42:00.000Z')}`),
    ).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry sending result' });
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'match:sm-4471' })));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
