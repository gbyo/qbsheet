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

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, ConfirmDialog, StatusBadge, TeamComboBox, type Tone } from '@qbsheet/ui';
import wordmark from '../assets/qbsheet-wordmark.svg';
import { pairingLink, type PairingLink } from '../model/pairing';
import { buildRoomPrintData, type RoomPrintData } from '../model/print';
import type { Room, RoomStatus } from '../model/rooms';
import {
  destinationPoolName,
  formatRanks,
  phaseForRound,
  phaseTeamPoolContext,
  roundGroups,
  schedulePairingWarnings,
} from '../model/schedule';
import type { BridgeApi } from '../model/useBridge';
import Qr from './Qr';

const status: Record<RoomStatus, { label: string; tone: Tone }> = {
  'not-published': { label: 'Not published', tone: 'neutral' },
  'ready-to-pair': { label: 'Ready to pair', tone: 'info' },
  waiting: { label: 'Waiting', tone: 'info' },
  'result-received': { label: 'Result received', tone: 'success' },
};

type PrintTarget = 'all' | string;

function RoomPrintSheet({ data }: { data: RoomPrintData }) {
  return (
    <article className="room-print-sheet" data-room-id={data.roomId}>
      <header className="room-print-sheet__brand">
        <img className="room-print-sheet__wordmark" src={wordmark} alt="QBSheet Bridge" />
        <p className="room-print-sheet__tournament">{data.tournamentName}</p>
      </header>

      <h1 className="room-print-sheet__room">{data.roomName}</h1>
      <p className="room-print-sheet__kicker">Pair this room</p>

      <div className="room-print-sheet__pairing">
        <Qr url={data.pairingUrl} roomName={data.roomName} />
        <div className="room-print-sheet__code-block">
          <p className="room-print-sheet__label">Pairing code</p>
          <p className="room-print-sheet__code">{data.pairingCode}</p>
          <p className="room-print-sheet__scan-help">Scan the QR with QBSheet Scorer.</p>
        </div>
      </div>

      <section className="room-print-sheet__manual" aria-labelledby={`manual-${data.roomId}`}>
        <h2 id={`manual-${data.roomId}`}>Pair manually</h2>
        <ol>
          <li>
            Open <strong>qbsheet.com</strong>.
          </li>
          <li>
            Choose <strong>Connect to tournament control</strong>.
          </li>
          <li>
            <strong>Tournament control address:</strong> <code>{data.tournamentControlUrl}</code>
          </li>
          <li>
            <strong>Pairing code:</strong> <code>{data.pairingCode}</code>
          </li>
          <li>
            <strong>Room:</strong> {data.roomName}
          </li>
        </ol>
      </section>

      <p className="room-print-sheet__url">
        <span>Pairing link: </span>
        <a href={data.pairingUrl}>{data.pairingUrl}</a>
      </p>
    </article>
  );
}

function poolSizeLabel(pool: { teamIds: readonly string[]; expectedSize?: number }): string {
  if (pool.teamIds.length > 0) return `${pool.teamIds.length} teams`;
  if (pool.expectedSize !== undefined) return `${pool.expectedSize} teams · not populated in file`;
  return 'team membership not in file';
}

type PoolFilter = {
  tournament: NonNullable<BridgeApi['tournament']>;
  phaseId: string;
  poolId: string;
};

