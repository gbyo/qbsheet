import { useMemo, useState } from 'react';
import {
  availableTimeZones,
  isoToZonedDateTimeInput,
  latestRound,
  orderDayItems,
  releasedGameRoomMoveBlocker,
  roundCloseBlockers,
  roundScheduleIsValid,
  roomIsAssignable,
  timeZoneLabel,
  timelineEventTypeLabel,
  timelineEventTypes,
  zonedDateTimeInputToIso,
  type DirectorState,
  type OrderedDayItem,
  type TimelineEventType,
  type TimelineVisibility,
  type TournamentTimelineEvent,
} from '../domain';
import type { DirectorController, NewTimelineEventInput } from '../state/useDirectorController';
import {
  ActionMenu,
  Button,
  Callout,
  DateField,
  Diagnostics,
  Dialog,
  DialogSection,
  Field,
  FieldGrid,
  MenuItem,
  MultiSelect,
  Page,
  PageHeader,
  Progress,
  ReorderHandle,
  ReorderNotice,
  ReorderToggle,
  Select,
  StateLabel,
  SummaryItem,
  SummaryList,
  TextArea,
  TextInput,
  TimeField,
  useConfirm,
  useDragReorder,
  useReorderMode,
  type SelectOption,
} from '../components';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { prepareOperation, type TransfersRuntime } from '../transfers/useTransfers';
import { removeRoundFlexibly, roundRemovalBlocker } from '../state/flexibleEditing';
import { currentOperationalRound } from '../transfers/assignment';
import { errorNotice, type AnnounceInput } from '../notices';

/** One-click day events. Anything else uses the full event form. */
const quickEvents = [
  { type: 'lunch', icon: 'clock' },
  { type: 'break', icon: 'pause' },
  { type: 'check-in', icon: 'clipboard' },
  { type: 'awards', icon: 'tournament' },
] as const;

type Navigate = (section: SectionId, target?: DirectorNavigationTarget | null) => void;

