/**
 * The screen used between rounds: one row per room, two dropdowns, one button.
 *
 * The pairing table is QBBridge's own, because stock YellowFruit's saved file does not carry an
 * authoritative list of future room-by-room pairings to publish. Nothing here generates a
 * schedule, advances a bracket, or refuses a matchup; it records the operator's choice.
 */

import { useMemo } from 'react';
import { pairingLink } from '../model/pairing';
import type { Room, RoomStatus } from '../model/rooms';
import type { BridgeApi } from '../model/useBridge';
import Qr from './Qr';

const statusLabel: Record<RoomStatus, string> = {
  ready: 'Ready',
  waiting: 'Waiting',
  paired: 'Paired',
  scoring: 'Scoring',
  'result-received': 'Result received',
};

export default function RoomsView({ bridge }: { bridge: BridgeApi }) {
  const { tournament, state } = bridge;
  const round = tournament?.rounds.find((entry) => entry.id === state.selectedRoundId) ?? null;
  const warningsByRoom = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const warning of bridge.warnings) {
      map.set(warning.roomId, [...(map.get(warning.roomId) ?? []), warning.message]);
    }
    return map;
  }, [bridge.warnings]);

  if (!tournament) {
    return (
      <section className="panel">
        <h2>Rooms</h2>
        <p className="muted">Load a YellowFruit file to choose teams.</p>
      </section>
    );
  }

  const teamOptions = [...tournament.teams].sort((left, right) => left.name.localeCompare(right.name));

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

  return (
    <section className="panel" style={{ maxWidth: 1100 }}>
      <h2>Rooms</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <label htmlFor="round">Round</label>
        <select
          id="round"
          value={state.selectedRoundId ?? ''}
          onChange={(event) => bridge.selectRound(event.target.value)}
        >
          {tournament.rounds.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.phaseName ? `${entry.phaseName} · ` : ''}Round {entry.qbjName}
            </option>
          ))}
        </select>
        <button type="button" onClick={bridge.addRoom}>
          + Room
        </button>
        <button
          className="primary"
          type="button"
          style={{ marginLeft: 'auto' }}
          disabled={bridge.busy || !state.relay || !round}
          onClick={() => void bridge.publish()}
        >
          {round ? `Publish Round ${round.qbjName}` : 'Publish'}
        </button>
      </div>

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
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {state.rooms.map((room) => {
              const link = linkFor(room);
              const roomWarnings = warningsByRoom.get(room.id) ?? [];
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
                    {roomWarnings.length > 0 ? (
                      <div className="status warn">{roomWarnings.join(' ')}</div>
                    ) : null}
                  </td>
                  <td>
                    <select
                      aria-label={`Left team in ${room.name}`}
                      value={room.leftTeamId ?? ''}
                      onChange={(event) => bridge.setRoomTeams(room.id, 'left', event.target.value || null)}
                    >
                      <option value="">—</option>
                      {teamOptions.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`Right team in ${room.name}`}
                      value={room.rightTeamId ?? ''}
                      onChange={(event) => bridge.setRoomTeams(room.id, 'right', event.target.value || null)}
                    >
                      <option value="">—</option>
                      {teamOptions.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <div className="row">
                      <span className="code">{room.pairingCode}</span>
                      {link ? <Qr url={link} label={`Pairing QR for ${room.name}`} /> : null}
                      <button
                        type="button"
                        title="Issue a new code for this room. The old one stops working at the next publish."
                        onClick={() => bridge.regeneratePairingCode(room.id)}
                      >
                        New code
                      </button>
                    </div>
                  </td>
                  <td className="status">{statusLabel[bridge.roomStatus(room)]}</td>
                  <td>
                    <button type="button" onClick={() => bridge.removeRoom(room.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ marginTop: 10 }}>
        QBBridge reports only what it can see from the relay: a room is <em>Waiting</em> from the moment its
        assignment is published until its result arrives.
      </p>
    </section>
  );
}
