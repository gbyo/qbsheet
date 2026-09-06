/**
 * A packet's row says what the packet *is*, and offers only what can actually be done to it.
 *
 * The packet already in force used to render a button reading `Current` whose press re-selected the
 * packet that was already selected: a control shaped like an action that could not act. And `Import
 * QBJ` accepted `application/json`, which put every unrelated JSON file on the machine in front of
 * a director looking for a packet list.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { tournamentState } from '../../../tests/directorFixtures';
import { PacketsView } from './PacketsView';

afterEach(cleanup);

function stateWithPackets(): DirectorState {
  const state = tournamentState();
  state.packets.push(
    {
      id: 'packet-1',
      name: 'Packet A',
      source: 'manual',
      tiebreaker: false,
      assignedRoundIds: [],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
    },
    {
      id: 'packet-2',
      name: 'Packet B',
      source: 'manual',
      tiebreaker: false,
      assignedRoundIds: [],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
    },
  );
  if (state.tournament) state.tournament.currentPacketId = 'packet-1';
  return state;
}

function controllerWith(): DirectorController {
  return {
    selectPacket: vi.fn(() => true),
    setPacketRetired: vi.fn(() => true),
  } as unknown as DirectorController;
}

function renderPackets(controller = controllerWith()) {
  render(<PacketsView state={stateWithPackets()} controller={controller} onAnnounce={vi.fn()} />);
  return controller;
}

test('the current packet is a status, not a button', () => {
  renderPackets();

  expect(screen.queryByRole('button', { name: 'Current' })).toBeNull();
  const label = screen.getByText('Current');
  expect(label.closest('button')).toBeNull();
  expect(label.className).toContain('director-state');
});

test('a packet that is not current still offers Use next', () => {
  const controller = renderPackets();

  const useNext = screen.getAllByRole('button', { name: 'Use next' });
  expect(useNext).toHaveLength(1);
  useNext[0].click();
  expect(controller.selectPacket).toHaveBeenCalledWith('packet-2');
});

test('Import QBJ asks for QBJ files rather than any JSON on the machine', () => {
  renderPackets();

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input.accept).toBe('.qbj,application/vnd.quizbowl.qbj+json');
  expect(input.accept).not.toContain('application/json');
});

/**
 * A refusal reads as a refusal.
 *
 * `onAnnounce` takes either a bare string, which the shell renders with the success check and
 * `role="status"`, or a toned notice. Every rejection on this page passed a bare string, so
 * "Retired packets cannot be selected" arrived looking exactly like "Packet A selected".
 */
test('selecting a retired packet is announced as an error, not a success', () => {
  const onAnnounce = vi.fn();
  const state = stateWithPackets();
  state.packets[1].retired = true;

  render(<PacketsView state={state} controller={controllerWith()} onAnnounce={onAnnounce} />);
  screen.getAllByRole('button', { name: 'Use next' })[0].click();

  expect(onAnnounce).toHaveBeenCalledWith({
    message: 'Retired packets cannot be selected; restore it first.',
    tone: 'error',
  });
});

test('a packet the controller refuses to add is announced as an error', () => {
  const onAnnounce = vi.fn();
  const controller = {
    ...controllerWith(),
    addPacket: vi.fn(() => false),
  } as unknown as DirectorController;

  render(<PacketsView state={stateWithPackets()} controller={controller} onAnnounce={onAnnounce} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add packet' }));
  fireEvent.change(screen.getByLabelText('Packet name'), { target: { value: 'Packet C' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save packet' }));

  expect(onAnnounce).toHaveBeenCalledWith({
    message: 'Packet was not added; review the Director error.',
    tone: 'error',
  });
});
