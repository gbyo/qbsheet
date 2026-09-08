/** QBSheet Live: optional public publishing, expressed in the same Director grammar as the rest of the app. */
import { useMemo, useState } from 'react';
import {
  defaultLivePublicationSettings,
  emptyLivePublication,
  newPublicationId,
  type DirectorState,
  type LiveAnnouncement,
  type LiveBackendDescriptor,
  type LivePublication,
  type LivePublicationSettings,
} from '../domain';
import { buildBootstrapUrl, QbliveBootstrapError } from '@qbsheet/qblive-protocol';
import {
  AdvancedSection,
  Button,
  Callout,
  ChoiceCards,
  Dialog,
  EmptyState,
  Field,
  MultiSelect,
  Page,
  PageHeader,
  Panel,
  Select,
  Specs,
  StateLabel,
  SummaryItem,
  SummaryList,
  Switch,
  TextArea,
  TextInput,
  useConfirm,
} from '../components';
import { qrSvg } from './qr';
import { syncSummary } from './publication';
import { errorNotice, type AnnounceInput } from '../notices';

export interface LiveViewActions {
  enable(backend: LiveBackendDescriptor, setupToken: string | null): Promise<void>;
  disable(): void;
  updateSettings(changes: Partial<LivePublicationSettings>): void;
  publishAnnouncement(input: {
    title: string;
    body: string;
    severity: LiveAnnouncement['severity'];
    audienceTeamIds: string[];
  }): void;
  withdrawAnnouncement(id: string): void;
  finalize(): void;
  unpublish(): void;
  destroy(): void;
}

