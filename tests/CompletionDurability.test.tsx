/** @vitest-environment jsdom */

/**
 * A finished score is less recoverable than an in-progress one: the record carries the final QBJ
 * and tells the application it may leave the scorer. A memory fallback may keep the current tab
 * interactive, but it cannot support that transition. This drives the real completion review to
 * prove the screen stays put and offers the portable lifeboat instead.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ScoringScreen from '../src/app/ScoringScreen';
import { memoryGameStore } from '../src/game/GameStore';
import { setupFromPackage } from '../src/app/App';
import { ResultDeliveryService } from '../src/app/ResultDelivery';
import { ResultDeliveryCapabilityStore } from '../src/app/ResultDeliveryCapability';
import { validPackage } from './packages';
import { pressControl, startLineups } from './appHarness';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('finishing while only the non-durable fallback is available', () => {
  test('stays on the scorer and requires a QBJ backup instead of entering completion', async () => {
    const store = memoryGameStore();
    const packageValue = validPackage();
    const created = await store.create({
      package: packageValue,
      setup: setupFromPackage(packageValue),
      connected: false,
    });
    const record = await store.get(created.id);
    if (!record) throw new Error('the in-memory record was not available to the scorer');
    const onComplete = vi.fn();

    render(
      <ScoringScreen
        record={record}
        store={store}
        resultDelivery={new ResultDeliveryService(store, new ResultDeliveryCapabilityStore())}
        connection={null}
        durable={false}
        onComplete={onComplete}
        onRecordChanged={vi.fn()}
        onConnectionRepaired={vi.fn()}
        onConnectionLost={vi.fn()}
      />,
    );

    await startLineups();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'No buzz' }));
    });
    await pressControl('End game early…');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Why is the game ending early?'), {
        target: { value: 'Practice over' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'End the game now' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Final score confirmed with both teams'));
      fireEvent.click(screen.getByRole('button', { name: 'Submit result' }));
    });

    await waitFor(() => {
      expect(screen.getByText(/could not durably save the finished result/i)).toBeInTheDocument();
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Download QBJ backup' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Result saved on this Chromebook')).toBeNull();
    const afterRefusal = await store.get(record.id);
    expect(afterRefusal).not.toHaveProperty('completedAt');
    expect(afterRefusal).not.toHaveProperty('finalQbj');
    expect(afterRefusal).not.toHaveProperty('finalScore');
  });
});
