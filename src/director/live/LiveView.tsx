/**
 * The Director's QBSheet Live section.
 *
 * Rows and plain panels, matching the rest of Director. No KPI cards: a tournament director looks
 * at this between rounds to answer three questions — is it publishing, what is public, and what is
 * the link — and each of those is a line of text, not a dashboard tile.
 *
 * The two states this screen has to distinguish carefully are "the Live backend is unreachable" and
 * "Apple background updates are unavailable". They are different failures with different
 * consequences, and collapsing them into "QBSheet Live offline" would tell a Director their
 * spectators have nothing when in fact only Lock Screen updates are degraded.
 */

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
import { Button, EmptyState, FormField, StateLabel } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { qrSvg } from './qr';
import { syncSummary } from './publication';

export interface LiveViewActions {
  enable(backend: LiveBackendDescriptor, setupToken: string | null): void;
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
  onAnnounce: (message: string) => void;
}) {
  const publication = state.live;

  if (!state.tournament) {
    return (
      <>
        <PageHeader
          eyebrow="Review"
          title="QBSheet Live"
          description="Publish this tournament for participants."
        />
        <div className="director-page-stack">
          <EmptyState
            title="No tournament yet"
            description="Create or open a tournament before setting up QBSheet Live."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Review"
        title="QBSheet Live"
        description="Publish schedules, standings, results, and updates for participants. Optional; the tournament runs without it."
      />
      <div className="director-page-stack">
        {publication && publication.settings.enabled ? (
          <EnabledPanels state={state} publication={publication} actions={actions} onAnnounce={onAnnounce} />
        ) : (
          <SetupPanel actions={actions} onAnnounce={onAnnounce} />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function SetupPanel({
  actions,
  onAnnounce,
}: {
  actions: LiveViewActions;
  onAnnounce: (message: string) => void;
}) {
  const [kind, setKind] = useState<LiveBackendDescriptor['kind']>('cloudflare');
  const [origin, setOrigin] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    setError(null);
    const trimmed = origin.trim().replace(/\/+$/, '');
    if (!trimmed) {
      setError('Enter the address of the tournament server.');
      return;
    }
    try {
      // Validated here rather than after the round trip, so a typo is a sentence rather than a
      // failed request. The same validator the clients use.
      buildBootstrapUrl({ publicationId: newPublicationId(), backendOrigin: trimmed });
    } catch (reason) {
      setError(reason instanceof QbliveBootstrapError ? reason.message : 'That address is not valid.');
      return;
    }
    actions.enable(
      { kind, origin: trimmed, displayName: displayName.trim() || undefined },
      kind === 'local' ? null : setupToken.trim() || null,
    );
    onAnnounce('Connecting to the QBSheet Live backend.');
  };

  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Set up</p>
          <h2>Choose a backend</h2>
        </div>
        <span className="director-muted">Off</span>
      </div>
      <div className="director-panel-body director-live-setup">
        <p className="director-muted">
          QBSheet Live publishes a public, read-only view of this tournament to a server you control. QBSheet
          does not host your tournament data and does not need an account.
        </p>

        <div className="director-live-choices" role="radiogroup" aria-label="Backend">
          <BackendChoice
            id="cloudflare"
            selected={kind}
            onSelect={setKind}
            title="Set up with Cloudflare"
            badge="Recommended"
            description="A Worker and a Durable Object in your own Cloudflare account. Deploy the template, paste the address and the one-time setup token."
          />
          <BackendChoice
            id="custom"
            selected={kind}
            onSelect={setKind}
            title="Connect a custom server"
            badge="Advanced"
            description="Any server that implements QBLive v1. Director runs conformance checks before publishing."
          />
          <BackendChoice
            id="local"
            selected={kind}
            onSelect={setKind}
            title="Local network only"
            badge="No internet"
            description="Director serves QBSheet Live on this network. Participants use the web client; the App Clip needs the internet and will not be offered."
          />
        </div>

        <FormField
          label={kind === 'local' ? 'Local address' : 'Server address'}
          hint={
            kind === 'cloudflare'
              ? 'The Worker URL Cloudflare gave you, for example https://qblive-backend.your-name.workers.dev'
              : kind === 'local'
                ? 'Filled in automatically when Director starts the local server.'
                : 'The HTTPS origin of your QBLive server, with no path.'
          }
        >
          <input
            type="url"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            placeholder={kind === 'local' ? 'http://192.168.1.20:8790' : 'https://…'}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>

        {kind !== 'local' && (
          <FormField
            label="One-time setup token"
            hint="Exchanged once for a durable credential, then discarded. Director stores the credential in this computer's keychain, never in the tournament file."
          >
            <input
              type="password"
              value={setupToken}
              onChange={(event) => setSetupToken(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
        )}

        <FormField label="Name for this backend" hint="Shown only in Director.">
          <input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Optional"
          />
        </FormField>

        {error && (
          <p className="director-error-copy" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="director-panel-footer">
        <Button variant="primary" icon="server" onClick={submit}>
          Connect and test
        </Button>
      </div>
    </section>
  );
}

function BackendChoice({
  id,
  selected,
  onSelect,
  title,
  badge,
  description,
}: {
  id: LiveBackendDescriptor['kind'];
  selected: LiveBackendDescriptor['kind'];
  onSelect: (kind: LiveBackendDescriptor['kind']) => void;
  title: string;
  badge: string;
  description: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected === id}
      className="director-live-choice"
      onClick={() => onSelect(id)}
    >
      <span className="director-live-choice-head">
        <strong>{title}</strong>
        <span className="director-live-badge">{badge}</span>
      </span>
      <span className="director-muted">{description}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Enabled
// ---------------------------------------------------------------------------

function EnabledPanels({
  state,
  publication,
  actions,
  onAnnounce,
}: {
  state: DirectorState;
  publication: LivePublication;
  actions: LiveViewActions;
  onAnnounce: (message: string) => void;
}) {
  const [showQr, setShowQr] = useState(false);
  const link = publication.publicUrl;

  return (
    <>
      <StatusPanel publication={publication} />

      <section className="director-panel">
        <div className="director-panel-heading">
          <div>
            <p className="director-eyebrow">Share</p>
            <h2>Public link</h2>
          </div>
        </div>
        <div className="director-panel-body">
          {link ? (
            <>
              <p className="director-live-link">
                <code>{link}</code>
              </p>
              <div className="director-live-actions">
                <Button
                  icon="clipboard"
                  onClick={() => {
                    void navigator.clipboard?.writeText(link);
                    onAnnounce('Public link copied.');
                  }}
                >
                  Copy
                </Button>
                <Button icon="search" onClick={() => setShowQr((shown) => !shown)}>
                  {showQr ? 'Hide QR' : 'Show QR'}
                </Button>
                <Button icon="publish" onClick={() => printQr(link, state.tournament?.name ?? 'Tournament')}>
                  Print QR
                </Button>
              </div>
              {showQr && <QrPanel link={link} />}
            </>
          ) : (
            // Never show a QR before a publication has actually reached the backend: a printed code
            // that resolves to nothing is worse than no code.
            <p className="director-muted">
              The link appears once the first publication has reached the backend.
            </p>
          )}
        </div>
      </section>

      <VisibilityPanel publication={publication} actions={actions} />
      <AnnouncementsPanel state={state} publication={publication} actions={actions} onAnnounce={onAnnounce} />
      <LifecyclePanel publication={publication} actions={actions} onAnnounce={onAnnounce} />
    </>
  );
}

function StatusPanel({ publication }: { publication: LivePublication }) {
  const pushLabel =
    publication.push.status === 'enabled'
      ? 'Available'
      : publication.push.status === 'degraded'
        ? 'Temporarily unavailable'
        : publication.push.status === 'unavailable'
          ? 'Unavailable'
          : 'Off';

  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Status</p>
          <h2>{syncSummary(publication)}</h2>
        </div>
        <StateLabel state={publication.sync.lastError ? 'help' : publication.lifecycle} />
      </div>
      <div className="director-panel-body director-live-rows">
        <Row label="Backend" value={backendLabel(publication)} />
        <Row label="Local revision" value={String(publication.sync.localRevision)} />
        <Row label="Acknowledged by backend" value={String(publication.sync.acknowledgedRevision)} />
        <Row
          label="Pending updates"
          value={publication.sync.pendingItems === 0 ? 'None' : String(publication.sync.pendingItems)}
        />
        <Row label="Last successful sync" value={publication.sync.lastSuccessAt ?? 'Never'} />
        {publication.sync.lastError && (
          <Row label="Last error" value={publication.sync.lastError} tone="warning" />
        )}
        {/*
          Deliberately its own row and its own sentence. Apple background updates failing does not
          mean QBSheet Live is down; conflating the two would tell a Director their spectators have
          nothing when in fact only the Lock Screen is degraded.
        */}
        <Row label="Apple background updates" value={pushLabel} />
      </div>
      {publication.sync.pendingItems > 0 && publication.sync.lastError && (
        <div className="director-panel-footer">
          <p className="director-muted">
            Tournament operation is unaffected. Queued updates publish automatically when the backend is
            reachable again.
          </p>
        </div>
      )}
    </section>
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

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return (
    <div className={`director-live-row${tone ? ` director-live-row-${tone}` : ''}`}>
      <span className="director-muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function QrPanel({ link }: { link: string }) {
  const svg = useMemo(() => {
    try {
      return qrSvg(link, { size: 240 });
    } catch {
      return null;
    }
  }, [link]);
  if (!svg) return <p className="director-muted">This link is too long to encode in a QR code.</p>;
  return (
    <div className="director-live-qr">
      {/*
        The SVG is generated in this process from a URL this process built. There is no external
        input in it, which is what makes this the one place `dangerouslySetInnerHTML` is warranted
        rather than an `<img>` with a data URL that a printer would rasterise badly.
      */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

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
        warning:
          'Individual player information will become publicly accessible through this tournament’s QBSheet Live link.',
      },
      {
        key: 'playerStatistics',
        label: 'Individual player statistics',
        description: 'Requires player names.',
        warning:
          'Individual player statistics will become publicly accessible through this tournament’s QBSheet Live link.',
      },
    ],
  },
  {
    heading: 'Schedule and rooms',
    rows: [
      {
        key: 'releasedSchedule',
        label: 'Released schedule',
        description: 'Only rounds you have released. Unreleased pairings are never published.',
      },
      { key: 'roomLocations', label: 'Room locations', description: 'Room names on public games.' },
      { key: 'roomDirections', label: 'Room directions', description: 'The directions text on each room.' },
    ],
  },
  {
    heading: 'Scores',
    rows: [
      { key: 'acceptedResults', label: 'Accepted results', description: 'Final scores of accepted games.' },
      { key: 'liveGameStatus', label: 'Live game status', description: 'That a game is in progress.' },
      { key: 'liveScores', label: 'Live scores', description: 'The running score of a game in progress.' },
      { key: 'liveProgress', label: 'Tossups read', description: 'Progress through a game in progress.' },
    ],
  },
  {
    heading: 'Tables and updates',
    rows: [
      {
        key: 'standings',
        label: 'Standings',
        description: 'Your standings tables, as Director computes them.',
      },
      { key: 'teamStatistics', label: 'Team statistics', description: 'Team-level statistics tables.' },
      { key: 'announcements', label: 'Announcements', description: 'Updates you publish from this screen.' },
    ],
  },
];

function VisibilityPanel({
  publication,
  actions,
}: {
  publication: LivePublication;
  actions: LiveViewActions;
}) {
  const [confirming, setConfirming] = useState<keyof LivePublicationSettings | null>(null);

  const toggle = (key: keyof LivePublicationSettings, warning: string | undefined): void => {
    const turningOn = !publication.settings[key];
    if (turningOn && warning) {
      setConfirming(key);
      return;
    }
    actions.updateSettings({ [key]: turningOn } as Partial<LivePublicationSettings>);
  };

  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Privacy</p>
          <h2>Public visibility</h2>
        </div>
        <span className="director-muted">What participants can see</span>
      </div>
      <div className="director-panel-body director-live-rows">
        {visibilityGroups.map((group) => (
          <div key={group.heading} className="director-live-group">
            <p className="director-eyebrow">{group.heading}</p>
            {group.rows.map((row) => (
              <div key={row.key} className="director-live-row">
                <span>
                  <span>{row.label}</span>
                  <small className="director-muted">{row.description}</small>
                </span>
                <label className="director-live-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(publication.settings[row.key])}
                    onChange={() => toggle(row.key, row.warning)}
                  />
                  <span>{publication.settings[row.key] ? 'On' : 'Off'}</span>
                </label>
              </div>
            ))}
          </div>
        ))}
      </div>
      {confirming && (
        <div className="director-panel-footer director-live-warning" role="alert">
          <Icon name="alert" size={15} />
          <p>
            {visibilityGroups.flatMap((group) => group.rows).find((row) => row.key === confirming)?.warning}
          </p>
          <div className="director-live-actions">
            <Button onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                actions.updateSettings({ [confirming]: true } as Partial<LivePublicationSettings>);
                setConfirming(null);
              }}
            >
              Publish this
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

function AnnouncementsPanel({
  state,
  publication,
  actions,
  onAnnounce,
}: {
  state: DirectorState;
  publication: LivePublication;
  actions: LiveViewActions;
  onAnnounce: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<LiveAnnouncement['severity']>('information');
  const [audience, setAudience] = useState<string[]>([]);

  const publish = (): void => {
    if (!title.trim() || !body.trim()) return;
    actions.publishAnnouncement({ title, body, severity, audienceTeamIds: audience });
    setTitle('');
    setBody('');
    setSeverity('information');
    setAudience([]);
    onAnnounce('Announcement queued for publication.');
  };

  const live = publication.announcements.filter((announcement) => !announcement.withdrawn);

  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Communicate</p>
          <h2>Announcements</h2>
        </div>
        <span className="director-muted">{live.length === 0 ? 'None' : `${live.length} published`}</span>
      </div>
      <div className="director-panel-body director-live-compose">
        <FormField label="Title">
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
          />
        </FormField>
        <FormField label="Message" hint="Plain text. Line breaks are kept; formatting is not.">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            maxLength={2000}
          />
        </FormField>
        <FormField label="Importance">
          <select
            value={severity}
            onChange={(event) => setSeverity(event.target.value as LiveAnnouncement['severity'])}
          >
            <option value="information">Information</option>
            <option value="important">Important</option>
            <option value="urgent">Urgent</option>
          </select>
        </FormField>
        <FormField label="Audience" hint="Leave empty for everybody.">
          <select
            multiple
            size={4}
            value={audience}
            onChange={(event) => setAudience([...event.target.selectedOptions].map((option) => option.value))}
          >
            {state.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.displayName}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <div className="director-panel-footer">
        <Button variant="primary" icon="publish" onClick={publish} disabled={!title.trim() || !body.trim()}>
          Publish announcement
        </Button>
      </div>
      {live.length > 0 && (
        <div className="director-panel-body director-live-rows">
          {live.map((announcement) => (
            <div key={announcement.id} className="director-live-row">
              <span>
                <span>{announcement.title}</span>
                <small className="director-muted">
                  {announcement.severity} · {announcement.publishedAt}
                </small>
              </span>
              <Button variant="quiet" onClick={() => actions.withdrawAnnouncement(announcement.id)}>
                Withdraw
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function LifecyclePanel({
  publication,
  actions,
  onAnnounce,
}: {
  publication: LivePublication;
  actions: LiveViewActions;
  onAnnounce: (message: string) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <section className="director-panel">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Finish</p>
          <h2>Tournament completion</h2>
        </div>
      </div>
      <div className="director-panel-body director-live-rows">
        <div className="director-live-row">
          <span>
            <span>Publish final results</span>
            <small className="director-muted">
              Publishes the final standings and freezes the public page. The page stays available.
            </small>
          </span>
          <Button
            onClick={() => {
              actions.finalize();
              onAnnounce('Final results queued for publication.');
            }}
            disabled={publication.lifecycle === 'final'}
          >
            {publication.lifecycle === 'final' ? 'Published' : 'Publish final'}
          </Button>
        </div>
        <div className="director-live-row">
          <span>
            <span>Unpublish</span>
            <small className="director-muted">
              Stops serving the tournament publicly. The backend keeps it, and publishing again restores it.
            </small>
          </span>
          <Button
            onClick={() => {
              actions.unpublish();
              onAnnounce('Tournament unpublished.');
            }}
            disabled={publication.lifecycle === 'unpublished'}
          >
            Unpublish
          </Button>
        </div>
        <div className="director-live-row">
          <span>
            <span>Delete from the backend</span>
            <small className="director-muted">
              Removes the public tournament, revokes its credential, and deletes any Apple push channels. This
              cannot be undone.
            </small>
          </span>
          {confirmingDelete ? (
            <span className="director-live-actions">
              <Button onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  actions.destroy();
                  setConfirmingDelete(false);
                  onAnnounce('QBSheet Live publication deleted.');
                }}
              >
                Delete permanently
              </Button>
            </span>
          ) : (
            <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
              Delete
            </Button>
          )}
        </div>
        <div className="director-live-row">
          <span>
            <span>Turn QBSheet Live off</span>
            <small className="director-muted">
              Stops publishing from this Director. Nothing already published changes.
            </small>
          </span>
          <Button onClick={actions.disable}>Turn off</Button>
        </div>
      </div>
    </section>
  );
}

/**
 * A printable QR page.
 *
 * Opened in a new window rather than rendered into Director and printed with a stylesheet: a
 * Director window has a sidebar, a toolbar and a scroll position, and a print stylesheet that hides
 * all of it is a stylesheet that breaks the next time the layout changes. One small document, three
 * elements, nothing to break.
 */
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
