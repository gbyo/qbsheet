/**
 * A packet's row says what the packet *is*, and offers only what can actually be done to it.
 *
 * The packet already in force used to render a button reading `Current` whose press re-selected the
 * packet that was already selected: a control shaped like an action that could not act. And `Import
 * QBJ` accepted `application/json`, which put every unrelated JSON file on the machine in front of
 * a director looking for a packet list.
 *
 * The redesign also renamed the concept. `Current` and `Use next` never said what they governed;
 * the packet is the default for *newly generated rounds*, and a round can still be given a
 * different packet from Tournament day. The names now say that.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { tournamentState } from '../../../tests/directorFixtures';
import { PacketsView } from './PacketsView';
import { ConfirmProvider } from '../components/Dialog';

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

function renderPackets(controller = controllerWith(), state = stateWithPackets(), onAnnounce = vi.fn()) {
  render(
    <ConfirmProvider>
      <PacketsView state={state} controller={controller} onAnnounce={onAnnounce} />
    </ConfirmProvider>,
  );
  return controller;
}

/** Low-frequency packet actions live in the row's overflow menu, not in row chrome. */
function openPacketMenu(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: `${name} actions` }));
}

test('the default packet is a status, not a button', () => {
  renderPackets();

  expect(screen.queryByRole('button', { name: /Default for new rounds/ })).toBeNull();
  const label = screen.getByText('Default for new rounds');
  expect(label.closest('button')).toBeNull();
  expect(label.closest('.director-state')).not.toBeNull();
});

test('a packet that is not the default can be made the default', () => {
  const controller = renderPackets();

  // The packet already in force does not offer it, so the action cannot be a no-op.
  openPacketMenu('Packet A');
  expect(screen.queryByRole('menuitem', { name: 'Make default for new rounds' })).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });

  openPacketMenu('Packet B');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Make default for new rounds' }));
  expect(controller.selectPacket).toHaveBeenCalledWith('packet-2');
});

test('Import QBJ asks for QBJ files rather than any JSON on the machine', () => {
  renderPackets();

  fireEvent.click(screen.getByRole('button', { name: /^Import/ }));
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
test('a retired packet is not offered as a default at all', () => {
  const state = stateWithPackets();
  state.packets[1].retired = true;

  renderPackets(controllerWith(), state);
  openPacketMenu('Packet B');

  // Prevented rather than refused: the action a retired packet cannot perform
  // is not presented, so there is no press that fails.
  expect(screen.queryByRole('menuitem', { name: 'Make default for new rounds' })).toBeNull();
  expect(screen.getByRole('menuitem', { name: /Restore/ })).toBeTruthy();
});

test('a packet the controller refuses to add is announced as an error', () => {
  const onAnnounce = vi.fn();
  const controller = {
    ...controllerWith(),
    addPacket: vi.fn(() => false),
  } as unknown as DirectorController;

  renderPackets(controller, stateWithPackets(), onAnnounce);
  fireEvent.click(screen.getByRole('button', { name: 'Add packet' }));
  fireEvent.change(screen.getByLabelText('Packet name'), { target: { value: 'Packet C' } });
  const dialog = document.querySelector('dialog[open]') as HTMLElement;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add packet' }));

  expect(onAnnounce).toHaveBeenCalledWith({
    message: 'Packet was not added; review the Director error.',
    tone: 'error',
  });
});
