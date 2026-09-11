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
import { pairingsForRound, type PlanPublicationStatus } from '../model/roundPlans';
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

/**
 * How the selected round's plan for this room compares with the relay.
 *
 * Separate from `status` above, which is about the room: while round 1 is live every room reads
 * `Waiting`, and that says nothing about whether round 5's plan has been published. `Live` here is
 * the only label that claims the relay is serving the matchup on screen.
 */
const planStatus: Record<PlanPublicationStatus, { label: string; tone: Tone } | null> = {
  'no-game': null,
  planned: { label: 'Planned', tone: 'neutral' },
  live: { label: 'Live', tone: 'success' },
  edited: { label: 'Edited since publish', tone: 'warning' },
  'other-round': { label: 'Relay holds another round', tone: 'info' },
};

type PrintTarget = 'all' | string;

/** "1 game planned", "0 games planned" — a count, never a fraction of the room capacity. */
function gamesPlannedLabel(count: number): string {
  return count === 1 ? '1 game planned' : `${count} games planned`;
}

/** "R1 5 games" — the per-round chips beside the selector. */
function gamesLabel(count: number): string {
  return count === 1 ? '1 game' : `${count} games`;
}

/**
 * The batch print action names its actual scope, never implying a complete tournament setup.
 *
 * A partial batch counts its ready sheets; the all-ready and nothing-ready states keep the
 * familiar label, with the hint below saying what is still missing.
 */
function batchPrintLabel(totalRooms: number, readyRooms: number): string {
  if (readyRooms === 1 && totalRooms > 1) return 'Print 1 ready room sheet';
  if (readyRooms > 0 && readyRooms < totalRooms) return `Print ${readyRooms} ready room sheets`;
  return 'Print all room sheets';
}

