/**
 * The Operations surface: rooms, staff, equipment and duties as views of one resource graph.
 *
 * Everything rendered here is read from `deriveRoundOperations` and its siblings. No component in
 * this file recomputes readiness, occupancy, or conflicts — that is the whole point of the domain
 * layer, and a second implementation here would put the UI back into disagreement with preflight.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  currentOperationsRound,
  deriveRoundOperations,
  dutyKindLabel,
  nextOperationsRound,
  operationalMatchupLabel,
  operationalReadinessLabel,
  operationalRoundOrder,
  planRoundOperations,
  resourceUnavailabilityImpact,
  roundIsAutoRepairable,
  type DirectorId,
  type DirectorState,
  type OperationalEquipmentView,
  type OperationalIssue,
  type OperationalRoomView,
  type OperationalStaffView,
  type OperationalTarget,
  type ResourceImpact,
  type RoundOperations,
  type StaffRole,
} from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import {
  ActionMenu,
  Badge,
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogSection,
  EmptyState,
  Field,
  FieldGrid,
  MenuItem,
  MultiSelect,
  Panel,
  Segmented,
  Select,
  StateLabel,
  SummaryItem,
  type SelectOption,
} from '../components';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { navigationTargetForOperational } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { errorNotice, type AnnounceInput } from '../notices';

export type OperationsScope = 'current' | 'next' | 'all';

export interface OperationsContext {
  scope: OperationsScope;
  /** The round the scope resolves to, or null for `all` and for a tournament with no rounds. */
  roundId: DirectorId | null;
  roundName: string | null;
  operations: RoundOperations;
  /** Whether the resolved round may be filled or repaired automatically. */
  repairable: boolean;
}

/**
 * Resolve the scope control to a round and its derived operations.
 *
 * `all` deliberately still derives against the current round rather than aggregating every round:
 * the rows show each resource's whole day (`current` and `next` on every row), so aggregation
 * would duplicate what the rows already say while losing the "which round am I looking at" anchor.
 */
export function useOperationsContext(state: DirectorState, scope: OperationsScope): OperationsContext {
  return useMemo(() => {
    const current = currentOperationsRound(state);
    const next = nextOperationsRound(state);
    const round = scope === 'next' ? next : current;
    const operations = deriveRoundOperations(state, scope === 'all' ? undefined : round?.id);
    return {
      scope,
      roundId: scope === 'all' ? null : (round?.id ?? null),
      roundName: round?.name ?? null,
      operations,
      repairable: round ? roundIsAutoRepairable(state, round.id) : false,
    };
  }, [state, scope]);
}

