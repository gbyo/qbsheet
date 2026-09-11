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
import {
  destinationPoolName,
  formatRanks,
  phaseForRound,
  phasePoolNames,
  planSuggestionPlacements,
  roundGroups,
  schedulePairingWarnings,
  type SuggestionPlacement,
} from '../model/schedule';
import type { BridgeApi } from '../model/useBridge';
import Qr from './Qr';

const status: Record<RoomStatus, { label: string; tone: Tone }> = {
  ready: { label: 'Ready', tone: 'neutral' },
  waiting: { label: 'Waiting', tone: 'info' },
  paired: { label: 'Paired', tone: 'info' },
  scoring: { label: 'Scoring', tone: 'info' },
  'result-received': { label: 'Result received', tone: 'success' },
};

function poolSizeLabel(pool: { teamIds: readonly string[]; expectedSize?: number }): string {
  if (pool.teamIds.length > 0) return `${pool.teamIds.length} teams`;
  if (pool.expectedSize !== undefined) return `${pool.expectedSize} teams · not populated in file`;
  return 'team membership not in file';
}

function teamName(tournament: NonNullable<BridgeApi['tournament']>, id: string): string {
  return tournament.teams.find((team) => team.id === id)?.name ?? id;
}

function sourceLocationLabel(placement: SuggestionPlacement, roomName: string | undefined): string {
  const source = placement.suggestion.location
    ? `Source location: ${placement.suggestion.location}`
    : 'No room location in file';
  switch (placement.status) {
    case 'applied':
      return `Already in ${roomName ?? 'a room'} · ${source}`;
    case 'available':
      return `Will fill ${roomName ?? 'an available room'} · ${source}`;
    case 'overwrite':
      return `Will replace the pairing in ${roomName ?? 'a room'} · ${source}`;
    case 'staged':
      return `Choose a room manually · ${source}`;
  }
}

type PoolFilter = {
  tournament: NonNullable<BridgeApi['tournament']>;
  phaseId: string;
  poolId: string;
};

type PendingPrefill = {
  tournament: NonNullable<BridgeApi['tournament']>;
  plan: SuggestionPlacement[];
};

