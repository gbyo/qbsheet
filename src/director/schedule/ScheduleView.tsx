import { useMemo, useState } from 'react';
import {
  availableTimeZones,
  isoToZonedDateTimeInput,
  timeZoneLabel,
  timelineEventTypeLabel,
  timelineEventTypes,
  zonedDateTimeInputToIso,
  type DirectorState,
  type TimelineEventType,
  type TimelineVisibility,
  type TournamentTimelineEvent,
} from '../domain';
import type { DirectorController, NewTimelineEventInput } from '../state/useDirectorController';
import { Button, FormField, PanelBody, StateLabel } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import { errorNotice, type AnnounceInput } from '../notices';

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
  const orderedItems = useMemo(
    () =>
      [
        ...state.rounds.map((round) => ({ kind: 'round' as const, value: round })),
        ...state.timeline.map((event) => ({ kind: 'event' as const, value: event })),
      ].sort(
        (left, right) =>
          compareOptionalTimestamp(left.value.scheduledStart, right.value.scheduledStart) ||
          (left.kind === 'round' && right.kind === 'round'
            ? left.value.number - right.value.number
            : left.value.id.localeCompare(right.value.id)),
      ),
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
        eyebrow="Plan"
        title="Schedule"
        description={`Tournament day in ${timeZoneLabel(tournament.timeZone)}. Planned times are stored as absolute instants and stay fixed when this file moves computers.`}
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              setEditingId(null);
              setShowForm(true);
            }}
          >
            Add event
          </Button>
        }
      />
      <div className="director-page-stack">
        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Tournament day</p>
              <h2>
                {orderedItems.length} scheduled item{orderedItems.length === 1 ? '' : 's'}
              </h2>
            </div>
            <StateLabel state="info" label={timeZoneLabel(tournament.timeZone)} />
          </div>
          <PanelBody>
            {orderedItems.length === 0 ? (
              <p className="director-empty-copy">No rounds or day events have been planned yet.</p>
            ) : (
              <ol className="director-schedule-timeline">
                {orderedItems.map((item) =>
                  item.kind === 'round' ? (
                    <RoundScheduleRow
                      key={item.value.id}
                      state={state}
                      round={item.value}
                      controller={controller}
                      onAnnounce={onAnnounce}
                    />
                  ) : (
                    <TimelineEventRow
                      key={item.value.id}
                      state={state}
                      event={item.value}
                      onEdit={() => {
                        setEditingId(item.value.id);
                        setShowForm(true);
                      }}
                      onDelete={() => {
                        if (!confirm(`Remove “${item.value.title}” from the schedule?`)) return;
                        if (controller.removeTimelineEvent(item.value.id))
                          onAnnounce(`${item.value.title} removed.`);
                      }}
                    />
                  ),
                )}
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
}: {
  state: DirectorState;
  round: DirectorState['rounds'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const timeZone = state.tournament?.timeZone ?? 'UTC';
  const [value, setValue] = useState(isoToZonedDateTimeInput(round.scheduledStart, timeZone));
  const [draftKey, setDraftKey] = useState(`${round.id}|${round.scheduledStart ?? ''}`);
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
          <StateLabel state={round.status} />
        </div>
        <div className="director-schedule-round-controls">
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
          {round.releasedAt && <small>Released {formatTimestamp(round.releasedAt, timeZone)}</small>}
          {round.startedAt && <small>Started {formatTimestamp(round.startedAt, timeZone)}</small>}
        </div>
      </div>
    </li>
  );
}

function TimelineEventRow({
  state,
  event,
  onEdit,
  onDelete,
}: {
  state: DirectorState;
  event: TournamentTimelineEvent;
  onEdit: () => void;
  onDelete: () => void;
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
            <Button variant="quiet" icon="edit" onClick={onEdit}>
              Edit
            </Button>
            <Button variant="quiet" icon="x" onClick={onDelete}>
              Remove
            </Button>
          </div>
        </div>
        <p>{event.description || 'No description.'}</p>
        <small className="director-table-subtext">
          {event.scheduledStart ? formatTimestamp(event.scheduledStart, timeZone) : 'Time not set'}
          {event.scheduledEnd ? ` – ${formatTimestamp(event.scheduledEnd, timeZone)}` : ''}
          {event.teamIds?.length
            ? ` · ${event.teamIds.length} targeted team${event.teamIds.length === 1 ? '' : 's'}`
            : ' · All teams'}
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

function compareOptionalTimestamp(left: string | null | undefined, right: string | null | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right);
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
