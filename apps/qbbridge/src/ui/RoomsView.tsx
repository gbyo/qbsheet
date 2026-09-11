/**
 * The screen used between rounds: one row per room, two team pickers, one button.
 *
 * The pairing table is QBBridge's own, because stock YellowFruit's saved file does not carry an
 * authoritative list of future room-by-room pairings to publish. Nothing here generates a
 * schedule, advances a bracket, or refuses a matchup; it records the operator's choice.
 *
 * It is a real `<table>`. The content is tabular, a screen reader gets row and column context
 * for free, and a grid of `<div>`s with ARIA bolted on would be a worse version of what the
 * element already does.
 */

import { useMemo, useState } from 'react';
import { Button, ConfirmDialog, StatusBadge, TeamComboBox, type Tone } from '@qbsheet/ui';
import { pairingLink } from '../model/pairing';
import type { Room, RoomStatus } from '../model/rooms';
import type { BridgeApi } from '../model/useBridge';
import Qr from './Qr';

const status: Record<RoomStatus, { label: string; tone: Tone }> = {
  ready: { label: 'Ready', tone: 'neutral' },
  waiting: { label: 'Waiting', tone: 'info' },
  paired: { label: 'Paired', tone: 'info' },
  scoring: { label: 'Scoring', tone: 'info' },
  'result-received': { label: 'Result received', tone: 'success' },
};

