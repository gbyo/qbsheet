import { useMemo, useRef, useState } from 'react';
import {
  availableTimeZones,
  isoToZonedDateTimeInput,
  latestRound,
  orderDayItems,
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
import { Button, FormField } from '../components/Controls';
import { DirectorMenu } from '../components/DirectorMenu';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { errorNotice, type AnnounceInput } from '../notices';

/** One-click day events. Anything else uses the full event form. */
const quickEventTypes: TimelineEventType[] = ['lunch', 'break', 'check-in', 'awards'];

type Navigate = (section: SectionId, target?: DirectorNavigationTarget | null) => void;

export function RoundsView({
  state,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
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
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const quickAddOpenerRef = useRef<HTMLElement | null>(null);

  const quickAddEvent = (type: TimelineEventType) => {
    const title = timelineEventTypeLabel(type);
    if (controller.addTimelineEvent({ type, title, visibility: 'public' })) {
      onAnnounce(`${title} added at the end of the day. Reorder it with the move buttons.`);
    } else {
      onAnnounce(
        errorNotice(`The ${title.toLowerCase()} event could not be saved; review the Director error.`),
      );
    }
    setShowQuickAdd(false);
  };
  // The tournament day in its explicit persisted order. Timestamps never decide
  // placement; see `packages/tournament-domain/src/dayOrder.ts`.
  const orderedItems: OrderedDayItem[] = useMemo(
    () => orderDayItems(state.rounds, state.timeline),
    [state.rounds, state.timeline],
  );
  const activeRound =
    state.rounds.find((entry) => entry.id === tournament?.currentRoundId) ?? latestRound(state.rounds);
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
  if (!tournament) {
    return (
      <>
        <div className="director-workspace-header">
          <div>
            <h1>Tournament day</h1>
            <p className="director-workspace-sub">A tournament is required before the day can be planned.</p>
          </div>
        </div>
        <p className="director-empty-copy">Create a tournament from the Overview page first.</p>
      </>
    );
  }

  return (
    <>
      <div className="director-workspace-header">
        <div>
          <h1>Tournament day</h1>
          <p className="director-workspace-sub">
            {activeRound
              ? `${activeRound.name} ${activeRound.status === 'closed' ? 'complete' : activeRound.status === 'released' ? `active · ${activeAccepted} of ${activeGames.length} results in` : 'ready'}`
              : roundCount === 0
                ? 'No rounds yet — generate the plan from Format, or add a round.'
                : `${roundCount} round${roundCount === 1 ? '' : 's'} planned`}
            {hasTimes ? ` · ${timeZoneLabel(tournament.timeZone)}` : ''}
          </p>
        </div>
        <div className="director-workspace-actions">
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              const result = controller.generateSchedule();
              onAnnounce(
                result.generated
                  ? 'Round added at the end of the day.'
                  : result.conflicts.join(' ') || 'The round could not be generated.',
              );
            }}
          >
            Add round
          </Button>
          <span
            ref={(node) => {
              quickAddOpenerRef.current = node;
            }}
          >
            <Button
              variant="secondary"
              aria-haspopup="menu"
              aria-expanded={showQuickAdd}
              onClick={() => setShowQuickAdd((open) => !open)}
            >
              Add event
            </Button>
          </span>
          {showQuickAdd && (
            <DirectorMenu
              label="Add day event"
              openerRef={quickAddOpenerRef}
              onClose={() => setShowQuickAdd(false)}
            >
              {quickEventTypes.map((type) => (
                <button key={type} role="menuitem" type="button" onClick={() => quickAddEvent(type)}>
                  {timelineEventTypeLabel(type)}
                </button>
              ))}
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setShowQuickAdd(false);
                  setEditingId(null);
                  setShowForm(true);
                }}
              >
                Other event…
              </button>
            </DirectorMenu>
          )}
        </div>
      </div>
      {orderedItems.length === 0 ? (
        <p className="director-empty-copy">
          No rounds or day events have been planned yet. Use your format plan to generate rounds, then insert
          lunch or breaks where the day needs them.
        </p>
      ) : (
        <ol className="director-day-sequence">
          {orderedItems.map((item, index) => {
            const moveProps = {
              position: index + 1,
              total: orderedItems.length,
              onMoveUp: () => controller.moveDayItem(item.id, 'up'),
              onMoveDown: () => controller.moveDayItem(item.id, 'down'),
            };
            return item.kind === 'round' && item.round ? (
              <RoundWorkspaceRow
                key={item.id}
                state={state}
                round={item.round}
                controller={controller}
                onNavigate={go}
                onAnnounce={onAnnounce}
                navigationTarget={navigationTarget}
                onClearNavigationTarget={onClearNavigationTarget}
                {...moveProps}
              />
            ) : item.event ? (
              <TimelineEventRow
                key={item.id}
                state={state}
                event={item.event}
                onEdit={() => {
                  setEditingId(item.id);
                  setShowForm(true);
                }}
                onDelete={() => {
                  if (!confirm(`Remove “${item.event?.title}” from the day?`)) return;
                  if (controller.removeTimelineEvent(item.id)) onAnnounce(`${item.event?.title} removed.`);
                }}
                {...moveProps}
              />
            ) : null;
          })}
        </ol>
      )}
      {showForm && (
        <TimelineEventForm
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
    </>
  );
}