export function OperationsScopeControl({
  state,
  scope,
  onChange,
}: {
  state: DirectorState;
  scope: OperationsScope;
  onChange: (scope: OperationsScope) => void;
}) {
  const current = currentOperationsRound(state);
  const next = nextOperationsRound(state);
  if (!current) return null;
  return (
    <Segmented<OperationsScope>
      value={scope}
      onChange={onChange}
      ariaLabel="Round scope"
      options={[
        { value: 'current', label: current.name },
        ...(next ? [{ value: 'next' as const, label: `Next · ${next.name}` }] : []),
        { value: 'all', label: 'All' },
      ]}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                 */
/* -------------------------------------------------------------------------- */

function IssueList({
  issues,
  onNavigate,
}: {
  issues: readonly OperationalIssue[];
  onNavigate?: (target: DirectorNavigationTarget) => void;
}) {
  if (issues.length === 0) return null;
  return (
    <ul className="director-issue-list">
      {issues.map((issue) => (
        <li key={issue.id} data-severity={issue.severity}>
          <span>{issue.message}</span>
          {issue.action && issue.target && onNavigate && (
            <Button
              variant="quiet"
              onClick={() => onNavigate(navigationTargetForOperational(issue.target as OperationalTarget))}
            >
              {issue.action}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function staffOptions(
  state: DirectorState,
  role: StaffRole,
  selected: DirectorId | null,
): SelectOption<string>[] {
  return [
    { value: '', label: 'Unassigned' },
    ...state.staff
      .filter((member) => member.roles.includes(role) && (member.available || member.id === selected))
      .map((member) => ({
        value: member.id,
        label: member.name,
        detail: member.available ? undefined : 'Unavailable',
      })),
  ];
}

/* -------------------------------------------------------------------------- */
/* Round summary                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The readiness sentence for one round.
 *
 * Overview shows the same numbers from the same derivation. There is exactly one readiness
 * algorithm, and this is a rendering of it.
 */
export function RoundReadinessSummary({
  operations,
  roundName,
  compact = false,
}: {
  operations: RoundOperations;
  roundName: string | null;
  compact?: boolean;
}) {
  const { summary } = operations;
  const parts = [
    `${summary.games} game${summary.games === 1 ? '' : 's'}`,
    `${summary.gamesWithRooms}/${summary.games} rooms assigned`,
    `${summary.staffPositionsFilled}/${summary.staffPositionsRequired} staff positions filled`,
  ];
  if (summary.scorekeepersExpected > 0) {
    parts.push(`${summary.scorekeepersConnected}/${summary.scorekeepersExpected} scorekeepers connected`);
  }
  if (summary.runners > 0) parts.push(`${summary.runners} runner${summary.runners === 1 ? '' : 's'}`);
  if (summary.hq > 0) parts.push(`${summary.hq} HQ`);
  const issues = operations.blockers.length + operations.warnings.length;
  return (
    <div className="director-meta-row" data-compact={compact ? '' : undefined}>
      {roundName && <strong>{roundName}</strong>}
      <span>{parts.join(' · ')}</span>
      <Badge
        state={issues === 0 ? 'ready' : operations.blockers.length > 0 ? 'blocker' : 'warning'}
        label={issues === 0 ? 'No issues' : `${issues} issue${issues === 1 ? '' : 's'}`}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Rooms                                                                       */
/* -------------------------------------------------------------------------- */

export function OperationalRoomSummary({
  state,
  view,
  context,
  controller,
  onAnnounce,
  onNavigate,
  onEditRoom,
  onEditAssignment,
  onPair,
  navigationTarget,
  onClearNavigationTarget,
  extra,
}: {
  state: DirectorState;
  view: OperationalRoomView;
  context: OperationsContext;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onNavigate?: (target: DirectorNavigationTarget) => void;
  onEditRoom: () => void;
  onEditAssignment: (scheduledGameId: DirectorId) => void;
  onPair?: () => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
  extra?: ReactNode;
}) {
  const { room } = view;
  const highlighted = useNavigationHighlight(
    navigationTarget,
    'rooms',
    'room',
    room.id,
    onClearNavigationTarget,
  );
  const location = [room.building, room.floor].filter(Boolean).join(' · ');
  const matchup = operationalMatchupLabel(state, view.game);
  const nextMatchup = operationalMatchupLabel(state, view.nextGame);
  const assignment = view.assignment;

  const connection = view.qbtcpSession
    ? `${view.qbtcpStaff?.name ?? view.qbtcpSession.operatorName ?? view.qbtcpSession.deviceId} · ${
        view.qbtcpSession.state === 'abandoned' ? 'Disconnected' : 'Connected'
      }`
    : assignment?.scorekeeperId
      ? 'Scorer not connected'
      : null;

  return (
    <SummaryItem
      className={highlighted ? 'is-navigation-target' : ''}
      selected={Boolean(view.helpRequest)}
      title={
        <strong data-director-navigation-id={room.id} data-director-navigation-focus tabIndex={-1}>
          {room.name}
        </strong>
      }
      status={<StateLabel state={view.readiness} label={operationalReadinessLabel(view.readiness)} />}
      summary={
        <>
          <span>{location || 'No location details'}</span>
          {matchup && view.round && (
            <span>
              {' · '}
              {matchup} · {view.round.name}
            </span>
          )}
          {!matchup && <span> · No game {context.roundName ? `in ${context.roundName}` : 'assigned'}</span>}
          {view.moderator && <span> · {view.moderator.name} · Moderator</span>}
          {view.scorekeeper && <span> · {view.scorekeeper.name} · Scorekeeper</span>}
          {view.equipment.length > 0 && <span> · {view.equipment.map((item) => item.name).join(', ')}</span>}
          {connection && <span> · {connection}</span>}
          {nextMatchup && view.nextRound && (
            <span>
              {' · Next: '}
              {nextMatchup} · {view.nextRound.name}
            </span>
          )}
        </>
      }
      actions={
        <div className="director-actions">
          {view.game && (
            <Button variant="secondary" icon="edit" onClick={() => onEditAssignment(view.game!.id)}>
              Assignment
            </Button>
          )}
          <ActionMenu label={`${room.name} actions`} triggerLabel={`${room.name} actions`}>
            {(close) => (
              <>
                <MenuItem icon="edit" onSelect={() => (close(), onEditRoom())}>
                  Edit room details
                </MenuItem>
                {onPair && (
                  <MenuItem icon="network" onSelect={() => (close(), onPair())}>
                    Send pairing invitation
                  </MenuItem>
                )}
                <MenuItem
                  icon={room.available ? 'pause' : 'play'}
                  onSelect={() => {
                    close();
                    if (controller.updateRoom(room.id, { available: !room.available })) {
                      onAnnounce(
                        `${room.name} marked ${room.available ? 'unavailable' : 'available'} for future assignment.`,
                      );
                    } else {
                      onAnnounce(errorNotice(`${room.name} was not changed; review the Director error.`));
                    }
                  }}
                >
                  {room.available ? 'Mark unavailable' : 'Mark available'}
                </MenuItem>
              </>
            )}
          </ActionMenu>
        </div>
      }
    >
      <IssueList issues={[...view.blockers, ...view.warnings]} onNavigate={onNavigate} />
      {extra}
    </SummaryItem>
  );
}

/* -------------------------------------------------------------------------- */
/* Staff                                                                       */
/* -------------------------------------------------------------------------- */

function dutyText(duty: OperationalStaffView['current']): string | null {
  if (!duty) return null;
  const where = duty.roomName ?? dutyKindLabel(duty.kind);
  return duty.matchup ? `${where} · ${duty.matchup}` : where;
}

export function OperationalStaffSummary({
  view,
  controller,
  onAnnounce,
  onNavigate,
  onEdit,
  onMarkUnavailable,
  navigationTarget,
  onClearNavigationTarget,
}: {
  view: OperationalStaffView;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onNavigate?: (target: DirectorNavigationTarget) => void;
  onEdit: () => void;
  onMarkUnavailable: () => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const { staff } = view;
  const highlighted = useNavigationHighlight(
    navigationTarget,
    'rooms',
    'staff',
    staff.id,
    onClearNavigationTarget,
  );
  const now = dutyText(view.current);
  const next = dutyText(view.next);
  return (
    <SummaryItem
      className={highlighted ? 'is-navigation-target' : ''}
      title={
        <strong data-director-navigation-id={staff.id} data-director-navigation-focus tabIndex={-1}>
          {staff.name}
        </strong>
      }
      status={
        <StateLabel
          state={view.blockers.length > 0 ? 'blocked' : staff.available ? 'available' : 'offline'}
          label={
            view.blockers.length > 0 ? 'Needs a decision' : staff.available ? 'Available' : 'Unavailable'
          }
        />
      }
      summary={
        <>
          <span>{staff.roles.map(roleLabel).join(' · ')}</span>
          <span> · Now: {now ?? 'Unassigned'}</span>
          <span> · Next: {next ?? 'Unassigned'}</span>
          {view.qbtcpSession && (
            <span>
              {' · '}
              {view.qbtcpSession.deviceId} ·{' '}
              {view.qbtcpSession.state === 'abandoned' ? 'Disconnected' : 'Connected'}
            </span>
          )}
        </>
      }
      actions={
        <div className="director-actions">
          {view.current?.roomId && onNavigate && (
            <Button
              variant="quiet"
              onClick={() =>
                onNavigate(
                  navigationTargetForOperational({ entityType: 'room', entityId: view.current!.roomId! }),
                )
              }
            >
              Open room
            </Button>
          )}
          <Button variant="secondary" icon="edit" onClick={onEdit}>
            Edit
          </Button>
          <ActionMenu label={`${staff.name} actions`} triggerLabel={`${staff.name} actions`}>
            {(close) => (
              <MenuItem
                icon={staff.available ? 'pause' : 'play'}
                onSelect={() => {
                  close();
                  if (staff.available) {
                    onMarkUnavailable();
                    return;
                  }
                  if (controller.updateStaff(staff.id, { available: true })) {
                    onAnnounce(`${staff.name} marked available for future assignment.`);
                  } else {
                    onAnnounce(errorNotice(`${staff.name} was not changed; review the Director error.`));
                  }
                }}
              >
                {staff.available ? 'Mark unavailable' : 'Mark available'}
              </MenuItem>
            )}
          </ActionMenu>
        </div>
      }
    >
      <IssueList issues={[...view.blockers, ...view.warnings]} onNavigate={onNavigate} />
    </SummaryItem>
  );
}

/** The one set of names for staff roles, shared by the roster editor and every operational row. */
export const staffRoleOptions: Array<{ value: StaffRole; label: string }> = [
  { value: 'moderator', label: 'Moderator' },
  { value: 'scorekeeper', label: 'Scorekeeper' },
  { value: 'runner', label: 'Runner' },
  { value: 'hq', label: 'HQ staff' },
];

export function roleLabel(role: StaffRole): string {
  return staffRoleOptions.find((option) => option.value === role)?.label ?? role;
}

/* -------------------------------------------------------------------------- */
/* Equipment                                                                   */
/* -------------------------------------------------------------------------- */

export function OperationalEquipmentSummary({
  view,
  controller,
  onAnnounce,
  onNavigate,
  onEdit,
  onMarkUnavailable,
  navigationTarget,
  onClearNavigationTarget,
}: {
  view: OperationalEquipmentView;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onNavigate?: (target: DirectorNavigationTarget) => void;
  onEdit: () => void;
  onMarkUnavailable: () => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const { equipment } = view;
  const highlighted = useNavigationHighlight(
    navigationTarget,
    'rooms',
    'equipment',
    equipment.id,
    onClearNavigationTarget,
  );
  return (
    <SummaryItem
      className={highlighted ? 'is-navigation-target' : ''}
      title={
        <strong data-director-navigation-id={equipment.id} data-director-navigation-focus tabIndex={-1}>
          {equipment.name}
        </strong>
      }
      status={
        <StateLabel
          state={view.blockers.length > 0 ? 'blocked' : equipment.available ? 'available' : 'offline'}
          label={
            view.blockers.length > 0 ? 'Needs a decision' : equipment.available ? 'Available' : 'Unavailable'
          }
        />
      }
      summary={
        <>
          <span>{equipmentKindLabel(equipment.kind)}</span>
          <span> · Now: {view.current?.roomName ?? 'Not in use'}</span>
          <span> · Next: {view.next?.roomName ?? 'Not scheduled'}</span>
          {view.uses.length > 1 && <span> · {view.uses.length} scheduled uses</span>}
        </>
      }
      actions={
        <div className="director-actions">
          <Button variant="secondary" icon="edit" onClick={onEdit}>
            Edit
          </Button>
          <ActionMenu label={`${equipment.name} actions`} triggerLabel={`${equipment.name} actions`}>
            {(close) => (
              <MenuItem
                icon={equipment.available ? 'pause' : 'play'}
                onSelect={() => {
                  close();
                  if (equipment.available) {
                    onMarkUnavailable();
                    return;
                  }
                  if (controller.updateEquipment(equipment.id, { available: true })) {
                    onAnnounce(`${equipment.name} marked available for future assignment.`);
                  } else {
                    onAnnounce(errorNotice(`${equipment.name} was not changed; review the Director error.`));
                  }
                }}
              >
                {equipment.available ? 'Mark unavailable' : 'Mark available'}
              </MenuItem>
            )}
          </ActionMenu>
        </div>
      }
    >
      <IssueList issues={view.blockers} onNavigate={onNavigate} />
    </SummaryItem>
  );
}

export function equipmentKindLabel(kind: DirectorState['equipment'][number]['kind']): string {
  return kind === 'buzzer' ? 'Buzzer' : kind === 'device' ? 'Laptop / tablet' : 'Other';
}

/* -------------------------------------------------------------------------- */
/* Duties                                                                      */
/* -------------------------------------------------------------------------- */

/** Runner and HQ duty for a round, assigned without pretending they are room slots. */
export function DutyPanel({
  state,
  controller,
  context,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  context: OperationsContext;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const roundId = context.roundId;
  if (!roundId) return null;
  const kinds = [
    { kind: 'runner' as const, role: 'runner' as StaffRole, label: 'Runners' },
    { kind: 'hq' as const, role: 'hq' as StaffRole, label: 'HQ' },
  ];
  const eligible = (role: StaffRole) => state.staff.filter((member) => member.roles.includes(role));
  if (kinds.every(({ role }) => eligible(role).length === 0)) return null;

  return (
    <Panel
      title="Duties"
      description={`Runner and HQ duty for ${context.roundName ?? 'this round'}. These are round-scoped, not room slots.`}
    >
      <FieldGrid>
        {kinds.map(({ kind, role, label }) => {
          const assigned =
            state.operationalAssignments.find((entry) => entry.roundId === roundId && entry.kind === kind)
              ?.staffIds ?? [];
          // Like the room selectors: unavailable staff are only shown when already
          // assigned, never offered as fresh candidates the controller must refuse.
          const options = eligible(role).filter((member) => member.available || assigned.includes(member.id));
          if (options.length === 0) return null;
          return (
            <Field key={kind} label={label} optional>
              <MultiSelect
                values={assigned}
                ariaLabel={`${label} for ${context.roundName ?? 'this round'}`}
                allLabel="Nobody assigned"
                options={options.map((member) => ({
                  value: member.id,
                  label: member.name,
                  detail: member.available ? undefined : 'Unavailable',
                }))}
                onChange={(values) => {
                  if (controller.setRoundDuty(roundId, kind, values)) {
                    onAnnounce(
                      values.length === 0
                        ? `${label} cleared for ${context.roundName ?? 'this round'}.`
                        : `${values.length} staff on ${label.toLocaleLowerCase()} duty for ${context.roundName ?? 'this round'}.`,
                    );
                  } else {
                    onAnnounce(errorNotice('That duty could not be set; review the Director error.'));
                  }
                }}
              />
            </Field>
          );
        })}
      </FieldGrid>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Prepare operations                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Auto-fill and repair for the round in scope.
 *
 * Deliberately absent for a released or closed round: the planner refuses those, and offering a
 * button that always fails is worse than not offering one.
 */
export function PrepareOperationsPanel({
  state,
  controller,
  context,
  onAnnounce,
  onNavigate,
}: {
  state: DirectorState;
  controller: DirectorController;
  context: OperationsContext;
  onAnnounce: (announcement: AnnounceInput) => void;
  onNavigate?: (target: DirectorNavigationTarget) => void;
}) {
  const roundId = context.roundId;
  const plan = useMemo(
    () => (roundId && context.repairable ? planRoundOperations(state, roundId) : null),
    [state, roundId, context.repairable],
  );
  if (!roundId || !context.repairable || !plan?.planned) {
    if (!roundId || context.repairable) return null;
    return (
      <Callout tone="info" title={`${context.roundName ?? 'This round'} is already under way`}>
        Released and closed rounds are changed through the explicit recovery actions on Tournament day, so a
        moved game cannot split scorer state.
      </Callout>
    );
  }
  const run = (fillOnly: boolean) => {
    if (controller.prepareRoundOperations(roundId, fillOnly ? { fillOnly: true } : {})) {
      onAnnounce(
        plan.changeCount === 0
          ? `${context.roundName ?? 'This round'} is already fully assigned.`
          : `Prepared ${context.roundName ?? 'this round'}: ${plan.changeCount} assignment(s) filled.`,
      );
    } else {
      onAnnounce(errorNotice('Operations could not be prepared; review the Director error.'));
    }
  };
  const repair = () => {
    if (controller.repairOperations(roundId)) {
      onAnnounce('Repaired operations for every planned and prepared round from here on.');
    } else {
      onAnnounce(errorNotice('Operations could not be repaired; review the Director error.'));
    }
  };

  return (
    <Panel
      title="Prepare operations"
      description={
        plan.changeCount === 0
          ? `${context.roundName ?? 'This round'} is fully assigned.`
          : `${plan.changeCount} assignment(s) can be filled automatically for ${context.roundName ?? 'this round'}.`
      }
      actions={
        <div className="director-actions">
          <Button variant="secondary" onClick={() => run(true)} disabled={plan.changeCount === 0}>
            Fill empty assignments
          </Button>
          <Button variant="primary" onClick={() => run(false)} disabled={plan.changeCount === 0}>
            Prepare operations
          </Button>
          <Button variant="quiet" onClick={repair}>
            Repair conflicts
          </Button>
        </div>
      }
    >
      {plan.unresolved.length > 0 && (
        <Callout tone="warning" title={`${plan.unresolved.length} decision(s) need you`}>
          <ul className="director-issue-list">
            {plan.unresolved.map((decision) => (
              <li key={decision.id} data-severity="warning">
                <span>{decision.message}</span>
                {decision.target && onNavigate && (
                  <Button
                    variant="quiet"
                    onClick={() => onNavigate(navigationTargetForOperational(decision.target!))}
                  >
                    {decision.action}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Callout>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Assignment editor                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Edit one game's room, staff, and equipment, with pins.
 *
 * A choice made here is a director's decision and is pinned by the controller. The pin checkboxes
 * exist so a value that auto-fill *happened* to get right can also be frozen without retyping it.
 */
export function AssignmentDialog({
  state,
  controller,
  scheduledGameId,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  controller: DirectorController;
  scheduledGameId: DirectorId;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const game = state.scheduledGames.find((entry) => entry.id === scheduledGameId);
  const round = game ? state.rounds.find((entry) => entry.id === game.roundId) : undefined;
  const stored = state.operationalAssignments.find(
    (entry) => entry.kind === 'room' && entry.scheduledGameId === scheduledGameId,
  );
  const room = game?.roomId ? state.rooms.find((entry) => entry.id === game.roomId) : undefined;
  const [draft, setDraft] = useState(() => ({
    roomId: game?.roomId ?? '',
    moderatorId: stored?.moderatorId ?? room?.moderatorId ?? '',
    scorekeeperId: stored?.scorekeeperId ?? room?.scorekeeperId ?? '',
    equipmentIds: stored?.equipmentIds ?? (room ? (room.defaultEquipmentIds ?? []) : []),
  }));

  if (!game || !round) {
    return (
      <Dialog title="Assignment" onClose={onClose} submitLabel="Close" onSubmit={onClose}>
        <Callout tone="warning">That game is no longer in the tournament workspace.</Callout>
      </Dialog>
    );
  }

  const usedRoomIds = new Set(
    state.scheduledGames
      .filter(
        (entry) =>
          entry.roundId === game.roundId &&
          entry.id !== game.id &&
          !entry.bye &&
          entry.status !== 'cancelled' &&
          entry.roomId,
      )
      .map((entry) => entry.roomId as DirectorId),
  );
  const roomChoices: SelectOption<string>[] = [
    { value: '', label: 'No room' },
    ...state.rooms
      .filter((entry) => entry.available || entry.id === game.roomId)
      .map((entry) => ({
        value: entry.id,
        label: entry.name,
        detail: usedRoomIds.has(entry.id) ? 'Already hosting a game this round' : undefined,
        disabled: usedRoomIds.has(entry.id) && entry.id !== game.roomId,
      })),
  ];

  const save = () => {
    const changes = {
      roomId: draft.roomId || null,
      moderatorId: draft.moderatorId || null,
      scorekeeperId: draft.scorekeeperId || null,
      equipmentIds: draft.equipmentIds,
    };
    if (!controller.setGameAssignment(scheduledGameId, changes)) {
      onAnnounce(errorNotice('That assignment could not be saved; review the Director error.'));
      return;
    }
    onAnnounce(`Assignment saved for ${operationalMatchupLabel(state, game) ?? round.name}.`);
    onClose();
  };

  return (
    <Dialog
      title={`${operationalMatchupLabel(state, game) ?? 'Assignment'} · ${round.name}`}
      onClose={onClose}
      onSubmit={save}
      submitLabel="Save assignment"
    >
      <DialogSection
        title="Where and who"
        description="An explicit choice here is pinned: auto-fill and repair will not move it."
      >
        <FieldGrid>
          <Field label="Room">
            <Select
              value={draft.roomId}
              options={roomChoices}
              ariaLabel="Room"
              onChange={(value) => setDraft((current) => ({ ...current, roomId: value }))}
            />
          </Field>
          <Field label="Moderator" optional>
            <Select
              value={draft.moderatorId}
              options={staffOptions(state, 'moderator', draft.moderatorId || null)}
              ariaLabel="Moderator"
              onChange={(value) => setDraft((current) => ({ ...current, moderatorId: value }))}
            />
          </Field>
          <Field label="Scorekeeper" optional>
            <Select
              value={draft.scorekeeperId}
              options={staffOptions(state, 'scorekeeper', draft.scorekeeperId || null)}
              ariaLabel="Scorekeeper"
              onChange={(value) => setDraft((current) => ({ ...current, scorekeeperId: value }))}
            />
          </Field>
          <Field label="Equipment" optional>
            <MultiSelect
              values={draft.equipmentIds}
              ariaLabel="Equipment"
              allLabel="No equipment"
              options={state.equipment
                .filter((item) => item.available || draft.equipmentIds.includes(item.id))
                .map((item) => ({
                  value: item.id,
                  label: item.name,
                  detail: item.available ? undefined : 'Unavailable',
                }))}
              onChange={(values) => setDraft((current) => ({ ...current, equipmentIds: values }))}
            />
          </Field>
        </FieldGrid>
      </DialogSection>
      {stored && (
        <DialogSection
          title="Pinned choices"
          description="Pinned values survive auto-fill and repair. If a pin becomes impossible, Director asks you rather than replacing it."
        >
          {(['room', 'moderator', 'scorekeeper', 'equipment'] as const).map((slot) => (
            <Checkbox
              key={slot}
              label={`Keep ${slot === 'equipment' ? 'equipment' : `this ${slot}`}`}
              checked={
                slot === 'equipment'
                  ? (stored.pinned?.equipmentIds?.length ?? 0) > 0
                  : stored.pinned?.[slot] === true
              }
              onChange={(pinned) => {
                if (!controller.setAssignmentPin(scheduledGameId, slot, pinned)) {
                  onAnnounce(errorNotice('That pin could not be changed; review the Director error.'));
                }
              }}
            />
          ))}
        </DialogSection>
      )}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Resource impact                                                             */
/* -------------------------------------------------------------------------- */

export interface PendingUnavailability {
  kind: 'staff' | 'room' | 'equipment';
  id: DirectorId;
}

/**
 * What breaks before it breaks.
 *
 * The three actions are the whole point: repair the future automatically, accept the damage
 * knowingly, or back out. Silently committing and letting preflight complain later is what this
 * replaces.
 */
export function ResourceImpactDialog({
  state,
  controller,
  pending,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  controller: DirectorController;
  pending: PendingUnavailability;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const impact: ResourceImpact = useMemo(
    () => resourceUnavailabilityImpact(state, pending.kind, pending.id),
    [state, pending],
  );
  const rounds = operationalRoundOrder(state);
  const roundName = (roundId: DirectorId) => rounds.find((round) => round.id === roundId)?.name ?? roundId;

  const markUnavailable = (): boolean => {
    const ok =
      pending.kind === 'staff'
        ? controller.updateStaff(pending.id, { available: false })
        : pending.kind === 'room'
          ? controller.updateRoom(pending.id, { available: false })
          : controller.updateEquipment(pending.id, { available: false });
    if (!ok) {
      onAnnounce(errorNotice(`${impact.resourceName} was not changed; review the Director error.`));
    }
    return ok;
  };

  const keep = () => {
    if (markUnavailable()) {
      onAnnounce(`${impact.resourceName} marked unavailable. Existing assignments were kept.`);
      onClose();
    }
  };

  const replace = () => {
    if (!markUnavailable()) return;
    if (controller.repairOperations()) {
      onAnnounce(
        `${impact.resourceName} marked unavailable and ${impact.repairable.length} future assignment(s) reassigned.`,
      );
    } else {
      onAnnounce(errorNotice(`${impact.resourceName} was marked unavailable, but the repair did not run.`));
    }
    onClose();
  };

  if (impact.affected.length === 0) {
    return (
      <Dialog
        title={`Mark ${impact.resourceName} unavailable?`}
        onClose={onClose}
        onSubmit={keep}
        submitLabel="Mark unavailable"
      >
        <p>Nothing in the remaining schedule depends on {impact.resourceName}.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Mark ${impact.resourceName} unavailable?`}
      onClose={onClose}
      onSubmit={impact.repairable.length > 0 ? replace : keep}
      submitLabel={impact.repairable.length > 0 ? 'Find replacements' : 'Mark unavailable'}
      dangerAction={
        impact.repairable.length > 0 ? (
          <Button variant="secondary" onClick={keep}>
            Keep assignments anyway
          </Button>
        ) : undefined
      }
    >
      <Callout tone="warning" title={`${impact.resourceName} has ${impact.affected.length} assignment(s)`}>
        <ul className="director-issue-list">
          {impact.affected.map((entry) => (
            <li key={`${entry.roundId}-${entry.scheduledGameId}-${entry.slot}`} data-severity="warning">
              <span>
                {roundName(entry.roundId)} · {entry.roomName ?? entry.matchup ?? 'Duty'} · {entry.slot}
                {entry.locked ? ' · already under way' : ''}
              </span>
            </li>
          ))}
        </ul>
      </Callout>
      {impact.lockedRoundIds.length > 0 && (
        <p>
          {impact.lockedRoundIds.length} round(s) are already released or in progress. Those assignments are
          left alone — change them with the recovery actions on Tournament day.
        </p>
      )}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                 */
/* -------------------------------------------------------------------------- */

export function OperationsEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      title="No rooms yet"
      description="Add the rooms that can host games. Staff and equipment are optional until you need them."
    >
      <Button variant="primary" icon="plus" onClick={onAdd}>
        Add first room
      </Button>
    </EmptyState>
  );
}