export function RoundsView({
  transfers,
  state,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  transfers?: TransfersRuntime;
  state: DirectorState;
  controller: DirectorController;
  onNavigate?: Navigate;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const tournament = state.tournament;
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const reorder = useReorderMode();
  const confirmAction = useConfirm();

  const orderedItems: OrderedDayItem[] = useMemo(
    () => orderDayItems(state.rounds, state.timeline),
    [state.rounds, state.timeline],
  );
  const activeRound = currentOperationalRound(state) ?? latestRound(state.rounds);
  const activeGames = activeRound
    ? state.scheduledGames.filter((game) => game.roundId === activeRound.id && !game.bye)
    : [];
  const activeAccepted = activeGames.filter((game) => game.status === 'accepted').length;
  const roundCount = state.rounds.length;
  const go: Navigate = onNavigate ?? (() => {});
  const hasTimes = useMemo(
    () =>
      state.rounds.some((round) => round.scheduledStart) ||
      state.timeline.some((event) => event.scheduledStart || event.scheduledEnd),
    [state.rounds, state.timeline],
  );

  const moveItem = (item: OrderedDayItem, delta: number) => {
    const direction = delta < 0 ? 'up' : 'down';
    controller.moveDayItem(item.id, direction);
    const label = item.kind === 'round' && item.round ? item.round.name : (item.event?.title ?? 'Item');
    onAnnounce(`${label} moved ${direction === 'up' ? 'earlier' : 'later'} in the tournament day.`);
  };

  const drag = useDragReorder((from, to) => {
    const item = orderedItems[from];
    if (!item) return;
    const direction = to < from ? 'up' : 'down';
    for (let index = 0; index < Math.abs(to - from); index += 1) {
      controller.moveDayItem(item.id, direction);
    }
    const label = item.kind === 'round' && item.round ? item.round.name : (item.event?.title ?? 'Item');
    onAnnounce(`${label} moved to position ${to + 1}.`);
  });

  const quickAddEvent = (type: TimelineEventType) => {
    const title = timelineEventTypeLabel(type);
    if (controller.addTimelineEvent({ type, title, visibility: 'public' })) {
      onAnnounce(`${title} added at the end of the day. Use Reorder when you want to change its position.`);
    } else {
      onAnnounce(
        errorNotice(`The ${title.toLowerCase()} event could not be saved; review the Director error.`),
      );
    }
  };

  if (!tournament) {
    return (
      <Page>
        <PageHeader
          title="Tournament day"
          description="A tournament is required before the day can be planned."
        />
        <Callout tone="info" title="No tournament open">
          Create a tournament from Overview before planning rounds and day events.
        </Callout>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Tournament day"
        description={
          activeRound
            ? `${activeRound.name} ${activeRound.status === 'closed' ? 'complete' : activeRound.status === 'released' ? `active · ${activeAccepted} of ${activeGames.length} results in` : 'ready'}${hasTimes ? ` · ${timeZoneLabel(tournament.timeZone)}` : ''}`
            : roundCount === 0
              ? 'No rounds yet. Add the first round when the format is ready.'
              : `${roundCount} round${roundCount === 1 ? '' : 's'} planned${hasTimes ? ` · ${timeZoneLabel(tournament.timeZone)}` : ''}`
        }
        actions={
          <>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => {
                const result = controller.generateSchedule({ deliveryMode: 'manual' });
                onAnnounce(
                  result.generated
                    ? 'Round added at the end of the day.'
                    : errorNotice(result.conflicts.join(' ') || 'The round could not be generated.'),
                );
              }}
            >
              Add round
            </Button>
            <ActionMenu
              label="Add day event"
              triggerLabel="Add event"
              triggerVariant="secondary"
              triggerIcon="plus"
            >
              {(close) => (
                <>
                  {quickEvents.map((event) => (
                    <MenuItem
                      key={event.type}
                      icon={event.icon}
                      onSelect={() => {
                        close();
                        quickAddEvent(event.type);
                      }}
                    >
                      {timelineEventTypeLabel(event.type)}
                    </MenuItem>
                  ))}
                  <MenuItem
                    icon="edit"
                    onSelect={() => {
                      close();
                      setEditingId(null);
                      setShowForm(true);
                    }}
                  >
                    Other event…
                  </MenuItem>
                </>
              )}
            </ActionMenu>
            <ReorderToggle
              active={reorder.active}
              onToggle={reorder.toggle}
              disabled={orderedItems.length < 2}
              label="Reorder day"
            />
          </>
        }
      />

      {reorder.active && <ReorderNotice />}

      {orderedItems.length === 0 ? (
        <Callout tone="info" title="The tournament day is empty">
          Add a round, then insert lunch, breaks, check-in, awards, or another event where the day needs them.
        </Callout>
      ) : (
        <SummaryList ariaLabel="Tournament day" className="director-day-sequence">
          {orderedItems.map((item, index) => {
            const reorderControl = reorder.active ? (
              <ReorderHandle
                label={
                  item.kind === 'round' && item.round ? item.round.name : (item.event?.title ?? 'day item')
                }
                index={index}
                count={orderedItems.length}
                onMove={(delta) => moveItem(item, delta)}
                {...drag.handlers(index)}
              />
            ) : null;
            return item.kind === 'round' && item.round ? (
              <RoundWorkspaceRow
                transfers={transfers}
                key={item.id}
                state={state}
                round={item.round}
                controller={controller}
                onNavigate={go}
                onAnnounce={onAnnounce}
                navigationTarget={navigationTarget}
                onClearNavigationTarget={onClearNavigationTarget}
                reorderControl={reorderControl}
              />
            ) : item.event ? (
              <TimelineEventRow
                key={item.id}
                state={state}
                event={item.event}
                reorderControl={reorderControl}
                onEdit={() => {
                  setEditingId(item.id);
                  setShowForm(true);
                }}
                onDelete={async () => {
                  const approved = await confirmAction({
                    title: `Remove “${item.event?.title}”?`,
                    consequence:
                      'The event will be removed from the tournament-day sequence. Rounds and results are not changed.',
                    confirmLabel: 'Remove event',
                    tone: 'danger',
                  });
                  if (!approved) return;
                  if (controller.removeTimelineEvent(item.id)) onAnnounce(`${item.event?.title} removed.`);
                  else
                    onAnnounce(errorNotice('The schedule event was not removed; review the Director error.'));
                }}
              />
            ) : null;
          })}
        </SummaryList>
      )}

      {showForm && (
        <TimelineEventDialog
          key={editingId ?? 'new'}
          state={state}
          event={editingId ? state.timeline.find((entry) => entry.id === editingId) : undefined}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => {
            setShowForm(false);
            setEditingId(null);
          }}
        />
      )}
    </Page>
  );
}

function friendlyRoundStatus(status: string, accepted: number, total: number): string {
  if (status === 'closed') return 'Complete';
  if (status === 'released') return `Active · ${accepted} of ${total} results in`;
  return total > 0 ? `${total} game${total === 1 ? '' : 's'} · Ready` : 'Ready';
}

function gameLabel(state: DirectorState, game: DirectorState['scheduledGames'][number]): string {
  const left = state.teams.find((team) => team.id === game.leftTeamId)?.displayName ?? 'Unknown team';
  const right = game.rightTeamId
    ? (state.teams.find((team) => team.id === game.rightTeamId)?.displayName ?? 'Unknown team')
    : null;
  return right ? `${left} vs ${right}` : left;
}