export default function RoomsView({ bridge }: { bridge: BridgeApi }) {
  const { tournament, state } = bridge;
  const [pendingRound, setPendingRound] = useState<string | null>(null);
  const round = tournament?.rounds.find((entry) => entry.id === state.selectedRoundId) ?? null;

  const warningsByRoom = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const warning of bridge.warnings) {
      map.set(warning.roomId, [...(map.get(warning.roomId) ?? []), warning.message]);
    }
    return map;
  }, [bridge.warnings]);

  const teamOptions = useMemo(() => {
    if (!tournament) return [];
    const byName = new Map<string, number>();
    for (const team of tournament.teams) {
      byName.set(team.name, (byName.get(team.name) ?? 0) + 1);
    }
    return [...tournament.teams]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((team) => ({
        id: team.id,
        name: team.name,
        // Only where it is needed: two teams that read alike must stay tellable apart, and
        // every other row stays uncluttered.
        ...((byName.get(team.name) ?? 0) > 1 && team.poolNames.length > 0
          ? { detail: team.poolNames[0] }
          : {}),
      }));
  }, [tournament]);

  if (!tournament) {
    return (
      <section className="panel">
        <h2>Rooms</h2>
        <p className="muted">Load a YellowFruit file to choose teams.</p>
      </section>
    );
  }

  const linkFor = (room: Room): string | null => {
    if (!state.relay) return null;
    try {
      return pairingLink({
        baseUrl: state.relay.baseUrl,
        tournamentId: state.relay.tournamentId,
        code: room.pairingCode,
        roomId: room.id,
      }).url;
    } catch {
      return null;
    }
  };

  const requestRound = (roundId: string): void => {
    if (roundId === state.selectedRoundId) return;
    // Changing rounds clears every selection, so ask first when there is something to lose.
    if (bridge.roundChangeDiscardsSelections) setPendingRound(roundId);
    else bridge.selectRound(roundId);
  };

  const pendingRoundName = tournament.rounds.find((entry) => entry.id === pendingRound)?.qbjName ?? '';

  return (
    <section className="panel wide">
      <h2>Rooms</h2>
      <div className="row" style={{ marginBottom: 'var(--qbs-space-3)' }}>
        <label htmlFor="round">Round</label>
        {/* Eight rounds in a fixed list: a native select is the right control and needs no help. */}
        <select
          id="round"
          value={state.selectedRoundId ?? ''}
          onChange={(event) => requestRound(event.target.value)}
        >
          {tournament.rounds.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.phaseName ? `${entry.phaseName} · ` : ''}Round {entry.qbjName}
            </option>
          ))}
        </select>
        <Button onPress={bridge.addRoom}>+ Room</Button>
        <Button
          variant="quiet"
          isDisabled={bridge.busy || !state.relay || state.rooms.length === 0}
          onPress={() => void bridge.publishRoomSetup()}
        >
          Publish Room Setup
        </Button>
        <Button
          variant="primary"
          style={{ marginLeft: 'auto' }}
          isDisabled={bridge.busy || !state.relay || !round}
          onPress={() => void bridge.publish()}
        >
          {round ? `Publish Round ${round.qbjName}` : 'Publish'}
        </Button>
      </div>

      <p className="faint room-setup-hint">
        Publish Room Setup once before Round 1 to activate the room codes and pair scorers. It clears any
        active assignment without revoking room tokens; later rounds use the same pairing.
      </p>

      {state.rooms.length === 0 ? (
        <p className="muted">No rooms yet. Add one for each room the tournament is using.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Room</th>
              <th scope="col">Left</th>
              <th scope="col">Right</th>
              <th scope="col">Pairing</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="qbs-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state.rooms.map((room) => {
              const link = linkFor(room);
              const roomWarnings = warningsByRoom.get(room.id) ?? [];
              const state_ = status[bridge.roomStatus(room)];
              return (
                <tr key={room.id}>
                  <td>
                    <input
                      type="text"
                      size={12}
                      aria-label={`Name of ${room.name}`}
                      value={room.name}
                      onChange={(event) => bridge.renameRoom(room.id, event.target.value)}
                    />
                    {roomWarnings.length > 0 ? <div className="faint">{roomWarnings.join(' ')}</div> : null}
                  </td>
                  <td className="team-cell">
                    <TeamComboBox
                      label={`Left team in ${room.name}`}
                      options={teamOptions}
                      selectedId={room.leftTeamId}
                      onSelect={(id) => bridge.setRoomTeams(room.id, 'left', id)}
                    />
                  </td>
                  <td className="team-cell">
                    <TeamComboBox
                      label={`Right team in ${room.name}`}
                      options={teamOptions}
                      selectedId={room.rightTeamId}
                      onSelect={(id) => bridge.setRoomTeams(room.id, 'right', id)}
                    />
                  </td>
                  <td>
                    <div className="row">
                      <div>
                        <div className="row">
                          <span className="code">{room.pairingCode}</span>
                          <StatusBadge tone={room.relayPublished ? 'success' : 'neutral'}>
                            {room.relayPublished ? 'Active' : 'Not published'}
                          </StatusBadge>
                        </div>
                        {room.pendingPairingCode ? (
                          <div className="faint">
                            Pending — publish to activate:{' '}
                            <span className="code">{room.pendingPairingCode}</span>
                          </div>
                        ) : null}
                      </div>
                      {room.relayPublished && link ? <Qr url={link} roomName={room.name} /> : null}
                      <Button
                        size="sm"
                        variant="quiet"
                        isDisabled={bridge.busy}
                        onPress={() => bridge.regeneratePairingCode(room.id)}
                      >
                        New code
                      </Button>
                    </div>
                  </td>
                  <td>
                    <StatusBadge tone={state_.tone}>{state_.label}</StatusBadge>
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="quiet"
                      isDisabled={bridge.busy}
                      onPress={() => bridge.removeRoom(room.id)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="faint" style={{ marginTop: 'var(--qbs-space-3)' }}>
        QBBridge reports only what it can see from the relay: a room is Waiting from the moment its assignment
        is published until its result arrives. Publishing a round also clears the assignment of every room
        with no matchup, so an unused room cannot open last round&rsquo;s game.
      </p>

      <ConfirmDialog
        isOpen={pendingRound !== null}
        title={`Switch to Round ${pendingRoundName}?`}
        confirmLabel="Switch Round"
        onCancel={() => setPendingRound(null)}
        onConfirm={() => {
          const roundId = pendingRound;
          setPendingRound(null);
          if (roundId) bridge.selectRound(roundId);
        }}
      >
        The team selections in every room will be cleared, so this round&rsquo;s pairings have to be entered
        fresh. Rooms, their names and their pairing codes are kept, and nothing is sent to the relay until you
        publish.
      </ConfirmDialog>
    </section>
  );
}