/** Friendly operational wording; the storage state machine stays out of the normal path. */
function friendlyRoundStatus(status: string, accepted: number, total: number): string {
  if (status === 'closed') return 'complete';
  if (status === 'released') return total > 0 ? `${accepted} of ${total} results in` : 'active';
  return total > 0 ? `${total} game${total === 1 ? '' : 's'} · ready` : 'ready';
}

function RoundWorkspaceRow({
  state,
  round,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
  position,
  total,
  onMoveUp,
  onMoveDown,
}: {
  state: DirectorState;
  round: DirectorState['rounds'][number];
  controller: DirectorController;
  onNavigate: Navigate;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
  position: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const games = state.scheduledGames.filter((game) => game.roundId === round.id && !game.bye);
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

  const start = () => {
    setStarting(true);
    setFailure(null);
    void controller
      .startRound(round.id)
      .then((result) => {
        onAnnounce(result.summary);
        if (!result.ok && !result.alreadyStarted) setFailure(result.reason ?? result.summary);
      })
      .finally(() => setStarting(false));
  };
  const finish = () => {
    setFinishing(true);
    setFailure(null);
    const result = controller.finishRound(round.id);
    onAnnounce(result.summary);
    if (!result.finished && !result.alreadyFinished) setFailure(result.reason ?? result.summary);
    setFinishing(false);
  };

  return (
    <li
      tabIndex={-1}
      data-director-navigation-id={round.id}
      className={`director-round${isActive ? ' is-active' : ''}${isComplete ? ' is-complete' : ''}${highlighted ? ' is-navigation-target' : ''}`}
      aria-current={isActive ? 'step' : undefined}
    >
      <span className="director-round-number" aria-hidden="true">
        {String(round.number).padStart(2, '0')}
      </span>
      <div className="director-round-main">
        <div className="director-round-title-row">
          <strong data-director-navigation-focus tabIndex={-1}>
            {round.name}
          </strong>
          <span className="director-round-status">
            {friendlyRoundStatus(round.status, accepted, games.length)}
          </span>
        </div>
        <p className="director-round-context">
          {[
            packetName ? `Packet: ${packetName}` : null,
            roomIds.length > 0
              ? `${roomIds.length} room${roomIds.length === 1 ? '' : 's'}${roomNames.length > 0 ? ` · ${roomNames.slice(0, 3).join(', ')}${roomNames.length > 3 ? '…' : ''}` : ''}`
              : state.rooms.length > 0
                ? 'Rooms not yet assigned'
                : null,
            round.scheduledStart ? `Planned ${formatTimestamp(round.scheduledStart, timeZone)}` : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'Pairings and delivery appear here once the round has games.'}
        </p>
        {!isComplete && unresolved > 0 && isActive && (
          <p className="director-round-progress">
            <button type="button" className="director-inline-action" onClick={() => onNavigate('results')}>
              {unresolved} result{unresolved === 1 ? '' : 's'} still playing or awaiting review — open Results
            </button>
          </p>
        )}
        {failure && (
          <p className="director-round-failure" role="alert">
            {failure}{' '}
            <button
              type="button"
              className="director-inline-action"
              onClick={() => {
                setFailure(null);
                setShowAdvanced(true);
              }}
            >
              Show recovery options
            </button>
          </p>
        )}
        <div className="director-round-actions">
          {!isComplete && !isActive && (
            <Button variant="primary" icon="play" disabled={starting} onClick={start}>
              {starting ? `Starting ${round.name}…` : `Start ${round.name}`}
            </Button>
          )}
          {isActive && (
            <Button variant="primary" icon="chevron" disabled={finishing} onClick={finish}>
              {finishing ? `Finishing ${round.name}…` : `Finish ${round.name}`}
            </Button>
          )}
          {packetName == null && !isComplete && (
            <Button variant="quiet" onClick={() => onNavigate('packets')}>
              Assign packet
            </Button>
          )}
          {roomIds.length === 0 && !isComplete && state.rooms.length > 0 && (
            <Button variant="quiet" onClick={() => onNavigate('rooms')}>
              Assign rooms
            </Button>
          )}
          {isActive && (
            <Button variant="quiet" onClick={() => onNavigate('results')}>
              Open results
            </Button>
          )}
          <DayMoveButtons
            label={round.name}
            position={position}
            total={total}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
          />
          {!isComplete && (
            <button
              type="button"
              className="director-inline-action"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((open) => !open)}
            >
              {showAdvanced ? 'Hide details' : 'Details & recovery'}
            </button>
          )}
        </div>
        {showAdvanced && !isComplete && (
          <RoundAdvancedDetails
            state={state}
            roundId={round.id}
            roundName={round.name}
            controller={controller}
            onNavigate={onNavigate}
            onAnnounce={onAnnounce}
          />
        )}
      </div>
    </li>
  );
}

function RoundAdvancedDetails({
  state,
  roundId,
  roundName,
  controller,
  onNavigate,
  onAnnounce,
}: {
  state: DirectorState;
  roundId: string;
  roundName: string;
  controller: DirectorController;
  onNavigate: Navigate;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const round = state.rounds.find((entry) => entry.id === roundId);
  const timeZone = state.tournament?.timeZone ?? 'UTC';
  const [value, setValue] = useState(isoToZonedDateTimeInput(round?.scheduledStart, timeZone));
  if (!round) return null;
  const saveTime = () => {
    const iso = value ? zonedDateTimeInputToIso(value, timeZone) : null;
    if (value && !iso) {
      onAnnounce('That local time does not exist in the tournament timezone.');
      return;
    }
    if (controller.setRoundScheduledStart(round.id, iso)) onAnnounce(`${round.name} planned time updated.`);
  };
  const games = state.scheduledGames.filter((game) => game.roundId === round.id && !game.bye);
  return (
    <div className="director-round-advanced">
      <p className="director-round-advanced-note">
        Recovery transitions. The normal workflow is Start and Finish above; these exist for repair and
        diagnostics.
      </p>
      <div className="director-row-actions">
        <span className="director-muted">
          Internal state: {round.status} · revision {round.revision}
        </span>
        {round.status === 'planned' && (
          <Button
            variant="quiet"
            onClick={() => {
              const prepared = controller.prepareRound(round.id);
              onAnnounce(
                prepared
                  ? `${roundName} prepared.`
                  : `${roundName} could not be prepared; review the schedule first.`,
              );
            }}
          >
            Prepare
          </Button>
        )}
        {round.status === 'prepared' && (
          <Button
            variant="quiet"
            onClick={() => {
              const released = controller.releaseRound(round.id);
              onAnnounce(
                released
                  ? `${roundName} released.`
                  : 'The round is not ready to release; review the Director error and room assignments.',
              );
            }}
          >
            Release
          </Button>
        )}
        {round.status === 'released' && (
          <Button
            variant="quiet"
            onClick={() => {
              const closed = controller.closeRound(round.id);
              onAnnounce(
                closed
                  ? `${roundName} closed.`
                  : `${roundName} could not close; accept or cancel every game first.`,
              );
            }}
          >
            Close
          </Button>
        )}
        <Button variant="quiet" icon="upload" onClick={() => onNavigate('transfers')}>
          Assignment files
        </Button>
      </div>
      <div className="director-round-advanced-grid">
        <FormField label={`Planned start for ${round.name}`}>
          <input
            type="datetime-local"
            value={value}
            disabled={round.status === 'released' || round.status === 'closed'}
            onChange={(event) => setValue(event.target.value)}
            onBlur={saveTime}
          />
        </FormField>
        <p className="director-muted">
          {games.length} competitive game{games.length === 1 ? '' : 's'}
          {round.releasedAt ? ` · released ${formatTimestamp(round.releasedAt, timeZone)}` : ''}
          {round.startedAt ? ` · started ${formatTimestamp(round.startedAt, timeZone)}` : ''}
        </p>
      </div>
    </div>
  );
}

function DayMoveButtons({
  label,
  position,
  total,
  onMoveUp,
  onMoveDown,
}: {
  label: string;
  position: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <div className="director-row-actions" role="group" aria-label={`Reorder ${label}`}>
      <Button
        variant="quiet"
        disabled={position <= 1}
        aria-label={`Move ${label} earlier`}
        onClick={onMoveUp}
      >
        ↑ Up
      </Button>
      <Button
        variant="quiet"
        disabled={position >= total}
        aria-label={`Move ${label} later`}
        onClick={onMoveDown}
      >
        ↓ Down
      </Button>
    </div>
  );
}

function TimelineEventRow({
  state,
  event,
  onEdit,
  onDelete,
  position,
  total,
  onMoveUp,
  onMoveDown,
}: {
  state: DirectorState;
  event: TournamentTimelineEvent;
  onEdit: () => void;
  onDelete: () => void;
  position: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const timeZone = state.tournament?.timeZone ?? 'UTC';
  const location = event.roomId
    ? (state.rooms.find((room) => room.id === event.roomId)?.name ?? event.roomId)
    : event.location;
  return (
    <li className="director-day-event">
      <span className="director-day-event-marker" aria-hidden="true">
        {timelineEventTypeLabel(event.type).slice(0, 1)}
      </span>
      <div className="director-round-main">
        <div className="director-round-title-row">
          <strong>{event.title}</strong>
          <span className="director-round-status">
            {timelineEventTypeLabel(event.type)}
            {location ? ` · ${location}` : ''}
          </span>
        </div>
        {event.description ? <p className="director-round-context">{event.description}</p> : null}
        <div className="director-round-actions">
          <DayMoveButtons
            label={event.title}
            position={position}
            total={total}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
          />
          <Button variant="quiet" icon="edit" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="quiet" icon="x" onClick={onDelete}>
            Remove
          </Button>
        </div>
        <p className="director-muted">
          {[
            event.scheduledStart ? formatTimestamp(event.scheduledStart, timeZone) : null,
            event.scheduledStart && event.scheduledEnd
              ? `– ${formatTimestamp(event.scheduledEnd, timeZone)}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
    </li>
  );
}

const eventTypeOptions: Array<{ value: TimelineEventType; label: string }> = timelineEventTypes.map(
  (type) => ({
    value: type,
    label: timelineEventTypeLabel(type),
  }),
);

function TimelineEventForm({
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
  const [type, setType] = useState<TimelineEventType>(event?.type ?? 'custom');
  const [title, setTitle] = useState(event?.title ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [start, setStart] = useState(isoToZonedDateTimeInput(event?.scheduledStart, timeZone));
  const [end, setEnd] = useState(isoToZonedDateTimeInput(event?.scheduledEnd, timeZone));
  const [visibility, setVisibility] = useState<TimelineVisibility>(event?.visibility ?? 'public');
  const [roomId, setRoomId] = useState(event?.roomId ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [teamIds, setTeamIds] = useState<string[]>(event?.teamIds ?? []);
  const save = () => {
    const scheduledStart = start ? zonedDateTimeInputToIso(start, timeZone) : null;
    const scheduledEnd = end ? zonedDateTimeInputToIso(end, timeZone) : null;
    if (start && !scheduledStart) {
      onAnnounce('The event start is not a valid time in the tournament timezone.');
      return;
    }
    if (end && !scheduledEnd) {
      onAnnounce('The event end is not a valid time in the tournament timezone.');
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
    <section className="director-panel director-form-panel" aria-label={event ? 'Edit event' : 'New event'}>
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">{event ? 'Edit event' : 'New event'}</p>
          <h2>Schedule details</h2>
        </div>
        <Button variant="quiet" icon="x" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="director-panel-body">
        <form
          onSubmit={(eventObject) => {
            eventObject.preventDefault();
            save();
          }}
        >
          <div className="director-form-grid director-form-grid-three">
            <FormField label="Event type">
              <select
                value={type}
                onChange={(eventObject) => setType(eventObject.target.value as TimelineEventType)}
              >
                {eventTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Title">
              <input value={title} onChange={(eventObject) => setTitle(eventObject.target.value)} required />
            </FormField>
            <FormField label="Visibility">
              <select
                value={visibility}
                onChange={(eventObject) => setVisibility(eventObject.target.value as TimelineVisibility)}
              >
                <option value="public">Public</option>
                <option value="staff">Staff</option>
                <option value="hidden">Hidden</option>
              </select>
            </FormField>
          </div>
          <div className="director-form-grid director-form-grid-two">
            <FormField label={`Start (${timeZone})`}>
              <input
                type="datetime-local"
                value={start}
                onChange={(eventObject) => setStart(eventObject.target.value)}
              />
            </FormField>
            <FormField label={`End (${timeZone})`}>
              <input
                type="datetime-local"
                value={end}
                onChange={(eventObject) => setEnd(eventObject.target.value)}
              />
            </FormField>
            <FormField label="Room">
              <select value={roomId} onChange={(eventObject) => setRoomId(eventObject.target.value)}>
                <option value="">No numbered room</option>
                {state.rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Other location">
              <input
                value={location}
                onChange={(eventObject) => setLocation(eventObject.target.value)}
                placeholder="Lobby, auditorium…"
              />
            </FormField>
          </div>
          <FormField label="Description">
            <textarea
              className="director-textarea"
              rows={2}
              value={description}
              onChange={(eventObject) => setDescription(eventObject.target.value)}
            />
          </FormField>
          <fieldset className="director-resource-role-field">
            <legend>Target teams</legend>
            <div className="director-check-group">
              {state.teams
                .filter((team) => team.status !== 'dropped')
                .map((team) => (
                  <label className="director-check-row" key={team.id}>
                    <input
                      type="checkbox"
                      checked={teamIds.includes(team.id)}
                      onChange={(eventObject) =>
                        setTeamIds((current) =>
                          eventObject.target.checked
                            ? [...current, team.id]
                            : current.filter((id) => id !== team.id),
                        )
                      }
                    />
                    <span>{team.displayName}</span>
                  </label>
                ))}
            </div>
            <small>Leave every team unchecked to target the whole tournament.</small>
          </fieldset>
          <div className="director-row-actions">
            <Button variant="primary" type="submit">
              {event ? 'Save changes' : 'Add event'}
            </Button>
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
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