function RoundWorkspaceRow({
  transfers,
  state,
  round,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
  reorderControl,
}: {
  transfers?: TransfersRuntime;
  state: DirectorState;
  round: DirectorState['rounds'][number];
  controller: DirectorController;
  onNavigate: Navigate;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
  reorderControl?: React.ReactNode;
}) {
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [packetOpen, setPacketOpen] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [usbOpen, setUsbOpen] = useState(false);
  const [plannedTimeOpen, setPlannedTimeOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const games = state.scheduledGames.filter((game) => game.roundId === round.id && !game.bye);
  const returned = state.submissions.filter(
    (submission) =>
      (submission.status === 'review' || submission.status === 'received') &&
      state.games.some((game) => game.id === submission.gameId && game.roundId === round.id),
  );
  const accepted = games.filter((game) => game.status === 'accepted').length;
  const unresolved = games.filter((game) => game.status !== 'accepted' && game.status !== 'cancelled').length;
  const packetName = round.packetId
    ? (state.packets.find((packet) => packet.id === round.packetId)?.name ?? null)
    : null;
  const roomIds = [...new Set(games.map((game) => game.roomId).filter((id): id is string => id !== null))];
  const roomNames = roomIds
    .map((id) => state.rooms.find((room) => room.id === id)?.name ?? null)
    .filter((name): name is string => name !== null);
  const timeZone = state.tournament?.timeZone ?? 'UTC';
  const highlightedCurrent = useNavigationHighlight(
    navigationTarget,
    'schedule',
    'round',
    round.id,
    onClearNavigationTarget,
  );
  const highlightedLegacy = useNavigationHighlight(
    navigationTarget,
    'tournament',
    'round',
    round.id,
    onClearNavigationTarget,
  );
  const highlighted = highlightedCurrent || highlightedLegacy;
  const isActive = round.status === 'released';
  const isComplete = round.status === 'closed';
  const drives = transfers?.native
    ? state.transfers.locations.filter(
        (location) => location.kind === 'removable-drive' && location.connected && !location.readOnly,
      )
    : [];
  /*
   * Offered whenever there is a game that could in principle be moved — not
   * only when an unblocked destination already exists.
   *
   * Hiding the action when every room is blocked leaves the director with no
   * way to find out *why* they cannot move a game out of a room, which is the
   * opposite of what a blocker is for: it has to say what is wrong and where to
   * fix it. The dialog explains the blocker and keeps its own submit disabled.
   */
  const canMoveGame =
    isActive &&
    games.some(
      (game) =>
        game.roomId !== null &&
        game.status !== 'cancelled' &&
        state.rooms.some((room) => room.id !== game.roomId),
    );

  const start = () => {
    setStarting(true);
    setFailure(null);
    void controller
      .startRound(round.id)
      .then((result) => {
        onAnnounce(result.ok || result.alreadyStarted ? result.summary : errorNotice(result.summary));
        if (!result.ok && !result.alreadyStarted) setFailure(result.reason ?? result.summary);
      })
      .finally(() => setStarting(false));
  };

  const finish = () => {
    setFinishing(true);
    setFailure(null);
    const result = controller.finishRound(round.id);
    onAnnounce(result.finished || result.alreadyFinished ? result.summary : errorNotice(result.summary));
    if (!result.finished && !result.alreadyFinished) setFailure(result.reason ?? result.summary);
    setFinishing(false);
  };

  const primaryAction = isComplete ? (
    <Button
      variant="secondary"
      onClick={() => onNavigate('results', { section: 'results', entityType: 'round', entityId: round.id })}
    >
      View results
    </Button>
  ) : isActive && unresolved === 0 && games.length > 0 ? (
    <Button variant="primary" icon="check" disabled={finishing} onClick={finish}>
      {finishing ? 'Finishing…' : 'Finish round'}
    </Button>
  ) : isActive ? (
    <Button
      variant="primary"
      onClick={() => onNavigate('results', { section: 'results', entityType: 'round', entityId: round.id })}
    >
      Open results
    </Button>
  ) : (
    <Button variant="primary" icon="play" disabled={starting} onClick={start}>
      {starting ? 'Starting…' : 'Start round'}
    </Button>
  );

  const statusState = isComplete ? 'complete' : isActive ? 'active' : 'ready';
  const summary = [
    packetName ? `Packet ${packetName}` : games.length > 0 ? 'No packet assigned' : null,
    roomNames.length > 0
      ? `${roomNames.length} room${roomNames.length === 1 ? '' : 's'} · ${roomNames.slice(0, 3).join(', ')}${roomNames.length > 3 ? '…' : ''}`
      : state.rooms.length > 0 && games.length > 0
        ? 'Rooms not yet assigned'
        : null,
    round.scheduledStart ? `Planned ${formatTimestamp(round.scheduledStart, timeZone)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <SummaryItem
      id={`round-${round.id}`}
      className={highlighted ? 'is-navigation-target' : ''}
      selected={isActive}
      title={
        <strong data-director-navigation-id={round.id} data-director-navigation-focus tabIndex={-1}>
          {round.name}
        </strong>
      }
      status={
        <StateLabel state={statusState} label={friendlyRoundStatus(round.status, accepted, games.length)} />
      }
      summary={summary || 'Pairings and delivery appear here once the round has games.'}
      actions={
        <div className="director-actions">
          {reorderControl}
          {primaryAction}
          <ActionMenu label={`${round.name} actions`} triggerLabel={`${round.name} actions`}>
            {(close) => (
              <>
                {!isActive && !isComplete && (
                  <MenuItem
                    icon="file"
                    onSelect={() => {
                      close();
                      setPacketOpen(true);
                    }}
                  >
                    {packetName ? 'Change packet…' : 'Assign packet…'}
                  </MenuItem>
                )}
                {!isActive && !isComplete && games.length > 0 && state.rooms.length > 0 && (
                  <MenuItem
                    icon="rooms"
                    onSelect={() => {
                      close();
                      setRoomsOpen(true);
                    }}
                  >
                    Assign rooms…
                  </MenuItem>
                )}
                {canMoveGame && (
                  <MenuItem
                    icon="rooms"
                    onSelect={() => {
                      close();
                      setMoveOpen(true);
                    }}
                  >
                    Move game…
                  </MenuItem>
                )}
                {drives.length > 0 && transfers && !isComplete && (
                  <MenuItem
                    icon="usb"
                    onSelect={() => {
                      close();
                      setUsbOpen(true);
                    }}
                  >
                    Put round on USB…
                  </MenuItem>
                )}
                <MenuItem
                  icon="clock"
                  disabled={isActive || isComplete}
                  onSelect={() => {
                    close();
                    setPlannedTimeOpen(true);
                  }}
                >
                  Planned time…
                </MenuItem>
                <MenuItem
                  icon="upload"
                  onSelect={() => {
                    close();
                    onNavigate('transfers');
                  }}
                >
                  Assignment files
                </MenuItem>
                <MenuItem
                  icon="settings"
                  onSelect={() => {
                    close();
                    setRecoveryOpen(true);
                  }}
                >
                  Advanced recovery…
                </MenuItem>
              </>
            )}
          </ActionMenu>
        </div>
      }
    >
      {isActive && games.length > 0 && (
        <Progress
          value={accepted}
          max={games.length}
          label={`${accepted} of ${games.length} results accepted`}
        />
      )}
      {returned.length > 0 && (
        <Callout
          tone="warning"
          title={returned.length === 1 ? '1 result needs review' : `${returned.length} results need review`}
          actions={
            <Button
              variant="quiet"
              onClick={() =>
                onNavigate('results', { section: 'results', entityType: 'round', entityId: round.id })
              }
            >
              Review results
            </Button>
          }
        />
      )}
      {failure && (
        <Callout
          tone="danger"
          title="Round operation failed"
          actions={
            <Button variant="quiet" onClick={() => setRecoveryOpen(true)}>
              Open recovery
            </Button>
          }
        >
          {failure}
        </Callout>
      )}

      {packetOpen && (
        <RoundPacketDialog
          state={state}
          round={round}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setPacketOpen(false)}
        />
      )}
      {roomsOpen && (
        <RoundRoomsDialog
          state={state}
          round={round}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setRoomsOpen(false)}
        />
      )}
      {moveOpen && (
        <MoveGameDialog
          state={state}
          round={round}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setMoveOpen(false)}
        />
      )}
      {usbOpen && transfers && (
        <RoundUsbDialog
          round={round}
          drives={drives}
          transfers={transfers}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setUsbOpen(false)}
        />
      )}
      {plannedTimeOpen && (
        <RoundPlannedTimeDialog
          state={state}
          round={round}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setPlannedTimeOpen(false)}
        />
      )}
      {recoveryOpen && (
        <RoundRecoveryDialog
          state={state}
          roundId={round.id}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setRecoveryOpen(false)}
        />
      )}
    </SummaryItem>
  );
}

function RoundPacketDialog({
  state,
  round,
  controller,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  round: DirectorState['rounds'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const [packetId, setPacketId] = useState(round.packetId ?? '');
  const options: SelectOption[] = state.packets
    .filter((packet) => !packet.retired)
    .map((packet) => ({ value: packet.id, label: packet.name, detail: packet.source || undefined }));
  return (
    <Dialog
      title={`Packet for ${round.name}`}
      description="Choose the packet this round should use."
      onClose={onClose}
      onSubmit={() => {
        void controller.setRoundPacket(round.id, packetId || null).then((saved) => {
          if (saved) {
            onAnnounce(`Packet assignment for ${round.name} updated.`);
            onClose();
          } else onAnnounce(errorNotice('The packet could not be assigned.'));
        });
      }}
      submitLabel="Save packet"
    >
      <Field
        label="Packet"
        render={({ id, labelId, describedBy }) => (
          <Select
            id={id}
            ariaLabelledBy={labelId}
            ariaDescribedBy={describedBy}
            value={packetId}
            options={[{ value: '', label: 'No packet' }, ...options]}
            onChange={setPacketId}
          />
        )}
      />
    </Dialog>
  );
}

function RoundRoomsDialog({
  state,
  round,
  controller,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  round: DirectorState['rounds'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const games = state.scheduledGames.filter(
    (game) => game.roundId === round.id && !game.bye && game.status !== 'cancelled',
  );
  const [draft, setDraft] = useState<Record<string, string | null>>(
    Object.fromEntries(games.map((game) => [game.id, game.roomId])),
  );
  return (
    <Dialog
      title={`Rooms for ${round.name}`}
      description="Each competitive game needs a room. Unavailable rooms remain visible only when they are already assigned to that game."
      size="lg"
      onClose={onClose}
      onSubmit={() => {
        const mode = Object.values(draft).some((roomId) => roomId !== null) ? 'qbtcp' : 'manual';
        if (!controller.setRoundDeliveryMode(round.id, mode)) {
          onAnnounce(
            errorNotice('The round delivery default could not be changed; review the Director error.'),
          );
          return;
        }
        void controller.assignRoundRooms(round.id, draft).then((saved) => {
          if (saved) {
            onAnnounce(`Rooms assigned to ${round.name}.`);
            onClose();
          } else
            onAnnounce(
              errorNotice('Rooms could not be assigned; choose available rooms without duplicates.'),
            );
        });
      }}
      submitLabel="Save rooms"
    >
      <FieldGrid>
        {games.map((game) => {
          const options: SelectOption[] = [
            { value: '', label: 'No room' },
            ...state.rooms
              .filter((room) => roomIsAssignable(state, room.id) || room.id === game.roomId)
              .map((room) => ({
                value: room.id,
                label: room.name,
                detail: room.building || undefined,
                disabled: !roomIsAssignable(state, room.id) && room.id !== game.roomId,
              })),
          ];
          return (
            <Field
              key={game.id}
              label={gameLabel(state, game)}
              render={({ id, labelId, describedBy }) => (
                <Select
                  id={id}
                  ariaLabelledBy={labelId}
                  ariaDescribedBy={describedBy}
                  value={draft[game.id] ?? ''}
                  options={options}
                  onChange={(value) => setDraft((current) => ({ ...current, [game.id]: value || null }))}
                />
              )}
            />
          );
        })}
      </FieldGrid>
    </Dialog>
  );
}

function MoveGameDialog({
  state,
  round,
  controller,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  round: DirectorState['rounds'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  /*
   * Every movable game is listed, including ones with no free destination.
   *
   * Dropping those silently left a director staring at a game that was plainly
   * in the wrong room with nothing in the interface admitting it, let alone
   * saying why. A blocked game is offered and the reason is stated.
   */
  const choices = state.scheduledGames
    .filter(
      (game) => game.roundId === round.id && !game.bye && game.roomId !== null && game.status !== 'cancelled',
    )
    .map((game) => {
      const blockers = state.rooms
        .filter((room) => room.id !== game.roomId)
        .map((room) => ({ room, blocker: releasedGameRoomMoveBlocker(state, game.id, room.id) }));
      return {
        game,
        destinations: blockers.filter((entry) => entry.blocker === null).map((entry) => entry.room),
        // The distinct reasons, so "every room is busy" does not become one line per room.
        reasons: [
          ...new Set(
            blockers.map((entry) => entry.blocker).filter((reason): reason is string => reason !== null),
          ),
        ],
      };
    })
    .filter((entry) => entry.destinations.length > 0 || entry.reasons.length > 0);
  // Open on a game that can actually be moved; a blocked one is still in the
  // list, but it is not what the director is offered first.
  const firstMovable = choices.find((entry) => entry.destinations.length > 0) ?? choices[0];
  const [gameId, setGameId] = useState(firstMovable?.game.id ?? '');
  const selected = choices.find((entry) => entry.game.id === gameId) ?? firstMovable;
  const [roomId, setRoomId] = useState(firstMovable?.destinations[0]?.id ?? '');
  const [moving, setMoving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <Dialog
      title={`Move a game in ${round.name}`}
      description="Only rooms that are available and free of unresolved scorer work are offered."
      onClose={onClose}
      onSubmit={() => {
        if (!selected || !roomId) return;
        setMoving(true);
        setFailure(null);
        void controller
          .moveReleasedGame(selected.game.id, roomId)
          .then((result) => {
            onAnnounce(result.ok ? result.summary : errorNotice(result.reason ?? result.summary));
            if (result.ok) onClose();
            else setFailure(result.reason ?? result.summary);
          })
          .finally(() => setMoving(false));
      }}
      submitLabel={moving ? 'Moving…' : 'Change room'}
      submitDisabled={moving || !selected || !roomId}
    >
      {failure && <Callout tone="danger">{failure}</Callout>}
      {selected && selected.destinations.length === 0 && (
        <Callout tone="warning" role="alert" title="This game cannot be moved yet">
          {selected.reasons.join(' ')}
        </Callout>
      )}
      <Field
        label="Game"
        render={({ id, labelId, describedBy }) => (
          <Select
            id={id}
            ariaLabelledBy={labelId}
            ariaDescribedBy={describedBy}
            value={selected?.game.id ?? ''}
            options={choices.map((entry) => ({ value: entry.game.id, label: gameLabel(state, entry.game) }))}
            onChange={(value) => {
              const next = choices.find((entry) => entry.game.id === value);
              setGameId(value);
              setRoomId(next?.destinations[0]?.id ?? '');
              setFailure(null);
            }}
          />
        )}
      />
      <Field
        label="Destination room"
        render={({ id, labelId, describedBy }) => (
          <Select
            id={id}
            ariaLabelledBy={labelId}
            ariaDescribedBy={describedBy}
            value={roomId}
            options={(selected?.destinations ?? []).map((room) => ({
              value: room.id,
              label: room.name,
              detail: room.building || undefined,
            }))}
            onChange={setRoomId}
          />
        )}
      />
    </Dialog>
  );
}

function RoundUsbDialog({
  round,
  drives,
  transfers,
  controller,
  onAnnounce,
  onClose,
}: {
  round: DirectorState['rounds'][number];
  drives: DirectorState['transfers']['locations'];
  transfers: TransfersRuntime;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const writable = drives.filter(
    (drive) => drive.kind === 'removable-drive' && drive.connected && !drive.readOnly,
  );
  const [driveId, setDriveId] = useState(writable[0]?.id ?? '');
  const active = driveId ? transfers.isOperationActive(prepareOperation(driveId)) : false;
  return (
    <Dialog
      title={`Put ${round.name} on USB`}
      description="Copy this round's assignment files to the drive. Games already routed elsewhere keep their own routes."
      onClose={onClose}
      onSubmit={() => {
        if (!driveId) return;
        if (round.status !== 'released' && !controller.setRoundDeliveryMode(round.id, 'usb')) {
          onAnnounce(errorNotice('USB delivery could not be selected; review the Director error.'));
          return;
        }
        void transfers.prepareTo(driveId, { kind: 'round', roundId: round.id });
        onAnnounce(`${round.name} assignment files are being prepared for USB.`);
        onClose();
      }}
      submitLabel={active ? 'Preparing…' : 'Prepare USB'}
      submitDisabled={!driveId || active}
    >
      <Field
        label="Drive"
        render={({ id, labelId, describedBy }) => (
          <Select
            id={id}
            ariaLabelledBy={labelId}
            ariaDescribedBy={describedBy}
            value={driveId}
            options={writable.map((drive) => ({
              value: drive.id,
              label: drive.label,
              detail: drive.path || undefined,
            }))}
            onChange={setDriveId}
          />
        )}
      />
    </Dialog>
  );
}

function RoundPlannedTimeDialog({
  state,
  round,
  controller,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  round: DirectorState['rounds'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const timeZone = state.tournament?.timeZone ?? 'UTC';
  const initial = splitLocalDateTime(isoToZonedDateTimeInput(round.scheduledStart, timeZone));
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  return (
    <Dialog
      title={`Planned time for ${round.name}`}
      description={`Times are interpreted in ${timeZoneLabel(timeZone)}.`}
      onClose={onClose}
      onSubmit={() => {
        const local = joinLocalDateTime(date, time);
        const iso = local ? zonedDateTimeInputToIso(local, timeZone) : null;
        if (local && !iso) {
          onAnnounce(errorNotice('That local time does not exist in the tournament timezone.'));
          return;
        }
        if (controller.setRoundScheduledStart(round.id, iso)) {
          onAnnounce(`${round.name} planned time updated.`);
          onClose();
        } else onAnnounce(errorNotice('The planned time was not saved; review the Director error.'));
      }}
      submitLabel="Save planned time"
    >
      <FieldGrid>
        <Field
          label="Date"
          optional
          render={({ id, describedBy }) => (
            <DateField
              id={id}
              aria-describedby={describedBy}
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          )}
        />
        <Field
          label="Time"
          optional
          render={({ id, describedBy }) => (
            <TimeField
              id={id}
              aria-describedby={describedBy}
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          )}
        />
      </FieldGrid>
    </Dialog>
  );
}

function RoundRecoveryDialog({
  state,
  roundId,
  controller,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  roundId: string;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const confirmAction = useConfirm();
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round) return null;
  const games = state.scheduledGames.filter((game) => game.roundId === round.id && !game.bye);
  return (
    <Dialog
      title={`Advanced recovery — ${round.name}`}
      description="Use these controls only to repair an interrupted or inconsistent tournament state. Normal operation uses Start and Finish."
      size="lg"
      onClose={onClose}
      cancelLabel="Done"
    >
      <Callout tone="warning" title="Recovery controls bypass the normal round workflow">
        Verify the round, room assignments, and returned results before changing the internal state manually.
      </Callout>
      <Diagnostics
        standalone={false}
        defaultOpen
        items={[
          { term: 'Internal state', value: round.status },
          { term: 'Revision', value: round.revision },
          { term: 'Competitive games', value: games.length },
        ]}
      />
      <DialogSection title="State repair">
        <div className="director-actions">
          {round.status === 'planned' && (
            <Button
              variant="secondary"
              onClick={() => {
                const prepared = controller.prepareRound(round.id);
                onAnnounce(
                  prepared
                    ? `${round.name} prepared.`
                    : errorNotice(`${round.name} could not be prepared; review the schedule first.`),
                );
              }}
            >
              Prepare
            </Button>
          )}
          {round.status === 'prepared' && (
            <Button
              variant="secondary"
              onClick={() => {
                void Promise.resolve(controller.releaseRound(round.id)).then((released) => {
                  onAnnounce(
                    released
                      ? `${round.name} released.`
                      : errorNotice('The round is not ready to release; review room assignments first.'),
                  );
                });
              }}
            >
              Release
            </Button>
          )}
          {round.status === 'released' && (
            <Button
              variant="secondary"
              onClick={() => {
                const closed = controller.closeRound(round.id);
                const blockers = !roundScheduleIsValid(state, round.id)
                  ? ['This round contains an invalid matchup or round membership and cannot be closed.']
                  : roundCloseBlockers(state, round.id);
                onAnnounce(
                  closed
                    ? `${round.name} closed.`
                    : errorNotice(blockers[0] ?? `${round.name} could not close; resolve every game first.`),
                );
              }}
            >
              Close
            </Button>
          )}
        </div>
      </DialogSection>
      <DialogSection
        title="Remove round"
        description="Removal also removes the round's games and dependent result records."
      >
        <Button
          variant="danger"
          onClick={async () => {
            const approved = await confirmAction({
              title: `Remove ${round.name}?`,
              body: 'A recovery point will be created before removal.',
              consequence:
                'The round, its games, submissions, protests, and any accepted results will be removed from the current tournament state.',
              confirmLabel: 'Remove round',
              tone: 'danger',
            });
            if (!approved) return;
            try {
              const removed = await removeRoundFlexibly(controller, round.id);
              onAnnounce(
                removed
                  ? `${round.name} removed. Restore it from Settings → Recovery if needed.`
                  : errorNotice(
                      roundRemovalBlocker(state, round.id) ??
                        'The round was not removed; review the Director error.',
                    ),
              );
              if (removed) onClose();
            } catch (reason: unknown) {
              onAnnounce(
                errorNotice(
                  reason instanceof Error
                    ? `${round.name} was not removed: ${reason.message}`
                    : `${round.name} was not removed.`,
                ),
              );
            }
          }}
        >
          Remove round…
        </Button>
      </DialogSection>
    </Dialog>
  );
}

function TimelineEventRow({
  state,
  event,
  onEdit,
  onDelete,
  reorderControl,
}: {
  state: DirectorState;
  event: TournamentTimelineEvent;
  onEdit: () => void;
  onDelete: () => Promise<void>;
  reorderControl?: React.ReactNode;
}) {
  const timeZone = state.tournament?.timeZone ?? 'UTC';
  const location = event.roomId
    ? (state.rooms.find((room) => room.id === event.roomId)?.name ?? event.roomId)
    : event.location;
  const time = [
    event.scheduledStart ? formatTimestamp(event.scheduledStart, timeZone) : null,
    event.scheduledStart && event.scheduledEnd ? `– ${formatTimestamp(event.scheduledEnd, timeZone)}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <SummaryItem
      title={<strong>{event.title}</strong>}
      status={<StateLabel state="scheduled" label={timelineEventTypeLabel(event.type)} />}
      summary={[time, location, event.description].filter(Boolean).join(' · ') || 'Day event'}
      actions={
        <div className="director-actions">
          {reorderControl}
          <Button variant="secondary" icon="edit" onClick={onEdit}>
            Edit
          </Button>
          <ActionMenu label={`${event.title} actions`} triggerLabel={`${event.title} actions`}>
            {(close) => (
              <MenuItem
                icon="trash"
                tone="danger"
                onSelect={() => {
                  close();
                  void onDelete();
                }}
              >
                Remove event…
              </MenuItem>
            )}
          </ActionMenu>
        </div>
      }
    />
  );
}

const eventTypeOptions: SelectOption<TimelineEventType>[] = timelineEventTypes.map((type) => ({
  value: type,
  label: timelineEventTypeLabel(type),
}));

function TimelineEventDialog({
  state,
  event,
  controller,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  event?: TournamentTimelineEvent;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const timeZone = state.tournament?.timeZone ?? 'UTC';
  const initialStart = splitLocalDateTime(isoToZonedDateTimeInput(event?.scheduledStart, timeZone));
  const initialEnd = splitLocalDateTime(isoToZonedDateTimeInput(event?.scheduledEnd, timeZone));
  const [type, setType] = useState<TimelineEventType>(event?.type ?? 'custom');
  const [title, setTitle] = useState(event?.title ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [startDate, setStartDate] = useState(initialStart.date);
  const [startTime, setStartTime] = useState(initialStart.time);
  const [endDate, setEndDate] = useState(initialEnd.date);
  const [endTime, setEndTime] = useState(initialEnd.time);
  const [visibility, setVisibility] = useState<TimelineVisibility>(event?.visibility ?? 'public');
  const [roomId, setRoomId] = useState(event?.roomId ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [teamIds, setTeamIds] = useState<string[]>(event?.teamIds ?? []);

  const save = () => {
    const start = joinLocalDateTime(startDate, startTime);
    const end = joinLocalDateTime(endDate, endTime);
    const scheduledStart = start ? zonedDateTimeInputToIso(start, timeZone) : null;
    const scheduledEnd = end ? zonedDateTimeInputToIso(end, timeZone) : null;
    if (start && !scheduledStart) {
      onAnnounce(errorNotice('The event start is not a valid time in the tournament timezone.'));
      return;
    }
    if (end && !scheduledEnd) {
      onAnnounce(errorNotice('The event end is not a valid time in the tournament timezone.'));
      return;
    }
    if (!title.trim()) {
      onAnnounce(errorNotice('Enter an event title first.'));
      return;
    }
    const input: NewTimelineEventInput = {
      type,
      title,
      description,
      scheduledStart,
      scheduledEnd,
      visibility,
      roomId: roomId || null,
      location,
      teamIds,
    };
    const saved = event
      ? controller.updateTimelineEvent(event.id, input)
      : controller.addTimelineEvent(input);
    if (!saved) {
      onAnnounce(errorNotice('The schedule event could not be saved; review the Director error.'));
      return;
    }
    onAnnounce(event ? `${title.trim()} updated.` : `${title.trim()} added to the schedule.`);
    onClose();
  };

  return (
    <Dialog
      title={event ? `Edit ${event.title}` : 'Add day event'}
      description={`Times use ${timeZoneLabel(timeZone)}. Leave Target teams empty for the whole tournament.`}
      size="lg"
      onClose={onClose}
      onSubmit={save}
      submitLabel={event ? 'Save changes' : 'Add event'}
    >
      <FieldGrid>
        <Field
          label="Event type"
          render={({ id, labelId, describedBy }) => (
            <Select
              id={id}
              ariaLabelledBy={labelId}
              ariaDescribedBy={describedBy}
              value={type}
              options={eventTypeOptions}
              onChange={setType}
            />
          )}
        />
        <Field
          label="Title"
          render={({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              required
              value={title}
              onChange={(eventObject) => setTitle(eventObject.target.value)}
            />
          )}
        />
        <Field
          label="Visibility"
          render={({ id, describedBy }) => (
            <Select<TimelineVisibility>
              id={id}
              ariaDescribedBy={describedBy}
              value={visibility}
              options={[
                { value: 'public', label: 'Public' },
                { value: 'staff', label: 'Staff' },
                { value: 'hidden', label: 'Hidden' },
              ]}
              onChange={setVisibility}
            />
          )}
        />
        <Field
          label="Room"
          optional
          render={({ id, labelId, describedBy }) => (
            <Select
              id={id}
              ariaLabelledBy={labelId}
              ariaDescribedBy={describedBy}
              value={roomId}
              options={[
                { value: '', label: 'No numbered room' },
                ...state.rooms.map((room) => ({
                  value: room.id,
                  label: room.name,
                  detail: room.building || undefined,
                })),
              ]}
              onChange={setRoomId}
            />
          )}
        />
      </FieldGrid>
      <DialogSection title="Timing">
        <FieldGrid>
          <Field
            label="Start date"
            optional
            render={({ id, describedBy }) => (
              <DateField
                id={id}
                aria-describedby={describedBy}
                value={startDate}
                onChange={(eventObject) => setStartDate(eventObject.target.value)}
              />
            )}
          />
          <Field
            label="Start time"
            optional
            render={({ id, describedBy }) => (
              <TimeField
                id={id}
                aria-describedby={describedBy}
                value={startTime}
                onChange={(eventObject) => setStartTime(eventObject.target.value)}
              />
            )}
          />
          <Field
            label="End date"
            optional
            render={({ id, describedBy }) => (
              <DateField
                id={id}
                aria-describedby={describedBy}
                value={endDate}
                onChange={(eventObject) => setEndDate(eventObject.target.value)}
              />
            )}
          />
          <Field
            label="End time"
            optional
            render={({ id, describedBy }) => (
              <TimeField
                id={id}
                aria-describedby={describedBy}
                value={endTime}
                onChange={(eventObject) => setEndTime(eventObject.target.value)}
              />
            )}
          />
        </FieldGrid>
      </DialogSection>
      <Field
        label="Other location"
        optional
        render={({ id, describedBy }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            value={location}
            onChange={(eventObject) => setLocation(eventObject.target.value)}
            placeholder="Lobby, auditorium…"
          />
        )}
      />
      <Field
        label="Description"
        optional
        render={({ id, describedBy }) => (
          <TextArea
            id={id}
            aria-describedby={describedBy}
            rows={3}
            value={description}
            onChange={(eventObject) => setDescription(eventObject.target.value)}
          />
        )}
      />
      <Field
        label="Target teams"
        hint="No selection means the whole tournament."
        render={({ id, labelId, describedBy }) => (
          <MultiSelect
            id={id}
            ariaLabelledBy={labelId}
            ariaDescribedBy={describedBy}
            values={teamIds}
            options={state.teams
              .filter((team) => team.status !== 'dropped')
              .map((team) => ({ value: team.id, label: team.displayName }))}
            onChange={setTeamIds}
            allLabel="Everybody"
            searchPlaceholder="Filter teams…"
          />
        )}
      />
    </Dialog>
  );
}

function splitLocalDateTime(value: string): { date: string; time: string } {
  if (!value) return { date: '', time: '' };
  const [date = '', time = ''] = value.split('T');
  return { date, time: time.slice(0, 5) };
}

function joinLocalDateTime(date: string, time: string): string {
  if (!date && !time) return '';
  if (!date || !time) return '';
  return `${date}T${time}`;
}

function formatTimestamp(value: string, timeZone: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return 'Invalid time';
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(instant);
}

// Keep this exported for focused tests and future settings UI without duplicating the runtime list.
export const scheduleTimeZoneOptions = availableTimeZones;
