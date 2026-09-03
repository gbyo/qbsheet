/**
 * A packet's row says what the packet *is*, and offers only what can actually be done to it.
 *
 * The packet already in force used to render a button reading `Current` whose press re-selected the
 * packet that was already selected: a control shaped like an action that could not act. And `Import
 * QBJ` accepted `application/json`, which put every unrelated JSON file on the machine in front of
 * a director looking for a packet list.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