export default function RoomsView({ bridge }: { bridge: BridgeApi }) {
  const { tournament, state } = bridge;
  const [pendingRound, setPendingRound] = useState<string | null>(null);
  const [poolFilter, setPoolFilter] = useState<PoolFilter | null>(null);
  const [printTarget, setPrintTarget] = useState<PrintTarget | null>(null);
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
  useEffect(() => {
    if (printTarget === null || typeof window === 'undefined') return undefined;

    const finishPrint = () => setPrintTarget(null);
    window.addEventListener('afterprint', finishPrint);
    if (typeof window.print === 'function') window.print();
    return () => window.removeEventListener('afterprint', finishPrint);
  }, [printTarget]);

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
      .map((team) => {
        const context = round ? phaseTeamPoolContext(tournament, round, team.id) : null;
        const destinationNames = context?.destinationPoolNames ?? team.poolNames;
        let detail = destinationNames.join(' · ');
        if (context?.carryover) {
          detail +=
            context.sourcePoolNames.length === 1
              ? ` · from ${context.sourcePhaseName ?? 'previous phase'} · ${context.sourcePoolNames[0]}`
              : context.sourcePoolNames.length > 1
                ? ` · source pool ambiguous: ${context.sourcePoolNames.join(' / ')}`
                : ' · source pool not proven';
        }
        return {
          id: team.id,
          name: team.name,
          // The selected phase is the useful context. Do not borrow a prelim pool unless the
          // destination itself says carryover and the immediately preceding phase supplies it.
          detail: detail || (phase ? 'No pool listed for this phase' : undefined),
        };
      });
  }, [activePoolFilter, phase, phasePools, round, state.rooms, tournament]);

  const teamDetailById = useMemo(
    () => new Map(teamOptions.map((team) => [team.id, team.detail])),
    [teamOptions],
  );

  if (!tournament) {
    return (
      <section className="panel">
        <h2>Rooms</h2>
        <p className="muted">Load a YellowFruit file to choose teams.</p>
      </section>
    );
  }

  const pairingFor = (room: Room): PairingLink | null => {
    if (!state.relay) return null;
    try {
      const pairing = pairingLink({
        baseUrl: state.relay.baseUrl,
        tournamentId: state.relay.tournamentId,
        code: room.pairingCode,
        roomId: room.id,
      });
      return pairing;
    } catch {
      return null;
    }
  };

  const linkFor = (room: Room): string | null => pairingFor(room)?.url ?? null;

  const scorerReady = bridge.scorerReadiness?.status === 'ready';
  /** A sheet is only offered after this room's current pairing identity has reached the relay. */
  const printDataFor = (room: Room): RoomPrintData | null => {
    if (!scorerReady || !room.relayPublished || room.pendingPairingCode !== null) return null;
    const pairing = pairingFor(room);
    return pairing
      ? buildRoomPrintData({
          tournamentName: tournament.name,
          room,
          pairing,
        })
      : null;
  };

  const printableRooms = state.rooms
    .map(printDataFor)
    .filter((entry): entry is RoomPrintData => entry !== null);
  const printableById = new Map(printableRooms.map((entry) => [entry.roomId, entry]));
  const canPrintAll = state.rooms.length > 0 && printableRooms.length === state.rooms.length;

  const startPrint = (target: PrintTarget): void => {
    if (target === 'all' ? !canPrintAll : !printableById.has(target)) return;
    setPrintTarget(target);
  };

  const sheetsToPrint =
    printTarget === 'all'
      ? printableRooms
      : printTarget === null
        ? []
        : printableRooms.filter((entry) => entry.roomId === printTarget);

  const requestRound = (roundId: string): void => {
    if (roundId === state.selectedRoundId) return;
    // Changing rounds clears every selection, so ask first when there is something to lose.
    if (bridge.roundChangeDiscardsSelections) setPendingRound(roundId);
    else bridge.selectRound(roundId);
  };

  const pendingRoundName = tournament.rounds.find((entry) => entry.id === pendingRound)?.displayName ?? '';

  return (
    <>
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
                    Round {entry.displayName}
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
            isDisabled={bridge.busy || printTarget !== null || !canPrintAll}
            onPress={() => startPrint('all')}
          >
            Print all room sheets
          </Button>
          <Button
            variant="primary"
            style={{ marginLeft: 'auto' }}
            isDisabled={bridge.busy || !state.relay || !round}
            onPress={() => void bridge.publish()}
          >
            {round ? `Publish Round ${round.displayName}` : 'Publish'}
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
                {(phase?.name ?? round.phaseName) || 'Round'} · Round {round.displayName}
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
              QBBridge does not calculate standings or advancement. Pairings remain the operator&rsquo;s
              manual choice; these labels only describe what YellowFruit stored.
            </p>
          </div>
        ) : null}

        {state.rooms.length > 0 && !canPrintAll ? (
          <p className="faint room-print-hint">
            {scorerReady
              ? 'Publish the room setup to the relay before printing pairing sheets. A pending new code must be published first.'
              : 'Confirm Scorer origin readiness before printing pairing sheets.'}
          </p>
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
                      {room.leftTeamId && teamDetailById.get(room.leftTeamId) ? (
                        <div className="faint">{teamDetailById.get(room.leftTeamId)}</div>
                      ) : null}
                    </td>
                    <td className="team-cell">
                      <TeamComboBox
                        label={`Right team in ${room.name}`}
                        options={teamOptions}
                        selectedId={room.rightTeamId}
                        onSelect={(id) => bridge.setRoomTeams(room.id, 'right', id)}
                      />
                      {room.rightTeamId && teamDetailById.get(room.rightTeamId) ? (
                        <div className="faint">{teamDetailById.get(room.rightTeamId)}</div>
                      ) : null}
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
                        isDisabled={bridge.busy || printTarget !== null || !printableById.has(room.id)}
                        onPress={() => startPrint(room.id)}
                      >
                        Print sheet
                      </Button>
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
          QBBridge reports only what it can see from the relay: a room is Not published until its setup
          reaches the current relay, Ready to pair after that setup is mirrored, Waiting while an assignment
          is active, and Result received when its published game returns. Publishing a round also clears the
          assignment of every room with no matchup, so an unused room cannot open last round&rsquo;s game.
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
          fresh. Rooms, their names and their pairing codes are kept, and nothing is sent to the relay until
          you publish.
        </ConfirmDialog>

        <ConfirmDialog
          isOpen={bridge.pendingPublicationReview !== null}
          title={
            bridge.pendingPublicationReview
              ? `Review Round ${bridge.pendingPublicationReview.roundName} before publishing`
              : 'Review before publishing'
          }
          confirmLabel="Publish anyway"
          cancelLabel="Go back"
          confirmVariant="danger"
          onCancel={bridge.cancelPublicationReview}
          onConfirm={() => void bridge.confirmPublicationReview()}
        >
          {bridge.pendingPublicationReview ? (
            <>
              <p>QBBridge will send this exact pairing plan if you choose the exceptional override.</p>
              <ul>
                {bridge.pendingPublicationReview.items.map((item) => (
                  <li key={`${item.roomId}:${item.message}`}>
                    <strong>{item.roomName}</strong> — {item.message}
                  </li>
                ))}
              </ul>
              <p>
                Go back to correct the table, or publish anyway only when every listed exception is
                intentional. Cleared rooms will lose their active assignment on the relay.
              </p>
            </>
          ) : null}
        </ConfirmDialog>
      </section>
      {printTarget !== null && typeof document !== 'undefined'
        ? createPortal(
            <div className="room-print-sheets" data-print-target={printTarget}>
              {sheetsToPrint.map((data) => (
                <RoomPrintSheet key={data.roomId} data={data} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
