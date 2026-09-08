import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useEffect, useState } from 'react';
import { isValidTimeZone, timeZoneLabel, type DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import type { OperatorProfile } from '../operator/operatorProfile';
import {
  AdvancedSection,
  Button,
  Callout,
  DateField,
  Diagnostics,
  EmptyState,
  Field,
  FieldGrid,
  Page,
  PageHeader,
  Panel,
  Segmented,
  StateLabel,
  SummaryItem,
  SummaryList,
  TextInput,
  TimeZoneField,
  useConfirm,
} from '../components';
import { errorNotice, type AnnounceInput } from '../notices';

/** How many audit entries are rendered initially and on each Load more. */
export const auditPageSize = 100;

type SettingsSection = 'general' | 'recovery' | 'audit' | 'system';

export function SettingsView({
  state,
  controller,
  onAnnounce,
  operatorProfile,
  onSaveOperator,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  operatorProfile?: OperatorProfile;
  onSaveOperator?: (profile: OperatorProfile) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const targetSection = settingsSectionForTarget(navigationTarget);
  const [section, setSection] = useState<SettingsSection>(targetSection ?? 'general');
  useEffect(() => {
    if (!targetSection) return;
    setSection(targetSection);
    onClearNavigationTarget?.();
  }, [targetSection, onClearNavigationTarget]);

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Tournament and local operator settings, with recovery and system diagnostics separated from ordinary configuration."
      />

      {controller.error && (
        <Callout tone="danger" title="Saving needs attention">
          {controller.error} Recovery remains available below.
        </Callout>
      )}

      <Segmented<SettingsSection>
        value={section}
        onChange={setSection}
        ariaLabel="Settings section"
        options={[
          { value: 'general', label: 'General' },
          { value: 'recovery', label: `Recovery ${(controller.checkpoints ?? []).length}` },
          { value: 'audit', label: `Audit ${state.audit.length}` },
          { value: 'system', label: 'System' },
        ]}
      />

      {section === 'general' && (
        <GeneralSettings
          state={state}
          controller={controller}
          onAnnounce={onAnnounce}
          operatorProfile={operatorProfile}
          onSaveOperator={onSaveOperator}
        />
      )}
      {section === 'recovery' && (
        <RecoverySettings state={state} controller={controller} onAnnounce={onAnnounce} />
      )}
      {section === 'audit' && <AuditHistory state={state} />}
      {section === 'system' && <SystemDiagnostics state={state} controller={controller} />}
    </Page>
  );
}

function GeneralSettings({
  state,
  controller,
  onAnnounce,
  operatorProfile,
  onSaveOperator,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  operatorProfile?: OperatorProfile;
  onSaveOperator?: (profile: OperatorProfile) => void;
}) {
  const tournamentKey = [
    state.tournament?.id ?? '',
    state.tournament?.name ?? '',
    state.tournament?.date ?? '',
    state.tournament?.endDate ?? '',
    state.tournament?.venue ?? '',
    state.tournament?.organizer ?? '',
    state.tournament?.questionSet ?? '',
    state.tournament?.timeZone ?? 'UTC',
  ].join('|');
  const [tournamentDraft, setTournamentDraft] = useState({
    key: tournamentKey,
    name: state.tournament?.name ?? '',
    date: state.tournament?.date ?? '',
    endDate: state.tournament?.endDate ?? '',
    venue: state.tournament?.venue ?? '',
    organizer: state.tournament?.organizer ?? '',
    questionSet: state.tournament?.questionSet ?? '',
    timeZone: state.tournament?.timeZone ?? 'UTC',
  });
  const details =
    tournamentDraft.key === tournamentKey
      ? tournamentDraft
      : {
          key: tournamentKey,
          name: state.tournament?.name ?? '',
          date: state.tournament?.date ?? '',
          endDate: state.tournament?.endDate ?? '',
          venue: state.tournament?.venue ?? '',
          organizer: state.tournament?.organizer ?? '',
          questionSet: state.tournament?.questionSet ?? '',
          timeZone: state.tournament?.timeZone ?? 'UTC',
        };
  const updateDetails = (changes: Partial<Omit<typeof details, 'key'>>) =>
    setTournamentDraft({ ...details, ...changes, key: tournamentKey });

  const operatorKey = `${operatorProfile?.displayName ?? ''}|${operatorProfile?.role ?? ''}`;
  const [operatorDraft, setOperatorDraft] = useState({
    key: operatorKey,
    name: operatorProfile?.displayName ?? 'Local operator',
    role: operatorProfile?.role ?? '',
  });
  const operator =
    operatorDraft.key === operatorKey
      ? operatorDraft
      : {
          key: operatorKey,
          name: operatorProfile?.displayName ?? 'Local operator',
          role: operatorProfile?.role ?? '',
        };

  const saveTournament = () => {
    if (!details.name.trim()) {
      onAnnounce(errorNotice('Enter a tournament name first.'));
      return;
    }
    if (!isValidTimeZone(details.timeZone)) {
      onAnnounce(errorNotice('Choose a recognized IANA timezone.'));
      return;
    }
    const saved = controller.updateTournament({
      name: details.name,
      date: details.date,
      endDate: details.endDate,
      venue: details.venue,
      organizer: details.organizer,
      questionSet: details.questionSet,
      timeZone: details.timeZone,
    });
    onAnnounce(
      saved
        ? 'Tournament details updated locally; saving now.'
        : errorNotice('Tournament details were not updated; review the Director error.'),
    );
  };

  return (
    <div className="director-stack">
      <Panel
        title="Tournament details"
        description="This is the canonical tournament identity form used by every Settings/Tournament entry point."
        id="settings-tournament"
      >
        {state.tournament ? (
          <form
            className="director-stack"
            onSubmit={(event) => {
              event.preventDefault();
              saveTournament();
            }}
          >
            <FieldGrid>
              <Field label="Name">
                <TextInput
                  value={details.name}
                  onChange={(event) => updateDetails({ name: event.target.value })}
                />
              </Field>
              <Field label="Venue" optional>
                <TextInput
                  value={details.venue}
                  onChange={(event) => updateDetails({ venue: event.target.value })}
                />
              </Field>
              <Field
                label="Date"
                render={({ id, describedBy }) => (
                  <DateField
                    id={id}
                    aria-describedby={describedBy}
                    value={details.date}
                    onChange={(event) => updateDetails({ date: event.target.value })}
                  />
                )}
              />
              <Field
                label="End date"
                optional
                hint="For multi-day tournaments."
                render={({ id, describedBy }) => (
                  <DateField
                    id={id}
                    aria-describedby={describedBy}
                    value={details.endDate}
                    onChange={(event) => updateDetails({ endDate: event.target.value })}
                  />
                )}
              />
              <Field label="Organizer" optional>
                <TextInput
                  value={details.organizer}
                  onChange={(event) => updateDetails({ organizer: event.target.value })}
                />
              </Field>
              <Field label="Question set" optional>
                <TextInput
                  value={details.questionSet}
                  onChange={(event) => updateDetails({ questionSet: event.target.value })}
                  placeholder="e.g. ACF Fall 2025"
                />
              </Field>
              <Field
                label="Tournament timezone"
                spanAll
                hint={`${timeZoneLabel(details.timeZone)}. Future schedule inputs use this zone; stored instants are not shifted.`}
                render={({ id, describedBy, invalid }) => (
                  <TimeZoneField
                    id={id}
                    ariaDescribedBy={describedBy}
                    invalid={invalid}
                    value={details.timeZone}
                    onChange={(timeZone) => updateDetails({ timeZone })}
                  />
                )}
              />
            </FieldGrid>
            <div className="director-form-actions">
              <Button variant="primary" type="submit">
                Save tournament details
              </Button>
            </div>
          </form>
        ) : (
          <EmptyState
            title="No tournament open"
            description="Open or create a tournament before editing tournament details."
          />
        )}
      </Panel>

      <Panel
        title="Local operator"
        description="Used to attribute Director decisions. This is a local app setting, not authentication, and is not exported with tournament data."
        id="settings-operator"
        actions={<StateLabel state="info" label="Local app setting" />}
      >
        <FieldGrid>
          <Field label="Display name">
            <TextInput
              value={operator.name}
              onChange={(event) =>
                setOperatorDraft({ ...operator, key: operatorKey, name: event.target.value })
              }
            />
          </Field>
          <Field label="Role" optional>
            <TextInput
              value={operator.role}
              onChange={(event) =>
                setOperatorDraft({ ...operator, key: operatorKey, role: event.target.value })
              }
              placeholder="Tournament director"
            />
          </Field>
        </FieldGrid>
        <div className="director-form-actions">
          <Button
            variant="primary"
            disabled={!onSaveOperator || !operator.name.trim()}
            onClick={() => {
              onSaveOperator?.({
                displayName: operator.name.trim(),
                role: operator.role.trim() || undefined,
              });
              onAnnounce('Operator identity saved locally.');
            }}
          >
            Save operator
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function RecoverySettings({
  state,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const confirmAction = useConfirm();
  const checkpoints = controller.checkpoints ?? [];
  return (
    <Panel
      id="settings-recovery"
      title="Recovery"
      description="Recovery points preserve the tournament, including rounds, results, and transfer history. Restoring does not change operator settings or publishing credentials."
      actions={
        <Button
          variant="primary"
          icon="plus"
          disabled={!state.tournament || controller.recovering}
          onClick={() => {
            void controller
              .checkpoint('Manual recovery point')
              .then(() => onAnnounce('Recovery point created.'))
              .catch((reason: unknown) =>
                onAnnounce(
                  errorNotice(
                    reason instanceof Error ? reason.message : 'Recovery point could not be saved.',
                  ),
                ),
              );
          }}
        >
          Create recovery point
        </Button>
      }
      flush
    >
      {controller.repositoryKind === 'memory' && (
        <Callout tone="warning">
          This Director session is using memory-only storage. Recovery points disappear when the session ends.
        </Callout>
      )}
      {checkpoints.length === 0 ? (
        <div className="director-empty-in-panel">
          <p className="director-empty-copy">No recovery points yet.</p>
        </div>
      ) : (
        <SummaryList ariaLabel="Recovery points">
          {checkpoints.slice(0, 25).map((entry) => (
            <SummaryItem
              key={entry.id}
              title={<strong>{entry.reason}</strong>}
              summary={new Date(entry.createdAt).toLocaleString()}
              actions={
                <Button
                  variant="secondary"
                  icon="undo"
                  disabled={controller.recovering}
                  onClick={() =>
                    void (async () => {
                      const approved = await confirmAction({
                        title: `Restore the recovery point from ${new Date(entry.createdAt).toLocaleString()}?`,
                        body: 'Director creates a recovery point of the current state first.',
                        consequence:
                          'The open tournament will be replaced by the selected recovery point. Operator settings and credentials stay unchanged.',
                        confirmLabel: 'Restore tournament',
                        tone: 'danger',
                      });
                      if (!approved) return;
                      const restored = await controller.restoreCheckpoint(entry.id);
                      onAnnounce(
                        restored
                          ? 'Tournament restored. The previous state is also available in Recovery.'
                          : errorNotice('The tournament could not be restored; review the Director error.'),
                      );
                    })()
                  }
                >
                  Restore…
                </Button>
              }
            />
          ))}
        </SummaryList>
      )}
    </Panel>
  );
}

function AuditHistory({ state }: { state: DirectorState }) {
  const [auditShown, setAuditShown] = useState(auditPageSize);
  const visibleAudit = state.audit.slice(Math.max(0, state.audit.length - auditShown)).reverse();
  if (state.audit.length === 0) {
    return (
      <EmptyState
        title="No audit history yet"
        description="Meaningful tournament and Director decisions will be retained here."
      />
    );
  }
  return (
    <Panel
      id="settings-audit"
      title="Audit history"
      description={`${visibleAudit.length === state.audit.length ? state.audit.length : `${visibleAudit.length} of ${state.audit.length}`} meaningful change${state.audit.length === 1 ? '' : 's'}, newest first.`}
      flush
    >
      <SummaryList ariaLabel="Audit history">
        {visibleAudit.map((event) => (
          <SummaryItem
            key={event.id}
            title={<strong>{event.summary}</strong>}
            summary={`${new Date(event.at).toLocaleString()} · ${event.actor}`}
          >
            {event.entityId && (
              <Diagnostics
                label="Audit record details"
                standalone={false}
                items={[{ term: 'Entity ID', value: event.entityId, mono: true }]}
              />
            )}
          </SummaryItem>
        ))}
      </SummaryList>
      {visibleAudit.length < state.audit.length && (
        <div className="director-panel-footer">
          <Button variant="secondary" onClick={() => setAuditShown((shown) => shown + auditPageSize)}>
            Load more
          </Button>
          <span className="director-text-meta">
            {state.audit.length - visibleAudit.length} earlier event
            {state.audit.length - visibleAudit.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </Panel>
  );
}

function SystemDiagnostics({ state, controller }: { state: DirectorState; controller: DirectorController }) {
  const storageLabel =
    controller.repositoryKind === 'tauri-sqlite'
      ? 'Desktop local storage'
      : controller.repositoryKind === 'indexeddb'
        ? 'Browser local storage'
        : 'Memory-only session';
  return (
    <div className="director-stack">
      <Panel
        title="System status"
        description="Implementation details live here so ordinary tournament settings do not have to explain storage engines or schema versions."
        actions={
          <StateLabel
            state={controller.error ? 'help' : controller.saving ? 'pending' : 'finished'}
            label={controller.error ? 'Needs attention' : controller.saving ? 'Saving' : 'Healthy'}
          />
        }
      >
        <p className="director-text-secondary">
          {state.metadata.lastSavedAt
            ? `Last saved ${new Date(state.metadata.lastSavedAt).toLocaleString()}.`
            : 'This tournament has not been saved yet.'}
        </p>
        {controller.error && <Callout tone="danger">{controller.error}</Callout>}
      </Panel>
      <Diagnostics
        label="Storage & build diagnostics"
        hint="Useful for support and troubleshooting; not part of normal tournament configuration."
        defaultOpen
        items={[
          { term: 'Storage mode', value: storageLabel },
          { term: 'Storage implementation', value: controller.repositoryKind, mono: true },
          { term: 'Director schema', value: state.schemaVersion, mono: true },
          {
            term: 'Last saved',
            value: state.metadata.lastSavedAt
              ? new Date(state.metadata.lastSavedAt).toLocaleString()
              : 'Never',
          },
          { term: 'Audit events', value: state.audit.length },
        ]}
      />
      <AdvancedSection
        label="Local network boundaries"
        hint="QBTCP room control and QBSheet Live use separate listeners and credentials."
        icon="network"
      >
        <p>
          Start and inspect QBTCP from Rooms & staff and QBSheet Live from its own destination. Public
          spectator URLs never contain management credentials.
        </p>
      </AdvancedSection>
    </div>
  );
}

function settingsSectionForTarget(
  target: DirectorNavigationTarget | null | undefined,
): SettingsSection | null {
  if (!target || target.section !== 'settings' || target.entityType !== 'setting') return null;
  if (target.entityId === 'recovery') return 'recovery';
  if (target.entityId === 'audit') return 'audit';
  if (target.entityId === 'system' || target.entityId === 'storage') return 'system';
  if (target.entityId === 'tournament' || target.entityId === 'operator') return 'general';
  return null;
}