export function LiveView({
  state,
  actions,
  onAnnounce,
}: {
  state: DirectorState;
  actions: LiveViewActions;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const publication = state.live;
  return (
    <Page>
      <PageHeader
        title="QBSheet Live"
        description="Optional public schedules, standings, results, and tournament updates. Tournament operation does not depend on it."
      />
      {!state.tournament ? (
        <EmptyState
          title="No tournament yet"
          description="Create or open a tournament before setting up QBSheet Live."
        />
      ) : publication && publication.settings.enabled ? (
        <EnabledPanels state={state} publication={publication} actions={actions} onAnnounce={onAnnounce} />
      ) : (
        <SetupPanel actions={actions} onAnnounce={onAnnounce} />
      )}
    </Page>
  );
}

function SetupPanel({
  actions,
  onAnnounce,
}: {
  actions: LiveViewActions;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [kind, setKind] = useState<LiveBackendDescriptor['kind']>('cloudflare');
  const [origin, setOrigin] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    if (submitting) return;
    setError(null);
    const trimmed = origin.trim().replace(/\/+$/, '');
    if (kind !== 'local' && !trimmed) {
      setError('Enter the address of the tournament server.');
      return;
    }
    try {
      if (kind !== 'local') buildBootstrapUrl({ publicationId: newPublicationId(), backendOrigin: trimmed });
    } catch (reason) {
      setError(reason instanceof QbliveBootstrapError ? reason.message : 'That address is not valid.');
      return;
    }
    setSubmitting(true);
    onAnnounce('Connecting to the QBSheet Live backend.');
    try {
      await actions.enable(
        { kind, origin: kind === 'local' ? '' : trimmed, displayName: displayName.trim() || undefined },
        kind === 'local' ? null : setupToken.trim() || null,
      );
      onAnnounce('QBSheet Live setup completed. The initial snapshot is queued for publication.');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'The QBSheet Live backend could not be configured.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel
      title="Set up QBSheet Live"
      description="Publish a read-only view to a backend you control. QBSheet does not require an account."
    >
      <ChoiceCards<LiveBackendDescriptor['kind']>
        legend="Backend"
        value={kind}
        onChange={(next) => {
          setKind(next);
          setError(null);
        }}
        options={[
          {
            value: 'cloudflare',
            title: 'Cloudflare',
            badge: 'Recommended',
            description: 'A Worker and Durable Object in your own Cloudflare account.',
            disabled: submitting,
          },
          {
            value: 'custom',
            title: 'Custom QBLive server',
            badge: 'Advanced',
            description: 'Any server that implements QBLive v1.',
            disabled: submitting,
          },
          {
            value: 'local',
            title: 'Local network only',
            badge: 'No internet',
            description: 'Serve the public view on this LAN; App Clip access is unavailable.',
            disabled: submitting,
          },
        ]}
      />
      {kind !== 'local' && (
        <Field
          label="Server address"
          hint={
            kind === 'cloudflare'
              ? 'The Worker URL from Cloudflare.'
              : 'The HTTPS origin of your QBLive server, with no path.'
          }
          render={({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="url"
              value={origin}
              onChange={(event) => {
                setOrigin(event.target.value);
                setError(null);
              }}
              placeholder="https://…"
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        />
      )}
      {kind !== 'local' && (
        <Field
          label="One-time setup token"
          hint="Exchanged once for a durable credential, then discarded. The durable credential stays in this computer's keychain, not the tournament file."
          render={({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              type="password"
              value={setupToken}
              onChange={(event) => {
                setSetupToken(event.target.value);
                setError(null);
              }}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        />
      )}
      <Field label="Backend name" optional hint="Shown only in Director.">
        <TextInput
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={submitting}
          placeholder="Optional"
        />
      </Field>
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="director-form-actions">
        <Button variant="primary" icon="server" onClick={() => void submit()} disabled={submitting}>
          {submitting ? 'Connecting…' : 'Connect and test'}
        </Button>
      </div>
    </Panel>
  );
}

function EnabledPanels({
  state,
  publication,
  actions,
  onAnnounce,
}: {
  state: DirectorState;
  publication: LivePublication;
  actions: LiveViewActions;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  return (
    <>
      <LiveStatusPanel state={state} publication={publication} onAnnounce={onAnnounce} />
      <VisibilityPanel publication={publication} actions={actions} />
      <AnnouncementsPanel state={state} publication={publication} actions={actions} onAnnounce={onAnnounce} />
      <LifecyclePanel publication={publication} actions={actions} onAnnounce={onAnnounce} />
    </>
  );
}

function LiveStatusPanel({
  state,
  publication,
  onAnnounce,
}: {
  state: DirectorState;
  publication: LivePublication;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [showQr, setShowQr] = useState(false);
  const link = publication.publicUrl;
  const publicState =
    publication.lifecycle === 'live' || publication.lifecycle === 'final'
      ? 'Public'
      : publication.lifecycle === 'unpublished'
        ? 'Not public'
        : publication.lifecycle;
  const current = publication.sync.pendingItems === 0 && !publication.sync.lastError;
  const pushLabel =
    publication.push.status === 'enabled'
      ? 'Available'
      : publication.push.status === 'degraded'
        ? 'Temporarily unavailable'
        : publication.push.status === 'unavailable'
          ? 'Unavailable'
          : 'Off';

  return (
    <Panel
      title={publicState}
      description={current ? 'Public data is up to date.' : syncSummary(publication)}
      tone={publication.sync.lastError ? 'warning' : undefined}
      actions={
        <StateLabel state={publication.sync.lastError ? 'help' : publication.lifecycle} label={publicState} />
      }
    >
      {publication.sync.lastError && (
        <Callout tone="warning" title="Publishing is temporarily degraded">
          {publication.sync.lastError} Tournament operation is unaffected; queued updates retry automatically.
        </Callout>
      )}
      {link ? (
        <div className="director-stack director-stack-tight">
          <Field label="Participant link">
            <TextInput value={link} readOnly onFocus={(event) => event.currentTarget.select()} />
          </Field>
          <div className="director-actions">
            <Button
              variant="secondary"
              icon="copy"
              onClick={async () => {
                try {
                  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
                  await navigator.clipboard.writeText(link);
                  onAnnounce('Public link copied.');
                } catch {
                  onAnnounce(errorNotice('Copy failed — select the link and copy manually.'));
                }
              }}
            >
              Copy link
            </Button>
            <Button variant="quiet" onClick={() => setShowQr((shown) => !shown)}>
              {showQr ? 'Hide QR' : 'Show QR'}
            </Button>
            <Button
              variant="quiet"
              icon="publish"
              onClick={() => printQr(link, state.tournament?.name ?? 'Tournament')}
            >
              Print QR
            </Button>
          </div>
          {showQr && <QrPanel link={link} />}
        </div>
      ) : (
        <p className="director-text-secondary">
          The participant link appears after the first publication reaches the backend.
        </p>
      )}
      <AdvancedSection
        label="Publishing diagnostics"
        hint="Backend, revision, synchronization, and Apple background-update details."
        icon="settings"
      >
        <Specs
          items={[
            { term: 'Backend', value: backendLabel(publication) },
            { term: 'Local revision', value: publication.sync.localRevision, mono: true },
            { term: 'Backend revision', value: publication.sync.acknowledgedRevision, mono: true },
            { term: 'Pending updates', value: publication.sync.pendingItems || 'None' },
            {
              term: 'Last successful sync',
              value: formatLiveTimestamp(publication.sync.lastSuccessAt) ?? 'Never',
            },
            { term: 'Apple background updates', value: pushLabel },
          ]}
        />
      </AdvancedSection>
    </Panel>
  );
}

function VisibilityPanel({
  publication,
  actions,
}: {
  publication: LivePublication;
  actions: LiveViewActions;
}) {
  const confirmAction = useConfirm();
  const setSetting = async (key: keyof LivePublicationSettings, checked: boolean, warning?: string) => {
    if (checked && warning) {
      const approved = await confirmAction({
        title: 'Make individual information public?',
        body: warning,
        consequence: 'The information becomes available to anyone with the tournament’s QBSheet Live link.',
        confirmLabel: 'Publish this',
        tone: 'warning',
      });
      if (!approved) return;
    }
    actions.updateSettings({ [key]: checked } as Partial<LivePublicationSettings>);
  };

  return (
    <Panel
      title="Public visibility"
      description="These switches take effect immediately and publish on the next synchronization."
    >
      {visibilityGroups.map((group) => (
        <section key={group.heading} className="director-live-visibility-group">
          <h3>{group.heading}</h3>
          <div className="director-stack director-stack-tight">
            {group.rows.map((row) => {
              const dependency = visibilityDependencies[row.key];
              const parentEnabled = dependency ? Boolean(publication.settings[dependency.parent]) : true;
              const disabled = Boolean(dependency && !parentEnabled);
              return (
                <div key={row.key} className={dependency ? 'director-choice-dependents' : undefined}>
                  <Switch
                    checked={Boolean(publication.settings[row.key])}
                    disabled={disabled}
                    label={row.label}
                    hint={disabled ? `Requires ${dependency?.label}` : row.description}
                    onChange={(checked) => void setSetting(row.key, checked, row.warning)}
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </Panel>
  );
}

const visibilityGroups: {
  heading: string;
  rows: { key: keyof LivePublicationSettings; label: string; description: string; warning?: string }[];
}[] = [
  {
    heading: 'Teams and players',
    rows: [
      { key: 'teamNames', label: 'Team names', description: 'Off publishes seeds instead of names.' },
      {
        key: 'playerNames',
        label: 'Player names',
        description: 'Publishes public rosters.',
        warning: 'Individual player names and roster information will become public.',
      },
      {
        key: 'playerStatistics',
        label: 'Individual player statistics',
        description: 'Requires player names.',
        warning: 'Individual player statistics will become public.',
      },
    ],
  },
  {
    heading: 'Schedule and rooms',
    rows: [
      {
        key: 'releasedSchedule',
        label: 'Released schedule',
        description: 'Only released rounds; unreleased pairings are never published.',
      },
      { key: 'roomLocations', label: 'Room locations', description: 'Room names on public games.' },
      {
        key: 'roomDirections',
        label: 'Room directions',
        description: 'Directions text associated with public rooms.',
      },
    ],
  },
  {
    heading: 'Scores',
    rows: [
      { key: 'acceptedResults', label: 'Accepted results', description: 'Final scores of accepted games.' },
      { key: 'liveGameStatus', label: 'Live game status', description: 'Shows that a game is in progress.' },
      { key: 'liveScores', label: 'Live scores', description: 'Running score of games in progress.' },
      { key: 'liveProgress', label: 'Tossups read', description: 'Progress through games in progress.' },
    ],
  },
  {
    heading: 'Tables and updates',
    rows: [
      { key: 'standings', label: 'Standings', description: 'Director-computed standings tables.' },
      { key: 'teamStatistics', label: 'Team statistics', description: 'Team-level statistics tables.' },
      { key: 'announcements', label: 'Announcements', description: 'Updates published from this screen.' },
    ],
  },
];

const visibilityDependencies: Partial<
  Record<keyof LivePublicationSettings, { parent: keyof LivePublicationSettings; label: string }>
> = {
  playerStatistics: { parent: 'playerNames', label: 'Player names' },
  liveScores: { parent: 'liveGameStatus', label: 'Live game status' },
  liveProgress: { parent: 'liveGameStatus', label: 'Live game status' },
  roomDirections: { parent: 'roomLocations', label: 'Room locations' },
};

function AnnouncementsPanel({
  state,
  publication,
  actions,
  onAnnounce,
}: {
  state: DirectorState;
  publication: LivePublication;
  actions: LiveViewActions;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [composeOpen, setComposeOpen] = useState(false);
  const live = publication.announcements.filter((announcement) => !announcement.withdrawn);
  return (
    <Panel
      title="Announcements"
      description={live.length === 0 ? 'No public announcements.' : `${live.length} currently published.`}
      actions={
        <Button variant="primary" icon="plus" onClick={() => setComposeOpen(true)}>
          New announcement
        </Button>
      }
      flush
    >
      {live.length === 0 ? (
        <div className="director-empty-in-panel">
          <p className="director-empty-copy">
            Use announcements for schedule changes, delays, room notices, and tournament-wide updates.
          </p>
        </div>
      ) : (
        <SummaryList ariaLabel="Published announcements">
          {live.map((announcement) => (
            <SummaryItem
              key={announcement.id}
              title={<strong>{announcement.title}</strong>}
              status={
                <StateLabel state={announcement.severity} label={severityLabel(announcement.severity)} />
              }
              summary={`${formatLiveTimestamp(announcement.publishedAt) ?? announcement.publishedAt}${announcement.audienceTeamIds.length ? ` · ${announcement.audienceTeamIds.length} team${announcement.audienceTeamIds.length === 1 ? '' : 's'}` : ' · Everybody'}`}
              actions={
                <Button variant="quiet" onClick={() => actions.withdrawAnnouncement(announcement.id)}>
                  Withdraw
                </Button>
              }
            />
          ))}
        </SummaryList>
      )}
      {composeOpen && (
        <AnnouncementDialog
          state={state}
          actions={actions}
          onAnnounce={onAnnounce}
          onClose={() => setComposeOpen(false)}
        />
      )}
    </Panel>
  );
}

function AnnouncementDialog({
  state,
  actions,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  actions: LiveViewActions;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<LiveAnnouncement['severity']>('information');
  const [audience, setAudience] = useState<string[]>([]);
  return (
    <Dialog
      title="New announcement"
      description="Leave Audience empty to publish to everybody."
      size="lg"
      onClose={onClose}
      onSubmit={() => {
        if (!title.trim() || !body.trim()) return;
        actions.publishAnnouncement({ title, body, severity, audienceTeamIds: audience });
        onAnnounce('Announcement queued for publication.');
        onClose();
      }}
      submitLabel="Publish announcement"
      submitDisabled={!title.trim() || !body.trim()}
    >
      <Field label="Title">
        <TextInput value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label="Message" hint="Plain text. Line breaks are kept; formatting is not.">
        <TextArea value={body} rows={4} maxLength={2000} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <Field
        label="Importance"
        render={({ id, describedBy }) => (
          <Select<LiveAnnouncement['severity']>
            id={id}
            ariaDescribedBy={describedBy}
            value={severity}
            options={[
              { value: 'information', label: 'Information' },
              { value: 'important', label: 'Important' },
              { value: 'urgent', label: 'Urgent' },
            ]}
            onChange={setSeverity}
          />
        )}
      />
      <Field
        label="Audience"
        hint="Everybody is the default."
        render={({ id, labelId, describedBy }) => (
          <MultiSelect
            id={id}
            ariaLabelledBy={labelId}
            ariaDescribedBy={describedBy}
            values={audience}
            options={state.teams.map((team) => ({ value: team.id, label: team.displayName }))}
            onChange={setAudience}
            allLabel="Everybody"
            searchPlaceholder="Filter teams…"
          />
        )}
      />
    </Dialog>
  );
}

function LifecyclePanel({
  publication,
  actions,
  onAnnounce,
}: {
  publication: LivePublication;
  actions: LiveViewActions;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const confirmAction = useConfirm();
  const canFinalize = publication.lifecycle === 'live';
  const canUnpublish = !['unpublishing', 'unpublished', 'deleting'].includes(publication.lifecycle);
  const canDisable = !['unpublishing', 'deleting'].includes(publication.lifecycle);
  return (
    <Panel
      title="Publication lifecycle"
      description="Finishing, hiding, deleting, and disconnecting are different operations and are deliberately separated."
    >
      <SummaryList ariaLabel="QBSheet Live lifecycle actions">
        <SummaryItem
          title={<strong>Publish final results</strong>}
          summary="Publish final standings and freeze the public page. The page stays available."
          actions={
            <Button
              variant="primary"
              disabled={!canFinalize}
              onClick={() => {
                actions.finalize();
                onAnnounce('Final results queued for publication.');
              }}
            >
              {publication.lifecycle === 'final' ? 'Final results published' : 'Publish final'}
            </Button>
          }
        />
        <SummaryItem
          title={<strong>Unpublish public page</strong>}
          summary="Hide the tournament publicly while retaining the backend publication so it can be restored."
          actions={
            <Button
              variant="secondary"
              disabled={!canUnpublish}
              onClick={() =>
                void (async () => {
                  const approved = await confirmAction({
                    title: 'Unpublish QBSheet Live?',
                    consequence:
                      'Participants will no longer be able to open the public tournament after the backend confirms the change. The publication can be restored later.',
                    confirmLabel: 'Unpublish',
                    tone: 'warning',
                  });
                  if (!approved) return;
                  actions.unpublish();
                  onAnnounce(
                    'Unpublish queued. The public page remains available until the backend confirms it.',
                  );
                })()
              }
            >
              {publication.lifecycle === 'unpublishing' ? 'Unpublishing…' : 'Unpublish'}
            </Button>
          }
        />
        <SummaryItem
          title={<strong>Turn QBSheet Live off in Director</strong>}
          summary={
            publication.backend?.kind === 'local'
              ? 'Stop the local public listener and clear the local page.'
              : 'Stop this Director from publishing. Existing backend content is unchanged.'
          }
          actions={
            <Button
              variant="secondary"
              disabled={!canDisable}
              onClick={() =>
                void (async () => {
                  const approved = await confirmAction({
                    title: 'Turn QBSheet Live off?',
                    consequence:
                      publication.backend?.kind === 'local'
                        ? 'The local public page will stop being served.'
                        : 'This Director will stop sending updates; anything already published remains on the backend.',
                    confirmLabel: 'Turn off',
                    tone: 'warning',
                  });
                  if (!approved) return;
                  actions.disable();
                  onAnnounce('QBSheet Live turned off in Director.');
                })()
              }
            >
              Turn off
            </Button>
          }
        />
      </SummaryList>
      <AdvancedSection
        label="Delete backend publication"
        hint="Permanent destructive cleanup; not part of normal tournament completion."
        icon="danger"
      >
        <Callout tone="danger" title="Delete permanently">
          This removes the public tournament, revokes its credential, and deletes Apple push channels. It
          cannot be undone.
        </Callout>
        <Button
          variant="danger-solid"
          disabled={publication.lifecycle === 'deleting'}
          onClick={() =>
            void (async () => {
              const approved = await confirmAction({
                title: 'Delete this QBSheet Live publication?',
                body: 'The public tournament and its backend credential will be removed.',
                consequence:
                  'This cannot be undone. Re-enabling QBSheet Live later creates a new publication.',
                confirmLabel: 'Delete permanently',
                tone: 'danger',
              });
              if (!approved) return;
              actions.destroy();
              onAnnounce('Delete queued. Director will clear the publication after backend confirmation.');
            })()
          }
        >
          {publication.lifecycle === 'deleting' ? 'Deleting…' : 'Delete from backend…'}
        </Button>
      </AdvancedSection>
    </Panel>
  );
}

function backendLabel(publication: LivePublication): string {
  if (!publication.backend) return 'Not configured';
  const kind =
    publication.backend.kind === 'cloudflare'
      ? 'Cloudflare · director-owned'
      : publication.backend.kind === 'local'
        ? 'Local network'
        : 'Custom server';
  return publication.backend.displayName ? `${kind} · ${publication.backend.displayName}` : kind;
}

function formatLiveTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return date.toLocaleString();
  }
}

function severityLabel(severity: LiveAnnouncement['severity']): string {
  return severity === 'information' ? 'Information' : severity === 'important' ? 'Important' : 'Urgent';
}

function QrPanel({ link }: { link: string }) {
  const svg = useMemo(() => {
    try {
      return qrSvg(link, { size: 240 });
    } catch {
      return null;
    }
  }, [link]);
  if (!svg) return <p className="director-text-secondary">This link is too long to encode in a QR code.</p>;
  return (
    <div className="director-live-qr">
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

function printQr(link: string, tournamentName: string): void {
  let svg: string;
  try {
    svg = qrSvg(link, { size: 420 });
  } catch {
    return;
  }
  const page = window.open('', '_blank', 'width=680,height=880');
  if (!page) return;
  page.document.write(
    [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      `<title>QBSheet Live — ${escapeHtml(tournamentName)}</title>`,
      '<style>',
      'body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
      'margin:0;padding:48px 32px;text-align:center;color:#14181d;background:#fff}',
      'h1{font-size:22px;margin:0 0 6px}p{margin:0 0 28px;color:#5b6672}',
      'svg{display:block;margin:0 auto 24px}',
      'h2{font-size:18px;font-weight:600;margin:0}',
      'code{font-size:12px;color:#5b6672;word-break:break-all}',
      '@page{margin:16mm}',
      '</style></head><body>',
      '<h1>QBSheet Live</h1>',
      '<p>Follow schedules, standings, results, and tournament updates.</p>',
      svg,
      `<h2>${escapeHtml(tournamentName)}</h2>`,
      `<code>${escapeHtml(link)}</code>`,
      '</body></html>',
    ].join(''),
  );
  page.document.close();
  page.focus();
  page.print();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A fresh publication record, for the controller's `enable`. */
export function newPublication(at: string): LivePublication {
  const publication = emptyLivePublication(newPublicationId(), at);
  publication.settings = { ...defaultLivePublicationSettings(), enabled: true };
  publication.lifecycle = 'configuring';
  return publication;
}
