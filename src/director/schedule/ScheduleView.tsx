import { useMemo, useRef, useState } from 'react';
import {
  availableTimeZones,
  isoToZonedDateTimeInput,
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
import { Button, FormField, PanelBody, StateLabel } from '../components/Controls';
import { DirectorMenu } from '../components/DirectorMenu';
import { PageHeader } from '../components/PageHeader';
import { errorNotice, type AnnounceInput } from '../notices';

/** One-click day events. Anything else uses the full event form. */
const quickEventTypes: TimelineEventType[] = ['lunch', 'break', 'check-in', 'awards'];

const eventTypeOptions: Array<{ value: TimelineEventType; label: string }> = timelineEventTypes.map(
  (type) => ({
    value: type,
    label: timelineEventTypeLabel(type),
  }),
);

export function ScheduleView({
  state,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
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
  const hasTimes = useMemo(
    () =>
      state.rounds.some((round) => round.scheduledStart) ||
      state.timeline.some((event) => event.scheduledStart || event.scheduledEnd),
    [state.rounds, state.timeline],
  );
  if (!tournament) {
    return (
      <>
        <PageHeader
          eyebrow="Plan"
          title="Schedule"
          description="A tournament is required before the day can be planned."
        />
        <section className="director-panel">
          <PanelBody>
            <p className="director-empty-copy">Create a tournament from the Overview page first.</p>
          </PanelBody>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Rounds"
        description={
          hasTimes
            ? `Tournament day in ${timeZoneLabel(tournament.timeZone)}. Planned times are stored as absolute instants and stay fixed when this file moves computers.`
            : 'The order of the day, top to bottom. Times are optional — add them only where they matter.'
        }
        actions={
          <>
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
          </>
        }
      />
      <div className="director-page-stack">
        <section className="director-panel" aria-label="Tournament day">
          <div className="director-panel-heading">
            <div>
              <h2>
                {orderedItems.length} day item{orderedItems.length === 1 ? '' : 's'}
              </h2>
            </div>
            {hasTimes && <StateLabel state="info" label={timeZoneLabel(tournament.timeZone)} />}
          </div>
          <PanelBody>
            {orderedItems.length === 0 ? (
              <p className="director-empty-copy">No rounds or day events have been planned yet.</p>
            ) : (
              <ol className="director-schedule-timeline">
                {orderedItems.map((item, index) => {
                  const moveProps = {
                    position: index + 1,
                    total: orderedItems.length,
                    onMoveUp: () => controller.moveDayItem(item.id, 'up'),
                    onMoveDown: () => controller.moveDayItem(item.id, 'down'),
                  };
                  return item.kind === 'round' && item.round ? (
                    <RoundScheduleRow
                      key={item.id}
                      state={state}
                      round={item.round}
                      controller={controller}
                      onAnnounce={onAnnounce}
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
                        if (controller.removeTimelineEvent(item.id))
                          onAnnounce(`${item.event?.title} removed.`);
                      }}
                      {...moveProps}
                    />
                  ) : null;
                })}
              </ol>
            )}
          </PanelBody>
        </section>
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
      </div>
    </>
  );
}

function RoundScheduleRow({
  state,
  round,
  controller,
  onAnnounce,
  position,
  total,
  onMoveUp,
  onMoveDown,
}: {
  state: DirectorState;
  round: DirectorState['rounds'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  position: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const timeZone = state.tournament?.timeZone ?? 'UTC';
  const [value, setValue] = useState(isoToZonedDateTimeInput(round.scheduledStart, timeZone));
  const [draftKey, setDraftKey] = useState(`${round.id}|${round.scheduledStart ?? ''}`);
  const [editingTime, setEditingTime] = useState(false);
  const currentKey = `${round.id}|${round.scheduledStart ?? ''}`;
  const displayedValue =
    draftKey === currentKey ? value : isoToZonedDateTimeInput(round.scheduledStart, timeZone);
  const gameCount = state.scheduledGames.filter((game) => game.roundId === round.id && !game.bye).length;
  const save = () => {
    const localValue = displayedValue;
    const iso = localValue ? zonedDateTimeInputToIso(localValue, timeZone) : null;
    if (localValue && !iso) {
      onAnnounce('That local time does not exist in the tournament timezone.');
      return;
    }
    if (controller.setRoundScheduledStart(round.id, iso)) onAnnounce(`${round.name} planned time updated.`);
  };
  const showTimeControl = round.scheduledStart || editingTime;
  return (
    <li className="director-schedule-item">
      <div className="director-schedule-marker" aria-hidden="true">
        R
      </div>
      <div className="director-schedule-item-main">
        <div className="director-schedule-item-heading">
          <div>
            <strong>{round.name}</strong>
            <small>
              {gameCount} competitive game{gameCount === 1 ? '' : 's'} · {round.status}
            </small>
          </div>
          <div className="director-row-actions">
            <StateLabel state={round.status} />
            <DayMoveButtons
              label={round.name}
              position={position}
              total={total}
              onMoveUp={onMoveUp}
              onMoveDown={onMoveDown}
            />
          </div>
        </div>
        <div className="director-schedule-round-controls">
          {showTimeControl ? (
            <FormField label={`Planned start for ${round.name}`}>
              <input
                type="datetime-local"
                value={displayedValue}
                disabled={round.status === 'released' || round.status === 'closed'}
                onChange={(event) => {
                  setDraftKey(currentKey);
                  setValue(event.target.value);
                }}
                onBlur={save}
              />
            </FormField>
          ) : (
            round.status !== 'released' &&
            round.status !== 'closed' && (
              <Button variant="quiet" onClick={() => setEditingTime(true)}>
                Set time
              </Button>
            )
          )}
          {round.releasedAt && <small>Released {formatTimestamp(round.releasedAt, timeZone)}</small>}
          {round.startedAt && <small>Started {formatTimestamp(round.startedAt, timeZone)}</small>}
        </div>
      </div>
    </li>
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
    <li className="director-schedule-item">
      <div className="director-schedule-marker" aria-hidden="true">
        {timelineEventTypeLabel(event.type).slice(0, 1)}
      </div>
      <div className="director-schedule-item-main">
        <div className="director-schedule-item-heading">
          <div>
            <strong>{event.title}</strong>
            <small>
              {timelineEventTypeLabel(event.type)} · {event.visibility}
              {location ? ` · ${location}` : ''}
            </small>
          </div>
          <div className="director-row-actions">
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
        </div>
        {event.description ? <p>{event.description}</p> : null}
        <small className="director-table-subtext">
          {[
            event.scheduledStart ? formatTimestamp(event.scheduledStart, timeZone) : null,
            event.scheduledStart && event.scheduledEnd
              ? `– ${formatTimestamp(event.scheduledEnd, timeZone)}`
              : null,
            event.teamIds?.length
              ? `${event.teamIds.length} targeted team${event.teamIds.length === 1 ? '' : 's'}`
              : 'All teams',
          ]
            .filter(Boolean)
            .join(' · ')}
        </small>
      </div>
    </li>
  );
}

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
    <section className="director-panel director-form-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">{event ? 'Edit event' : 'New event'}</p>
          <h2>Schedule details</h2>
        </div>
        <Button variant="quiet" icon="x" onClick={onClose}>
          Close
        </Button>
      </div>
      <PanelBody>
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
            <FormField label="Start ({timeZone})">
              <input
                type="datetime-local"
                value={start}
                onChange={(eventObject) => setStart(eventObject.target.value)}
              />
            </FormField>
            <FormField label="End ({timeZone})">
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
      </PanelBody>
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