export default function RoomsView({ bridge }: { bridge: BridgeApi }) {
  const { tournament, state } = bridge;
  const [pendingRound, setPendingRound] = useState<string | null>(null);
  const [poolFilter, setPoolFilter] = useState<PoolFilter | null>(null);
  const [pendingPrefill, setPendingPrefill] = useState<PendingPrefill | null>(null);
  const round = tournament?.rounds.find((entry) => entry.id === state.selectedRoundId) ?? null;
  const phase = tournament ? phaseForRound(tournament, round) : undefined;
  const roundGroupsForDisplay = useMemo(() => (tournament ? roundGroups(tournament) : []), [tournament]);
  const phasePools = useMemo(() => phase?.pools ?? [], [phase]);
  const activePoolFilter =
    poolFilter?.tournament === tournament &&
    poolFilter.phaseId === round?.phaseId &&
    phasePools.some((pool) => pool.id === poolFilter.poolId)
      ? poolFilter.poolId
      : '';
  const suggestions = useMemo(
    () =>
      tournament && round
        ? tournament.suggestedGames.filter(
            (suggestion) => suggestion.roundId === round.id && suggestion.phaseId === round.phaseId,
          )
        : [],
    [round, tournament],
  );
  const suggestionPlacements = useMemo(
    () => planSuggestionPlacements(suggestions, state.rooms),
    [state.rooms, suggestions],
  );
  const actionableSuggestions = suggestionPlacements.filter(
    (placement) => placement.roomId !== null && placement.status !== 'applied',
  );
  const hasOverwrite = actionableSuggestions.some((placement) => placement.status === 'overwrite');

  // A reload changes the source evidence. A pending confirmation is only valid for the exact
  // tournament object from which its plan was derived; the derived value closes it otherwise.
  const activePendingPrefill = pendingPrefill?.tournament === tournament ? pendingPrefill.plan : null;

  const warningsByRoom = useMemo(() => {
    const map = new Map<string, string[]>();
    const warnings = round
      ? [...bridge.warnings, ...schedulePairingWarnings(tournament!, round, state.rooms)]
      : bridge.warnings;
    for (const warning of warnings) {
      map.set(warning.roomId, [...(map.get(warning.roomId) ?? []), warning.message]);
    }
    return map;
  }, [bridge.warnings, round, state.rooms, tournament]);

  const teamOptions = useMemo(() => {
    if (!tournament) return [];
    const selectedIds = new Set(
      state.rooms
        .flatMap((room) => [room.leftTeamId, room.rightTeamId])
        .filter((id): id is string => id !== null),
    );
    return [...tournament.teams]
      .filter(
        (team) =>
          activePoolFilter === '' ||
          phasePools.find((pool) => pool.id === activePoolFilter)?.teamIds.includes(team.id) === true ||
          selectedIds.has(team.id),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((team) => ({
        id: team.id,
        name: team.name,
        // The selected phase is the useful context. Do not show a playoff team as if it still
        // belonged to its prelim pool when the playoff pool is empty in the reloaded file.
        detail:
          (phase ? phasePoolNames(phase, team.id) : team.poolNames).join(' · ') ||
          (phase ? 'No pool listed for this phase' : undefined),
      }));
  }, [activePoolFilter, phase, phasePools, state.rooms, tournament]);

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

  const scorerReady = bridge.scorerReadiness?.status === 'ready';

  const requestRound = (roundId: string): void => {
    if (roundId === state.selectedRoundId) return;
    // Changing rounds clears every selection, so ask first when there is something to lose.
    if (bridge.roundChangeDiscardsSelections) setPendingRound(roundId);
    else bridge.selectRound(roundId);
  };

  const applySuggestionPlan = (plan: readonly SuggestionPlacement[]): void => {
    for (const placement of plan) {
      if (placement.roomId === null || placement.status === 'applied' || placement.status === 'staged')
        continue;
      bridge.setRoomTeams(placement.roomId, 'left', placement.suggestion.teamIds[0]);
      bridge.setRoomTeams(placement.roomId, 'right', placement.suggestion.teamIds[1]);
    }
    setPendingPrefill(null);
  };

  const applySuggestions = (): void => {
    if (actionableSuggestions.length === 0) return;
    if (hasOverwrite) setPendingPrefill({ tournament, plan: suggestionPlacements });
    else applySuggestionPlan(suggestionPlacements);
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
          {roundGroupsForDisplay.map((group) => (
            <optgroup key={`${group.phaseId ?? 'other'}:${group.label}`} label={group.label}>
              {group.rounds.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  Round {entry.qbjName}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {phasePools.length > 0 ? (
          <label htmlFor="team-pool-filter">
            Team pool
            <select
              id="team-pool-filter"
              value={activePoolFilter}
              onChange={(event) =>
                setPoolFilter({
                  tournament,
                  phaseId: round?.phaseId ?? '',
                  poolId: event.target.value,
                })
              }
            >
              <option value="">All pools</option>
              {phasePools.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
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
      {round ? (
        <div className="rooms-schedule-context" aria-label="YellowFruit schedule context">
          <div className="rooms-schedule-context__heading">
            <h3>
              {(phase?.name ?? round.phaseName) || 'Round'} · Round {round.qbjName}
            </h3>
            <span className="faint">Read-only context from the loaded .yft</span>
          </div>
          {phase?.pools.length ? (
            <ul className="pool-context">
              {phase.pools.map((pool) => {
                const names = tournament.teams
                  .filter((team) => pool.teamIds.includes(team.id))
                  .map((team) => team.name);
                return (
                  <li key={pool.id}>
                    <div className="pool-context__summary">
                      <strong>{pool.name}</strong>
                      <span>
                        {' · '}
                        {pool.tier !== undefined ? `tier ${pool.tier} · ` : ''}
                        {poolSizeLabel(pool)}
                        {pool.hasCarryover ? ' · carryover' : ''}
                        {pool.roundRobins !== undefined ? ` · ${pool.roundRobins}x round robin` : ''}
                      </span>
                    </div>
                    {names.length > 0 ? (
                      <div className="faint">Teams in this file: {names.join(', ')}</div>
                    ) : (
                      <div className="faint">
                        No team membership is present; this is a schedule slot only.
                      </div>
                    )}
                    {pool.autoAdvanceRules.length > 0 ? (
                      <ul className="pool-context__rules">
                        {pool.autoAdvanceRules.map((rule) => (
                          <li key={`${rule.tier}:${rule.ranksThatAdvance.join(',')}`}>
                            YellowFruit rule: {formatRanks(rule.ranksThatAdvance)} →{' '}
                            {destinationPoolName(tournament, phase, rule.tier)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="faint">YellowFruit did not provide pool metadata for this phase.</p>
          )}
          <p className="faint">
            QBBridge does not calculate standings or advancement. Pairings remain the operator&rsquo;s manual
            choice; these labels only describe what YellowFruit stored.
          </p>
        </div>
      ) : null}

      {suggestions.length > 0 ? (
        <div className="rooms-suggestions" aria-labelledby="yellowfruit-suggestions-heading">
          <div className="rooms-suggestions__heading">
            <div>
              <h3 id="yellowfruit-suggestions-heading">YellowFruit games found</h3>
              <p className="faint">
                These are concrete, unplayed two-team Match objects from the file. QBBridge will not generate
                schedule games from a round-robin template.
              </p>
            </div>
            <Button
              variant="quiet"
              isDisabled={bridge.busy || actionableSuggestions.length === 0}
              onPress={applySuggestions}
            >
              Fill pairings from file
            </Button>
          </div>
          <ul className="suggestion-list" aria-label="Concrete unplayed YellowFruit games">
            {suggestionPlacements.map((placement) => {
              const room = placement.roomId
                ? state.rooms.find((entry) => entry.id === placement.roomId)
                : undefined;
              return (
                <li key={placement.suggestion.id}>
                  <strong>
                    {teamName(tournament, placement.suggestion.teamIds[0])} vs{' '}
                    {teamName(tournament, placement.suggestion.teamIds[1])}
                  </strong>
                  <span className="faint">
                    {' · '}
                    {sourceLocationLabel(placement, room?.name)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

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
                      {room.relayPublished && link && scorerReady ? (
                        <Qr url={link} roomName={room.name} />
                      ) : null}
                      {room.relayPublished && link && !scorerReady ? (
                        <span className="faint">QR withheld until Scorer readiness is confirmed.</span>
                      ) : null}
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

      <ConfirmDialog
        isOpen={activePendingPrefill !== null}
        title="Replace entered pairings from file?"
        confirmLabel="Fill from file"
        onCancel={() => setPendingPrefill(null)}
        onConfirm={() => {
          if (activePendingPrefill) applySuggestionPlan(activePendingPrefill);
        }}
      >
        At least one concrete YellowFruit game would replace team selections you already entered. Room names
        and pairing codes will stay unchanged. Only the listed unplayed games will be filled; other games
        remain manual.
      </ConfirmDialog>
    </section>
  );
}