function RoomPrintSheet({ data }: { data: RoomPrintData }) {
  return (
    <article className="room-print-sheet" data-room-id={data.roomId}>
      <header className="room-print-sheet__brand">
        <img className="room-print-sheet__wordmark" src={wordmark} alt="QBSheet" />
        <p className="room-print-sheet__tournament">{data.tournamentName}</p>
      </header>

      <div className="room-print-sheet__heading">
        <p className="room-print-sheet__eyebrow">Scorekeeper setup</p>
        <h1 className="room-print-sheet__room">{data.roomName}</h1>
      </div>

      <div className="room-print-sheet__setup">
        <section className="room-print-sheet__qr-card" aria-label={`QR code for ${data.roomName}`}>
          <Qr url={data.pairingUrl} roomName={data.roomName} />
          <strong>Scan to connect automatically</strong>
          <span>Open QBSheet&rsquo;s QR scanner and point it at this code.</span>
        </section>

        <section className="room-print-sheet__instructions" aria-labelledby={`setup-${data.roomId}`}>
          <h2 id={`setup-${data.roomId}`}>Set up QBSheet</h2>
          <ol className="room-print-sheet__steps">
            <li>
              <strong>Go to qbsheet.com.</strong>
              <span>Open QBSheet on the device you will use to score this room.</span>
            </li>
            <li>
              <strong>Enter your name.</strong>
              <span>If QBSheet asks who is scoring, enter your name and continue.</span>
            </li>
            <li>
              <strong>Connect to tournament control.</strong>
              <span>
                In <em>Tournament control address</em>, enter:
              </span>
              <code className="room-print-sheet__address">{data.tournamentControlUrl}</code>
            </li>
            <li>
              <strong>Enter this access code.</strong>
              <span>
                QBSheet labels this field <em>Pairing code</em>. Then choose <em>Pair this room</em>.
              </span>
              <code className="room-print-sheet__access-code">{data.pairingCode}</code>
            </li>
          </ol>
        </section>
      </div>

      <section className="room-print-sheet__troubleshooting" aria-labelledby={`trouble-${data.roomId}`}>
        <h2 id={`trouble-${data.roomId}`}>Trouble connecting?</h2>
        <ul>
          <li>
            <strong>QR won&rsquo;t scan?</strong> Use the four manual steps above. The printed address and
            code do the same thing as the QR.
          </li>
          <li>
            <strong>Can&rsquo;t reach tournament control?</strong> Check that the device has an internet
            connection, reload qbsheet.com, and try the address again.
          </li>
          <li>
            <strong>Code rejected or wrong room?</strong> Stop and ask tournament staff for this room&rsquo;s
            current code. Do not use another room&rsquo;s sheet.
          </li>
          <li>
            <strong>Connection drops during a game?</strong> Keep scoring in the same QBSheet game. Do not
            start a second scoresheet; tell tournament staff when the game is over.
          </li>
        </ul>
      </section>

      <p className="room-print-sheet__url">
        <span>Direct pairing link (fallback): </span>
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

interface PendingRoomAction {
  kind: 'remove' | 'regen-code';
  roomId: string;
  roomName: string;
  message: string;
}

export default function RoomsView({ bridge }: { bridge: BridgeApi }) {
  const { tournament, state } = bridge;
  const [poolFilter, setPoolFilter] = useState<PoolFilter | null>(null);
  const [printTarget, setPrintTarget] = useState<PrintTarget | null>(null);
  const [pendingRoomAction, setPendingRoomAction] = useState<PendingRoomAction | null>(null);

  function requestRoomAction(kind: PendingRoomAction['kind'], roomId: string, roomName: string) {
    const action = kind === 'remove' ? 'removing it' : 'replacing its pairing code';
    const message = bridge.occupiedRoomMessage(roomId, action);
    if (message === null) {
      if (kind === 'remove') bridge.removeRoom(roomId);
      else bridge.regeneratePairingCode(roomId);
      return;
    }
    setPendingRoomAction({ kind, roomId, roomName, message });
  }

  function confirmRoomAction() {
    if (!pendingRoomAction) return;
    if (pendingRoomAction.kind === 'remove') bridge.forceRemoveRoom(pendingRoomAction.roomId);
    else bridge.forceRegeneratePairingCode(pendingRoomAction.roomId);
    setPendingRoomAction(null);
  }
  const round = tournament?.rounds.find((entry) => entry.id === state.selectedRoundId) ?? null;
  const selectedPairings = useMemo(
    () => pairingsForRound(state.roundPlans, state.selectedRoundId),
    [state.roundPlans, state.selectedRoundId],
  );
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
      ? [...bridge.warnings, ...schedulePairingWarnings(tournament!, round, state.rooms, selectedPairings)]
      : bridge.warnings;
    for (const warning of warnings) {
      map.set(warning.roomId, [...(map.get(warning.roomId) ?? []), warning.message]);
    }
    return map;
  }, [bridge.warnings, round, selectedPairings, state.rooms, tournament]);

  const teamOptions = useMemo(() => {
    if (!tournament) return [];
    const selectedIds = new Set(
      selectedPairings
        .flatMap((pairing) => [pairing.leftTeamId, pairing.rightTeamId])
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
  }, [activePoolFilter, phase, phasePools, round, selectedPairings, tournament]);

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
  /**
   * Why one room has no pairing sheet, or null when it does.
   *
   * The single source of truth for the print guards. Printing a stale or unpublished code would
   * lock a scorekeeper out of the room, so an unready room is excluded rather than approximated —
   * and the batch action below prints the ready subset instead of refusing everything.
   */
  const printExclusionReason = (room: Room): string | null => {
    if (!scorerReady) return 'Scorer readiness is not confirmed';
    if (!room.relayPublished) return 'its room setup is not published yet';
    if (room.pendingPairingCode !== null) return 'a replacement code is waiting to be published';
    if (linkFor(room) === null) return 'its pairing link is unavailable';
    return null;
  };

  /** A sheet is only offered after this room's current pairing identity has reached the relay. */
  const printDataFor = (room: Room): RoomPrintData | null => {
    if (printExclusionReason(room) !== null) return null;
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
  const excludedRooms = state.rooms.filter((room) => !printableById.has(room.id));
  const allReady = state.rooms.length > 0 && excludedRooms.length === 0;
  const canPrintReady = printableRooms.length > 0;

  const startPrint = (target: PrintTarget): void => {
    if (target === 'all' ? !canPrintReady : !printableById.has(target)) return;
    setPrintTarget(target);
  };

  const printHintText = (): string => {
    if (canPrintReady) {
      const excluded = excludedRooms.map((room) => `${room.name} (${printExclusionReason(room)})`).join(', ');
      return `Printing ${printableRooms.length} of ${state.rooms.length} room sheets. Not included: ${excluded}.`;
    }
    return scorerReady
      ? 'Publish the room setup to the relay before printing pairing sheets. A pending new code must be published first.'
      : 'Confirm Scorer origin readiness before printing pairing sheets.';
  };

  const sheetsToPrint =
    printTarget === 'all'
      ? printableRooms
      : printTarget === null
        ? []
        : printableRooms.filter((entry) => entry.roomId === printTarget);

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
            onChange={(event) => bridge.selectRound(event.target.value)}
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
          {/*
            Setup progress, in the place the round is chosen. A descriptive count of planned
            games, deliberately not a fraction: byes, playoff phases using fewer rooms, and
            intentionally idle rooms all make the configured room count a wrong denominator,
            and a false incomplete state pressures the operator to invent a missing game.
          */}
          <span className="round-progress" data-testid="round-progress">
            Round {round?.displayName ?? '—'} · {gamesPlannedLabel(bridge.roundProgress.assigned)}
          </span>
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
            isDisabled={bridge.busy || printTarget !== null || !canPrintReady}
            onPress={() => startPrint('all')}
          >
            {batchPrintLabel(state.rooms.length, printableRooms.length)}
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

        {state.rooms.length > 0 && !allReady ? (
          <p className="faint room-print-hint" data-testid="print-hint">
            {printHintText()}
          </p>
        ) : null}

        {bridge.phaseRoundProgress.length > 1 ? (
          <p className="faint" data-testid="phase-progress">
            {bridge.phaseRoundProgress.map((entry) => (
              <span key={entry.roundId} className="round-progress-chip">
                R{entry.displayName} {gamesLabel(entry.assigned)}
              </span>
            ))}
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
                const plan = planStatus[bridge.planStatus(room)];
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
                        selectedId={bridge.plannedTeamsFor(room.id).leftTeamId}
                        onSelect={(id) => bridge.setRoomTeams(room.id, 'left', id)}
                      />
                    </td>
                    <td className="team-cell">
                      <TeamComboBox
                        label={`Right team in ${room.name}`}
                        options={teamOptions}
                        selectedId={bridge.plannedTeamsFor(room.id).rightTeamId}
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
                          onPress={() => requestRoomAction('regen-code', room.id, room.name)}
                        >
                          New code
                        </Button>
                      </div>
                    </td>
                    <td>
                      <StatusBadge tone={state_.tone}>{state_.label}</StatusBadge>
                      {plan ? (
                        <div className="faint" data-testid={`plan-status-${room.id}`}>
                          <StatusBadge tone={plan.tone}>{plan.label}</StatusBadge>
                        </div>
                      ) : null}
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
                        onPress={() => requestRoomAction('remove', room.id, room.name)}
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
          assignment of every room with no matchup, so an unused room cannot open last round&rsquo;s game. A
          room that is still scoring refuses ordinary replacement: receive its result first, or take the
          explicit exceptional override from the review.
        </p>
        <p className="faint">
          Matchups are saved per round on this computer. Switching rounds keeps every round&rsquo;s entries,
          so a whole set of prelims can be entered before the tournament, and only the round you publish
          reaches the relay. The second badge compares this round&rsquo;s entry with the relay: Planned has
          not been sent, Live is exactly what the relay is serving, Edited since publish means the entry
          changed after it was published, and Relay holds another round means this room is currently serving a
          different round&rsquo;s game.
        </p>
      </section>
      <ConfirmDialog
        isOpen={bridge.pendingPublicationReview !== null}
        title={
          bridge.pendingPublicationReview
            ? bridge.pendingPublicationReview.blockers.length > 0
              ? `Occupied rooms block ${bridge.pendingPublicationReview.roundName}`
              : bridge.pendingPublicationReview.roundId === 'room-setup'
                ? 'Review room setup before publishing'
                : `Review Round ${bridge.pendingPublicationReview.roundName} before publishing`
            : 'Review round before publishing'
        }
        confirmLabel={
          bridge.pendingPublicationReview && bridge.pendingPublicationReview.blockers.length > 0
            ? 'Replace unresolved games'
            : 'Publish anyway'
        }
        cancelLabel="Go back"
        confirmVariant="danger"
        onConfirm={() =>
          void (bridge.pendingPublicationReview && bridge.pendingPublicationReview.blockers.length > 0
            ? bridge.confirmPublicationOverride()
            : bridge.confirmPublicationReview())
        }
        onCancel={bridge.cancelPublicationReview}
      >
        {bridge.pendingPublicationReview && bridge.pendingPublicationReview.blockers.length > 0 ? (
          <p>
            These rooms are still scoring the game on the relay. Publishing now replaces or clears a live game
            and may strand an active scoresheet. Receive their results first, or replace them only as an
            explicit recovery action — going back leaves everything unchanged.
          </p>
        ) : (
          <p>
            QBBridge is holding the exact round plan below. Nothing has been sent to the relay yet. Publish
            anyway only after checking each consequence; going back leaves the selected teams and relay state
            unchanged.
          </p>
        )}
        {bridge.pendingPublicationReview && bridge.pendingPublicationReview.blockers.length > 0 ? (
          <ul>
            {bridge.pendingPublicationReview.blockers.map((item, index) => (
              <li key={`blocker:${item.roomId}:${item.message}:${index}`}>
                <strong>{item.roomName}:</strong> {item.message}
              </li>
            ))}
          </ul>
        ) : null}
        <ul>
          {bridge.pendingPublicationReview?.items.map((item, index) => (
            <li key={`${item.roomId}:${item.message}:${index}`}>
              <strong>{item.roomName}:</strong> {item.message}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={pendingRoomAction !== null}
        title={
          pendingRoomAction
            ? pendingRoomAction.kind === 'remove'
              ? `Remove ${pendingRoomAction.roomName} while it is scoring?`
              : `Replace the pairing code for ${pendingRoomAction.roomName} while it is scoring?`
            : 'Room is still scoring'
        }
        confirmLabel={pendingRoomAction?.kind === 'remove' ? 'Remove anyway' : 'Replace code anyway'}
        cancelLabel="Go back"
        confirmVariant="danger"
        onConfirm={confirmRoomAction}
        onCancel={() => setPendingRoomAction(null)}
      >
        <p>{pendingRoomAction?.message}</p>
        <p>
          This is the exceptional path: prefer receiving the room&rsquo;s result first. Continuing may strand
          the scorer currently serving that game.
        </p>
      </ConfirmDialog>
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
