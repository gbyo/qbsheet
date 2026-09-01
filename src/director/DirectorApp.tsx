import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import BrandLogo from '../BrandLogo';

type SectionId =
  | 'overview'
  | 'teams'
  | 'format'
  | 'rooms'
  | 'packets'
  | 'tournament'
  | 'results'
  | 'standings'
  | 'publish'
  | 'settings';

type RoomState = 'live' | 'finished' | 'help' | 'waiting';

type IconName =
  | 'activity'
  | 'alert'
  | 'arrow'
  | 'calendar'
  | 'check'
  | 'chevron'
  | 'clipboard'
  | 'download'
  | 'file'
  | 'format'
  | 'help'
  | 'inbox'
  | 'more'
  | 'pause'
  | 'play'
  | 'publish'
  | 'rooms'
  | 'search'
  | 'server'
  | 'settings'
  | 'standings'
  | 'teams'
  | 'tournament'
  | 'users';

interface Room {
  id: string;
  state: RoomState;
  teams: string;
  score: string;
  progress: string;
  detail: string;
  lastActivity: string;
}

interface Team {
  seed: number;
  name: string;
  school: string;
  record: string;
  points: number;
  status: 'Confirmed' | 'Waitlist' | 'Dropped';
}

interface ResultItem {
  id: string;
  room: string;
  teams: string;
  score: string;
  reason: string;
  received: string;
  severity: 'review' | 'clean';
}

const navigation: Array<{
  label?: string;
  items: Array<{ id: SectionId; label: string; icon: IconName }>;
}> = [
  { items: [{ id: 'overview', label: 'Overview', icon: 'activity' }] },
  {
    label: 'Plan',
    items: [
      { id: 'teams', label: 'Teams', icon: 'teams' },
      { id: 'format', label: 'Format', icon: 'format' },
      { id: 'rooms', label: 'Rooms & staff', icon: 'rooms' },
      { id: 'packets', label: 'Packets', icon: 'file' },
    ],
  },
  {
    label: 'Run',
    items: [
      { id: 'tournament', label: 'Tournament', icon: 'tournament' },
      { id: 'results', label: 'Results', icon: 'inbox' },
    ],
  },
  {
    label: 'Review',
    items: [
      { id: 'standings', label: 'Standings & stats', icon: 'standings' },
      { id: 'publish', label: 'Publish', icon: 'publish' },
    ],
  },
  { items: [{ id: 'settings', label: 'Settings', icon: 'settings' }] },
];

const rooms: Room[] = [
  {
    id: '101',
    state: 'live',
    teams: 'Northview A · Brookline A',
    score: '220–205',
    progress: 'TU 17',
    detail: 'On pace',
    lastActivity: 'just now',
  },
  {
    id: '102',
    state: 'live',
    teams: 'Eastside A · St. Mark’s',
    score: '180–240',
    progress: 'TU 15',
    detail: 'On pace',
    lastActivity: '1 min ago',
  },
  {
    id: '103',
    state: 'finished',
    teams: 'Riverside A · Westfield B',
    score: '310–245',
    progress: 'Complete',
    detail: 'Result received',
    lastActivity: '3 min ago',
  },
  {
    id: '104',
    state: 'help',
    teams: 'Lakeside A · Greenwood B',
    score: '160–165',
    progress: 'TU 12',
    detail: 'Question ruling requested',
    lastActivity: '4 min ago',
  },
  {
    id: '105',
    state: 'waiting',
    teams: 'Hamilton A · Oak Ridge A',
    score: '—',
    progress: 'Not started',
    detail: 'Scorer disconnected',
    lastActivity: '6 min ago',
  },
  {
    id: '106',
    state: 'live',
    teams: 'Cedar Grove · Northview B',
    score: '195–180',
    progress: 'TU 16',
    detail: 'On pace',
    lastActivity: '2 min ago',
  },
  {
    id: '107',
    state: 'finished',
    teams: 'Brookline B · Fairview',
    score: '275–210',
    progress: 'Complete',
    detail: 'Result received',
    lastActivity: '5 min ago',
  },
  {
    id: '108',
    state: 'live',
    teams: 'St. Anne’s · Union A',
    score: '145–130',
    progress: 'TU 14',
    detail: 'On pace',
    lastActivity: '2 min ago',
  },
  {
    id: '109',
    state: 'finished',
    teams: 'Westfield A · Lakeside B',
    score: '260–190',
    progress: 'Complete',
    detail: 'Result received',
    lastActivity: '7 min ago',
  },
  {
    id: '110',
    state: 'live',
    teams: 'Greenwood A · Hamilton B',
    score: '205–200',
    progress: 'TU 13',
    detail: 'On pace',
    lastActivity: '3 min ago',
  },
  {
    id: '111',
    state: 'finished',
    teams: 'Oak Ridge B · Cedar Grove B',
    score: '240–225',
    progress: 'Complete',
    detail: 'Result received',
    lastActivity: '8 min ago',
  },
  {
    id: '112',
    state: 'live',
    teams: 'Fairview B · Eastside B',
    score: '175–165',
    progress: 'TU 15',
    detail: 'On pace',
    lastActivity: '1 min ago',
  },
];

const teams: Team[] = [
  { seed: 1, name: 'Northview A', school: 'Northview High', record: '5–0', points: 236, status: 'Confirmed' },
  {
    seed: 2,
    name: 'Riverside A',
    school: 'Riverside School',
    record: '4–1',
    points: 228,
    status: 'Confirmed',
  },
  {
    seed: 3,
    name: 'St. Mark’s',
    school: 'St. Mark’s Academy',
    record: '4–1',
    points: 221,
    status: 'Confirmed',
  },
  {
    seed: 4,
    name: 'Greenwood A',
    school: 'Greenwood School',
    record: '4–1',
    points: 214,
    status: 'Confirmed',
  },
  { seed: 5, name: 'Brookline A', school: 'Brookline High', record: '3–2', points: 208, status: 'Confirmed' },
  { seed: 6, name: 'Eastside A', school: 'Eastside Prep', record: '3–2', points: 199, status: 'Confirmed' },
  {
    seed: 7,
    name: 'Lakeside A',
    school: 'Lakeside Academy',
    record: '3–2',
    points: 194,
    status: 'Confirmed',
  },
  { seed: 8, name: 'Hamilton A', school: 'Hamilton School', record: '2–3', points: 183, status: 'Waitlist' },
  { seed: 9, name: 'Oak Ridge A', school: 'Oak Ridge High', record: '2–3', points: 177, status: 'Confirmed' },
  { seed: 10, name: 'Fairview', school: 'Fairview School', record: '1–4', points: 164, status: 'Dropped' },
];

const initialResults: ResultItem[] = [
  {
    id: 'result-104',
    room: 'Room 104',
    teams: 'Lakeside A · Greenwood B',
    score: '160–165',
    reason: 'Question ruling requested by scorekeeper',
    received: '4 min ago',
    severity: 'review',
  },
  {
    id: 'result-103',
    room: 'Room 103',
    teams: 'Riverside A · Westfield B',
    score: '310–245',
    reason: 'Roster amendment included with result',
    received: '3 min ago',
    severity: 'review',
  },
  {
    id: 'result-107',
    room: 'Room 107',
    teams: 'Brookline B · Fairview',
    score: '275–210',
    reason: 'Clean result',
    received: '5 min ago',
    severity: 'clean',
  },
];

function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };

  switch (name) {
    case 'activity':
      return (
        <svg {...common}>
          <path d="M3 12h4l2.2-6 4.2 12L16 12h5" />
        </svg>
      );
    case 'alert':
      return (
        <svg {...common}>
          <path d="M12 4 3.5 19h17L12 4Z" />
          <path d="M12 9v4" />
          <path d="M12 16h.01" />
        </svg>
      );
    case 'arrow':
      return (
        <svg {...common}>
          <path d="M4 12h15" />
          <path d="m13 6 6 6-6 6" />
        </svg>
      );
    case 'calendar':
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="15" rx="1.5" />
          <path d="M7 3.5v3M17 3.5v3M3.5 9h17" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="m5 12 4.2 4.2L19 6.5" />
        </svg>
      );
    case 'chevron':
      return (
        <svg {...common}>
          <path d="m9 5 7 7-7 7" />
        </svg>
      );
    case 'clipboard':
      return (
        <svg {...common}>
          <rect x="5" y="4.5" width="14" height="16" rx="1.5" />
          <path d="M9 4.5v-1h6v1M8.5 10h7M8.5 14h7M8.5 18h4" />
        </svg>
      );
    case 'download':
      return (
        <svg {...common}>
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M4 20h16" />
        </svg>
      );
    case 'file':
      return (
        <svg {...common}>
          <path d="M6 3.5h8l4 4V20.5H6z" />
          <path d="M14 3.5v4h4M8.5 12h7M8.5 16h7" />
        </svg>
      );
    case 'format':
      return (
        <svg {...common}>
          <path d="M5 5h14M5 12h9M5 19h6" />
          <circle cx="17" cy="12" r="2" />
          <circle cx="14" cy="19" r="2" />
        </svg>
      );
    case 'help':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.8 9a2.4 2.4 0 1 1 4 1.8c-1.3 1-1.8 1.4-1.8 3" />
          <path d="M12 17h.01" />
        </svg>
      );
    case 'inbox':
      return (
        <svg {...common}>
          <path d="M4 5h16v14H4z" />
          <path d="M4 14h4l1.4 2h5.2l1.4-2h4" />
        </svg>
      );
    case 'more':
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="1" fill="currentColor" />
          <circle cx="12" cy="12" r="1" fill="currentColor" />
          <circle cx="19" cy="12" r="1" fill="currentColor" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...common}>
          <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
          <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'play':
      return (
        <svg {...common}>
          <path d="m8 5 10 7-10 7z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'publish':
      return (
        <svg {...common}>
          <path d="M12 16V4" />
          <path d="m7 9 5-5 5 5" />
          <path d="M5 14v5h14v-5" />
        </svg>
      );
    case 'rooms':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="6" height="6" rx="1" />
          <rect x="14" y="4" width="6" height="6" rx="1" />
          <rect x="4" y="14" width="6" height="6" rx="1" />
          <rect x="14" y="14" width="6" height="6" rx="1" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="m15 15 5 5" />
        </svg>
      );
    case 'server':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="6" rx="1" />
          <rect x="4" y="14" width="16" height="6" rx="1" />
          <path d="M7 7h.01M7 17h.01M10 7h7M10 17h7" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="m19 13 .1-2-1.8-.7a6 6 0 0 0-.7-1.7l.8-1.7-1.5-1.5-1.7.8a6 6 0 0 0-1.7-.7L11.8 3h-2l-.7 1.8a6 6 0 0 0-1.7.7l-1.7-.8-1.5 1.5.8 1.7a6 6 0 0 0-.7 1.7l-1.8.7v2l1.8.7c.1.6.4 1.2.7 1.7l-.8 1.7 1.5 1.5 1.7-.8c.5.3 1.1.6 1.7.7l.7 1.8h2l.7-1.8c.6-.1 1.2-.4 1.7-.7l1.7.8 1.5-1.5-.8-1.7c.3-.5.6-1.1.7-1.7z" />
        </svg>
      );
    case 'standings':
      return (
        <svg {...common}>
          <path d="M5 19V9M12 19V5M19 19v-8" />
          <path d="M3 19h18" />
        </svg>
      );
    case 'teams':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 19c.4-3 2.2-4.5 5.5-4.5s5.1 1.5 5.5 4.5" />
          <path d="M15 5.5a3 3 0 0 1 0 5.8M17 14.7c2.1.6 3.2 2 3.5 4.3" />
        </svg>
      );
    case 'tournament':
      return (
        <svg {...common}>
          <path d="M5 4h14v4a7 7 0 0 1-14 0z" />
          <path d="M8 20h8M12 15v5M5 6H3v1a4 4 0 0 0 4 4M19 6h2v1a4 4 0 0 1-4 4" />
        </svg>
      );
    case 'users':
      return (
        <svg {...common}>
          <circle cx="8" cy="9" r="3" />
          <circle cx="17" cy="8" r="2.5" />
          <path d="M3.5 19c.3-3 1.8-4.5 4.5-4.5s4.2 1.5 4.5 4.5M14 14.5c2.8 0 4.3 1.5 4.5 4.5" />
        </svg>
      );
    default:
      return null;
  }
}

function Button({
  children,
  onClick,
  variant = 'secondary',
  icon,
  className = '',
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  icon?: IconName;
  className?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      className={`director-button director-button-${variant} ${className}`}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={15} />}
      <span>{children}</span>
    </button>
  );
}

function StateLabel({ state }: { state: RoomState }) {
  const labels: Record<RoomState, string> = {
    live: 'Live',
    finished: 'Finished',
    help: 'Help requested',
    waiting: 'Waiting',
  };
  return (
    <span className={`director-state director-state-${state}`}>
      <span className="director-state-dot" aria-hidden="true" />
      {labels[state]}
    </span>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="director-page-header">
      <div>
        {eyebrow && <p className="director-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="director-page-description">{description}</p>}
      </div>
      {actions && <div className="director-page-actions">{actions}</div>}
    </div>
  );
}

function SectionLink({
  section,
  active,
  onSelect,
  count,
}: {
  section: { id: SectionId; label: string; icon: IconName };
  active: boolean;
  onSelect: (section: SectionId) => void;
  count?: number;
}) {
  return (
    <button
      type="button"
      className={`director-nav-link ${active ? 'is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(section.id)}
    >
      <Icon name={section.icon} />
      <span>{section.label}</span>
      {count !== undefined && <span className="director-nav-count">{count}</span>}
    </button>
  );
}

function Overview({
  roundOpen,
  onToggleRound,
  onNavigate,
  onAnnounce,
}: {
  roundOpen: boolean;
  onToggleRound: () => void;
  onNavigate: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
}) {
  const needsAttention = rooms.filter((room) => room.state === 'help' || room.state === 'waiting');

  return (
    <>
      <PageHeader
        eyebrow="Tournament overview"
        title="Spring Invitational"
        description="Saturday, April 12 · Riverside High School · 24 teams"
        actions={
          <>
            <Button variant="secondary" icon="clipboard" onClick={() => onNavigate('tournament')}>
              Preflight
            </Button>
            <Button variant="primary" icon="arrow" onClick={() => onNavigate('tournament')}>
              Preview Round 7
            </Button>
          </>
        }
      />

      <section className="director-round-banner" aria-labelledby="current-round-title">
        <div className="director-round-heading">
          <div className="director-round-number">06</div>
          <div>
            <p className="director-eyebrow">Current round</p>
            <h2 id="current-round-title">Round 6 of 11</h2>
            <p>Started at 1:18 PM · ACF powers · packet C</p>
          </div>
        </div>
        <div className="director-round-summary" aria-label="Round summary">
          <span>
            <strong>8</strong> finished
          </span>
          <span>
            <strong>3</strong> playing
          </span>
          <span>
            <strong>1</strong> waiting
          </span>
        </div>
        <Button
          variant="secondary"
          icon={roundOpen ? 'pause' : 'play'}
          onClick={() => {
            onToggleRound();
            onAnnounce(roundOpen ? 'Round 6 placed on hold.' : 'Round 6 reopened.');
          }}
        >
          {roundOpen ? 'Hold round' : 'Reopen round'}
        </Button>
      </section>

      <div className="director-stat-strip" aria-label="Tournament status">
        <div className="director-stat">
          <span className="director-stat-label">Rooms live</span>
          <strong>
            11 <small>/ 12</small>
          </strong>
          <span className="director-stat-note">3 finished since 1:20</span>
        </div>
        <div className="director-stat director-stat-attention">
          <span className="director-stat-label">Needs attention</span>
          <strong>1</strong>
          <span className="director-stat-note">Room 104 · ruling</span>
        </div>
        <div className="director-stat">
          <span className="director-stat-label">Results to review</span>
          <strong>2</strong>
          <span className="director-stat-note">1 roster change</span>
        </div>
        <div className="director-stat director-stat-healthy">
          <span className="director-stat-label">Local backup</span>
          <strong>Healthy</strong>
          <span className="director-stat-note">Last saved 1 min ago</span>
        </div>
      </div>

      {needsAttention.length > 0 && (
        <section className="director-callout director-callout-warning" aria-label="Attention needed">
          <Icon name="alert" size={19} />
          <div>
            <strong>One room needs attention</strong>
            <p>Room 104 is waiting on a question ruling. Room 105 lost its scorer connection.</p>
          </div>
          <Button variant="quiet" onClick={() => onNavigate('rooms')}>
            View rooms
          </Button>
        </section>
      )}

      <div className="director-overview-grid">
        <section className="director-panel director-panel-rooms" aria-labelledby="rooms-now-heading">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Live operations</p>
              <h2 id="rooms-now-heading">Rooms now</h2>
            </div>
            <button type="button" className="director-text-button" onClick={() => onNavigate('rooms')}>
              All rooms <Icon name="arrow" size={14} />
            </button>
          </div>
          <div className="director-room-table director-room-table-compact">
            {rooms.slice(0, 6).map((room) => (
              <button
                type="button"
                className="director-room-row"
                key={room.id}
                onClick={() => onNavigate('rooms')}
                aria-label={`Room ${room.id}, ${room.teams}, ${room.progress}, ${room.detail}`}
              >
                <span className="director-room-id">{room.id}</span>
                <span className="director-room-matchup">
                  <strong>{room.teams}</strong>
                  <small>
                    {room.detail} · {room.lastActivity}
                  </small>
                </span>
                <span className="director-room-progress">{room.progress}</span>
                <span className="director-room-score">{room.score}</span>
                <StateLabel state={room.state} />
              </button>
            ))}
          </div>
        </section>

        <aside className="director-side-stack">
          <section className="director-panel director-next-panel" aria-labelledby="next-round-heading">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Up next</p>
                <h2 id="next-round-heading">Round 7</h2>
              </div>
              <span className="director-tag director-tag-ready">Ready</span>
            </div>
            <dl className="director-detail-list">
              <div>
                <dt>Assignments</dt>
                <dd>12 games</dd>
              </div>
              <div>
                <dt>Packet</dt>
                <dd>Packet D</dd>
              </div>
              <div>
                <dt>First room</dt>
                <dd>~ 18 min</dd>
              </div>
            </dl>
            <button type="button" className="director-panel-link" onClick={() => onNavigate('tournament')}>
              Review assignments <Icon name="chevron" size={14} />
            </button>
          </section>

          <section className="director-panel director-activity-panel" aria-labelledby="activity-heading">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Audit trail</p>
                <h2 id="activity-heading">Recent activity</h2>
              </div>
              <button
                type="button"
                className="director-icon-button"
                title="More activity"
                aria-label="More activity"
                onClick={() => onAnnounce('Recent activity opened.')}
              >
                <Icon name="more" />
              </button>
            </div>
            <ol className="director-activity-list">
              <li>
                <time>1:25 PM</time>
                <span>Room 103 result received</span>
              </li>
              <li>
                <time>1:23 PM</time>
                <span>Room 104 requested a ruling</span>
              </li>
              <li>
                <time>1:20 PM</time>
                <span>Round 6 opened</span>
              </li>
              <li>
                <time>1:14 PM</time>
                <span>Round 7 assignments generated</span>
              </li>
            </ol>
          </section>
        </aside>
      </div>
    </>
  );
}

function TeamsView({ search, onAnnounce }: { search: string; onAnnounce: (message: string) => void }) {
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query === ''
      ? teams
      : teams.filter((team) => `${team.name} ${team.school}`.toLowerCase().includes(query));
  }, [search]);

  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="Teams"
        description="24 teams registered · 22 confirmed · 1 waitlist · 1 dropped"
        actions={
          <>
            <Button variant="secondary" icon="download" onClick={() => onAnnounce('Team import opened.')}>
              Import
            </Button>
            <Button variant="primary" icon="teams" onClick={() => onAnnounce('New team form opened.')}>
              Add team
            </Button>
          </>
        }
      />
      <div className="director-toolbar">
        <div className="director-inline-tabs" role="tablist" aria-label="Team views">
          <button type="button" className="is-active" role="tab" aria-selected="true">
            All teams <span>24</span>
          </button>
          <button type="button" role="tab" aria-selected="false">
            Needs review <span>2</span>
          </button>
          <button type="button" role="tab" aria-selected="false">
            Dropped <span>1</span>
          </button>
        </div>
        <Button variant="quiet" icon="clipboard" onClick={() => onAnnounce('Roster paste area opened.')}>
          Paste roster
        </Button>
      </div>
      <section className="director-panel director-table-panel" aria-labelledby="team-list-heading">
        <div className="director-panel-heading">
          <div>
            <h2 id="team-list-heading">Registered teams</h2>
            <p>Seed order can be changed until Round 1 is released.</p>
          </div>
          <span className="director-muted">Showing {filtered.length} of 24</span>
        </div>
        <div className="director-table-scroll">
          <table className="director-data-table">
            <thead>
              <tr>
                <th scope="col">Seed</th>
                <th scope="col">Team</th>
                <th scope="col">School</th>
                <th scope="col">Record</th>
                <th scope="col">PPG</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((team) => (
                <tr key={team.name}>
                  <td className="director-number-cell">{team.seed}</td>
                  <th scope="row">
                    <strong>{team.name}</strong>
                    <small>4 players · captain listed</small>
                  </th>
                  <td>{team.school}</td>
                  <td>{team.record}</td>
                  <td>{team.points}</td>
                  <td>
                    <span className={`director-tag director-tag-${team.status.toLowerCase()}`}>
                      {team.status}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="director-icon-button"
                      title={`More actions for ${team.name}`}
                      aria-label={`More actions for ${team.name}`}
                      onClick={() => onAnnounce(`More actions for ${team.name}.`)}
                    >
                      <Icon name="more" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function FormatView({
  onNavigate,
  onAnnounce,
}: {
  onNavigate: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="Format"
        description="ACF standard · 24 teams · 11 rounds · 12 rooms"
        actions={
          <Button variant="primary" icon="format" onClick={() => onAnnounce('Format editor opened.')}>
            Edit format
          </Button>
        }
      />
      <section className="director-format-intro">
        <div>
          <span className="director-tag director-tag-ready">Recommended</span>
          <h2>Preliminary pools → playoff pools → final</h2>
          <p>A practical 24-team format with five preliminary rounds, a rebracket, and six playoff rounds.</p>
        </div>
        <Button variant="secondary" onClick={() => onNavigate('tournament')}>
          See schedule impact <Icon name="arrow" size={14} />
        </Button>
      </section>
      <div className="director-two-column">
        <section className="director-panel" aria-labelledby="format-flow-heading">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Tournament path</p>
              <h2 id="format-flow-heading">Phases</h2>
            </div>
            <span className="director-muted">Editable</span>
          </div>
          <ol className="director-phase-list">
            <li className="is-current">
              <span className="director-phase-marker">1</span>
              <div>
                <strong>Preliminaries</strong>
                <small>Rounds 1–6 · 24 teams · 144 games</small>
              </div>
              <span className="director-tag director-tag-live">In progress</span>
            </li>
            <li>
              <span className="director-phase-marker">2</span>
              <div>
                <strong>Playoff pools</strong>
                <small>Rounds 7–10 · 3 pools of 8 · carryovers on</small>
              </div>
              <span className="director-muted">Next</span>
            </li>
            <li>
              <span className="director-phase-marker">3</span>
              <div>
                <strong>Championship</strong>
                <small>Round 11 · top 2 teams · one final</small>
              </div>
              <span className="director-muted">Later</span>
            </li>
          </ol>
        </section>
        <section className="director-panel" aria-labelledby="format-settings-heading">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Rules</p>
              <h2 id="format-settings-heading">Scoring setup</h2>
            </div>
          </div>
          <dl className="director-detail-list director-detail-list-large">
            <div>
              <dt>Question set</dt>
              <dd>ACF Fall 2025</dd>
            </div>
            <div>
              <dt>Scoring</dt>
              <dd>10 / -5 powers</dd>
            </div>
            <div>
              <dt>Bonuses</dt>
              <dd>30 points · bouncebacks on</dd>
            </div>
            <div>
              <dt>Game length</dt>
              <dd>20 tossups</dd>
            </div>
          </dl>
          <button
            type="button"
            className="director-panel-link"
            onClick={() => onAnnounce('Advanced scoring rules opened.')}
          >
            Advanced rules <Icon name="chevron" size={14} />
          </button>
        </section>
      </div>
      <section className="director-callout director-callout-info">
        <Icon name="help" size={19} />
        <div>
          <strong>Why this format?</strong>
          <p>
            It keeps every team on a predictable six-game preliminary schedule and uses the 12 available rooms
            efficiently.
          </p>
        </div>
        <button
          type="button"
          className="director-text-button"
          onClick={() => onAnnounce('Format priorities opened.')}
        >
          Change priorities <Icon name="arrow" size={14} />
        </button>
      </section>
    </>
  );
}

function RoomsView({ onAnnounce }: { onAnnounce: (message: string) => void }) {
  const [filter, setFilter] = useState<'all' | RoomState>('all');
  const visibleRooms = filter === 'all' ? rooms : rooms.filter((room) => room.state === filter);
  return (
    <>
      <PageHeader
        eyebrow="Plan · Run"
        title="Rooms & staff"
        description="12 rooms · 18 moderators · 12 scorekeepers · server running"
        actions={
          <Button variant="primary" icon="rooms" onClick={() => onAnnounce('New room form opened.')}>
            Add room
          </Button>
        }
      />
      <div className="director-stat-strip director-stat-strip-small">
        <div className="director-stat">
          <span className="director-stat-label">Connected</span>
          <strong>
            11 <small>/ 12</small>
          </strong>
        </div>
        <div className="director-stat director-stat-healthy">
          <span className="director-stat-label">Staff coverage</span>
          <strong>Complete</strong>
        </div>
        <div className="director-stat">
          <span className="director-stat-label">Equipment</span>
          <strong>
            12 <small>/ 12</small>
          </strong>
        </div>
        <div className="director-stat director-stat-attention">
          <span className="director-stat-label">Open requests</span>
          <strong>1</strong>
        </div>
      </div>
      <section className="director-panel director-table-panel" aria-labelledby="all-rooms-heading">
        <div className="director-panel-heading">
          <div>
            <h2 id="all-rooms-heading">Room status</h2>
            <p>Live connection and assignment state.</p>
          </div>
          <div className="director-filter-tabs" role="tablist" aria-label="Room status filters">
            {(['all', 'live', 'finished', 'help', 'waiting'] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={filter === item ? 'is-active' : ''}
                onClick={() => setFilter(item)}
                role="tab"
                aria-selected={filter === item}
              >
                {item === 'all' ? 'All' : item === 'help' ? 'Help' : item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="director-table-scroll">
          <table className="director-data-table director-room-data-table">
            <thead>
              <tr>
                <th scope="col">Room</th>
                <th scope="col">Assignment</th>
                <th scope="col">Progress</th>
                <th scope="col">Score</th>
                <th scope="col">Last activity</th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="visually-hidden">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRooms.map((room) => (
                <tr key={room.id}>
                  <th scope="row">
                    <strong>Room {room.id}</strong>
                    <small>Moderator {Number(room.id) - 96}</small>
                  </th>
                  <td>{room.teams}</td>
                  <td>{room.progress}</td>
                  <td>{room.score}</td>
                  <td>{room.lastActivity}</td>
                  <td>
                    <StateLabel state={room.state} />
                  </td>
                  <td>
                    <Button variant="quiet" onClick={() => onAnnounce(`Room ${room.id} selected.`)}>
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function PacketsView({ onAnnounce }: { onAnnounce: (message: string) => void }) {
  const packets = [
    ['Packet A', 'Rounds 1–2', '24 / 24', 'Used'],
    ['Packet B', 'Rounds 3–4', '24 / 24', 'Used'],
    ['Packet C', 'Rounds 5–6', '18 / 24', 'In use'],
    ['Packet D', 'Round 7', '0 / 24', 'Ready'],
    ['Packet E', 'Rounds 8–9', '0 / 24', 'Ready'],
    ['Tiebreaker 1', 'As needed', '0 / 3', 'Available'],
  ];
  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="Packets"
        description="15 packets inventoried · 1 packet in use · no conflicts"
        actions={
          <>
            <Button variant="secondary" icon="download" onClick={() => onAnnounce('Packet import opened.')}>
              Import packets
            </Button>
            <Button variant="primary" icon="file" onClick={() => onAnnounce('New packet form opened.')}>
              Add packet
            </Button>
          </>
        }
      />
      <section className="director-panel director-table-panel" aria-labelledby="packet-inventory-heading">
        <div className="director-panel-heading">
          <div>
            <h2 id="packet-inventory-heading">Packet inventory</h2>
            <p>Packets are tracked independently from round numbers.</p>
          </div>
          <span className="director-tag director-tag-ready">No conflicts</span>
        </div>
        <div className="director-table-scroll">
          <table className="director-data-table">
            <thead>
              <tr>
                <th scope="col">Packet</th>
                <th scope="col">Assigned to</th>
                <th scope="col">Games</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {packets.map(([name, assigned, games, status]) => (
                <tr key={name}>
                  <th scope="row">
                    <strong>{name}</strong>
                  </th>
                  <td>{assigned}</td>
                  <td>{games}</td>
                  <td>
                    <span className={`director-tag director-tag-${status.toLowerCase().replace(' ', '-')}`}>
                      {status}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="director-icon-button"
                      title={`More actions for ${name}`}
                      aria-label={`More actions for ${name}`}
                      onClick={() => onAnnounce(`More actions for ${name}.`)}
                    >
                      <Icon name="more" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="director-callout director-callout-info">
        <Icon name="help" size={19} />
        <div>
          <strong>Packet protection is on</strong>
          <p>
            Director will warn before a packet is reused in the same phase or assigned to a room with
            known-team exposure.
          </p>
        </div>
      </section>
    </>
  );
}

function TournamentView({ onAnnounce }: { onAnnounce: (message: string) => void }) {
  const checks = [
    ['Teams and rosters', '24 teams confirmed · no duplicates', 'pass'],
    ['Rooms and staff', '12 rooms covered · 1 scorer reconnecting', 'warn'],
    ['Schedule', 'Round 7 has 12 valid assignments', 'pass'],
    ['Packets', 'Packet D available for all rooms', 'pass'],
    ['Backups', 'Local archive saved 1 min ago', 'pass'],
  ] as const;
  return (
    <>
      <PageHeader
        eyebrow="Run"
        title="Tournament control"
        description="Round 6 is in progress · server is available on the local network"
        actions={
          <Button variant="primary" icon="server">
            Server details
          </Button>
        }
      />
      <section className="director-control-banner">
        <div>
          <span className="director-server-indicator">
            <span /> QBTCP server running
          </span>
          <h2>Round 7 is ready to open</h2>
          <p>All assignments are valid. Review the one room that needs reconnection before releasing.</p>
        </div>
        <div className="director-control-actions">
          <Button variant="secondary" onClick={() => onAnnounce('Round 7 assignment preview opened.')}>
            Preview assignments
          </Button>
          <Button
            variant="primary"
            icon="play"
            onClick={() => onAnnounce('Round 7 is queued to open when Round 6 is complete.')}
          >
            Open when ready
          </Button>
        </div>
      </section>
      <div className="director-two-column director-two-column-wide">
        <section className="director-panel" aria-labelledby="preflight-heading">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Before the next round</p>
              <h2 id="preflight-heading">Preflight</h2>
            </div>
            <span className="director-tag director-tag-ready">5 checks</span>
          </div>
          <ul className="director-check-list">
            {checks.map(([title, detail, state]) => (
              <li key={title}>
                <span className={`director-check-icon director-check-${state}`}>
                  <Icon name={state === 'pass' ? 'check' : 'alert'} size={14} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </div>
                {state === 'warn' && (
                  <Button variant="quiet" onClick={() => onAnnounce('Room 105 reconnection details opened.')}>
                    Review
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="director-panel" aria-labelledby="round-sequence-heading">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Round sequence</p>
              <h2 id="round-sequence-heading">Today</h2>
            </div>
          </div>
          <ol className="director-round-list">
            <li className="is-complete">
              <span>01</span>
              <div>
                <strong>Rounds 1–5</strong>
                <small>Complete · 120 results</small>
              </div>
              <Icon name="check" size={16} />
            </li>
            <li className="is-current">
              <span>02</span>
              <div>
                <strong>Round 6</strong>
                <small>In progress · 8 of 12 finished</small>
              </div>
              <Icon name="activity" size={16} />
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Round 7</strong>
                <small>Ready · 12 assignments</small>
              </div>
              <Icon name="chevron" size={16} />
            </li>
            <li>
              <span>04</span>
              <div>
                <strong>Rounds 8–11</strong>
                <small>Scheduled · playoff pools</small>
              </div>
              <Icon name="chevron" size={16} />
            </li>
          </ol>
        </section>
      </div>
    </>
  );
}

function ResultsView({
  inbox,
  onResolve,
  onAnnounce,
  onAcceptClean,
}: {
  inbox: ResultItem[];
  onResolve: (id: string, action: string) => void;
  onAnnounce: (message: string) => void;
  onAcceptClean: () => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="Run"
        title="Results inbox"
        description={`${inbox.length} results waiting · clean results can be accepted without interruption`}
        actions={
          <Button variant="secondary" icon="check" onClick={onAcceptClean}>
            Accept clean results
          </Button>
        }
      />
      <div className="director-inbox-summary">
        <div>
          <strong>{inbox.filter((item) => item.severity === 'review').length}</strong>
          <span>Need review</span>
        </div>
        <div>
          <strong>{inbox.filter((item) => item.severity === 'clean').length}</strong>
          <span>Ready to accept</span>
        </div>
        <div>
          <strong>0</strong>
          <span>Conflicts</span>
        </div>
        <div>
          <strong>All</strong>
          <span>Originals preserved</span>
        </div>
      </div>
      <section className="director-panel director-table-panel" aria-labelledby="inbox-heading">
        <div className="director-panel-heading">
          <div>
            <h2 id="inbox-heading">Incoming results</h2>
            <p>Submissions remain immutable when a correction is made.</p>
          </div>
          <div className="director-inline-tabs">
            <button type="button" className="is-active">
              All
            </button>
            <button type="button">Needs review</button>
          </div>
        </div>
        <div className="director-result-list">
          {inbox.length === 0 ? (
            <div className="director-empty-state">
              <Icon name="check" size={22} />
              <strong>Inbox clear</strong>
              <p>New results will appear here as rooms finish.</p>
            </div>
          ) : (
            inbox.map((item) => (
              <article className="director-result-row" key={item.id}>
                <div className={`director-result-mark ${item.severity}`}>
                  <Icon name={item.severity === 'review' ? 'alert' : 'check'} size={16} />
                </div>
                <div className="director-result-main">
                  <div className="director-result-title">
                    <strong>{item.room}</strong>
                    <span>{item.received}</span>
                  </div>
                  <p>
                    {item.teams} <b>{item.score}</b>
                  </p>
                  <small>{item.reason}</small>
                </div>
                <div className="director-result-actions">
                  {item.severity === 'review' ? (
                    <>
                      <Button variant="secondary" onClick={() => onResolve(item.id, 'review opened')}>
                        Review
                      </Button>
                      <button
                        type="button"
                        className="director-icon-button"
                        title="More result actions"
                        aria-label={`More actions for ${item.room}`}
                        onClick={() => onAnnounce(`More actions for ${item.room}.`)}
                      >
                        <Icon name="more" />
                      </button>
                    </>
                  ) : (
                    <Button variant="quiet" onClick={() => onResolve(item.id, 'accepted')}>
                      Accept
                    </Button>
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </>
  );
}

function StandingsView({ onAnnounce }: { onAnnounce: (message: string) => void }) {
  return (
    <>
      <PageHeader
        eyebrow="Review"
        title="Standings & stats"
        description="Live through Round 5 · rankings update as results are accepted"
        actions={
          <Button variant="secondary" icon="download" onClick={() => onAnnounce('Stats export started.')}>
            Export stats
          </Button>
        }
      />
      <div className="director-standings-tabs">
        <button type="button" className="is-active">
          Overall
        </button>
        <button type="button">Preliminaries</button>
        <button type="button">Playoff pools</button>
        <button type="button">Players</button>
      </div>
      <section className="director-panel director-table-panel" aria-labelledby="standings-heading">
        <div className="director-panel-heading">
          <div>
            <h2 id="standings-heading">Overall standings</h2>
            <p>Record, points per game, and margin through completed games.</p>
          </div>
          <span className="director-muted">Updated 1:25 PM</span>
        </div>
        <div className="director-table-scroll">
          <table className="director-data-table director-standings-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Team</th>
                <th scope="col">Record</th>
                <th scope="col">PPG</th>
                <th scope="col">PAPG</th>
                <th scope="col">Powers</th>
                <th scope="col">PPB</th>
                <th scope="col">Games</th>
              </tr>
            </thead>
            <tbody>
              {teams.slice(0, 8).map((team, index) => (
                <tr key={team.name}>
                  <td className="director-number-cell director-rank-cell">{index + 1}</td>
                  <th scope="row">
                    <strong>{team.name}</strong>
                    <small>{team.school}</small>
                  </th>
                  <td>{team.record}</td>
                  <td>{team.points}</td>
                  <td>{team.points - 8}</td>
                  <td>{12 - index}</td>
                  <td>{21 - Math.floor(index / 2)}</td>
                  <td>5</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function PublishView({ onAnnounce }: { onAnnounce: (message: string) => void }) {
  const reports = [
    ['Live standings', 'In app · updates automatically', 'Open'],
    ['Static HTML stats', 'Generated locally · 1:22 PM', 'Regenerate'],
    ['Printable schedules', 'PDF · 12 rooms · 1:10 PM', 'Export'],
    ['Team reports', 'PDF · 24 teams · not generated', 'Generate'],
  ];
  return (
    <>
      <PageHeader
        eyebrow="Review"
        title="Publish"
        description="Create clean reports locally when you are ready to share them"
        actions={
          <Button
            variant="primary"
            icon="publish"
            onClick={() => onAnnounce('All current reports regenerated locally.')}
          >
            Regenerate reports
          </Button>
        }
      />
      <section className="director-publish-note">
        <Icon name="server" size={19} />
        <div>
          <strong>Local publishing</strong>
          <p>Reports are generated on this computer. No account or internet connection is required.</p>
        </div>
      </section>
      <section className="director-panel director-table-panel" aria-labelledby="reports-heading">
        <div className="director-panel-heading">
          <div>
            <h2 id="reports-heading">Reports</h2>
            <p>Each report includes the latest accepted results.</p>
          </div>
        </div>
        <ul className="director-publish-list">
          {reports.map(([title, detail, action]) => (
            <li key={title}>
              <div className="director-publish-icon">
                <Icon name={title === 'Live standings' ? 'standings' : 'file'} size={17} />
              </div>
              <div>
                <strong>{title}</strong>
                <small>{detail}</small>
              </div>
              <Button
                variant={action === 'Open' ? 'quiet' : 'secondary'}
                onClick={() => onAnnounce(`${title}: ${action.toLowerCase()} selected.`)}
              >
                {action}
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <section className="director-panel director-archive-panel">
        <div>
          <p className="director-eyebrow">Tournament archive</p>
          <h2>Spring Invitational.qbs</h2>
          <p>Portable archive · 48 MB · saved 1 min ago</p>
        </div>
        <Button
          variant="secondary"
          icon="download"
          onClick={() => onAnnounce('Tournament archive export started.')}
        >
          Export archive
        </Button>
      </section>
    </>
  );
}

function SettingsView({ onAnnounce }: { onAnnounce: (message: string) => void }) {
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        description="Local tournament storage, server, and operator preferences"
      />
      <div className="director-settings-list">
        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Tournament</p>
              <h2>Spring Invitational</h2>
            </div>
            <Button variant="secondary" onClick={() => onAnnounce('Tournament details editor opened.')}>
              Edit details
            </Button>
          </div>
          <dl className="director-detail-list director-detail-list-large">
            <div>
              <dt>Location</dt>
              <dd>Riverside High School</dd>
            </div>
            <div>
              <dt>Question set</dt>
              <dd>ACF Fall 2025</dd>
            </div>
            <div>
              <dt>Time zone</dt>
              <dd>America/New_York</dd>
            </div>
          </dl>
        </section>
        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">QBTCP server</p>
              <h2>Local network</h2>
            </div>
            <span className="director-server-indicator">
              <span /> Running
            </span>
          </div>
          <dl className="director-detail-list director-detail-list-large">
            <div>
              <dt>Address</dt>
              <dd className="director-mono">192.168.1.50:8080</dd>
            </div>
            <div>
              <dt>Paired rooms</dt>
              <dd>11 of 12</dd>
            </div>
            <div>
              <dt>Protocol</dt>
              <dd>QBTCP v1</dd>
            </div>
          </dl>
          <button
            type="button"
            className="director-panel-link"
            onClick={() => onAnnounce('Connection details opened.')}
          >
            Connection details <Icon name="chevron" size={14} />
          </button>
        </section>
        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Data protection</p>
              <h2>Recovery</h2>
            </div>
            <span className="director-tag director-tag-ready">Healthy</span>
          </div>
          <div className="director-setting-row">
            <div>
              <strong>Automatic checkpoints</strong>
              <small>Before schedule changes, imports, and phase transitions.</small>
            </div>
            <span className="director-switch is-on" aria-label="Automatic checkpoints enabled">
              <span />
            </span>
          </div>
          <div className="director-setting-row">
            <div>
              <strong>External backup folder</strong>
              <small>Not configured. The local archive remains protected.</small>
            </div>
            <Button variant="secondary" onClick={() => onAnnounce('Backup folder chooser opened.')}>
              Choose folder
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}

export default function DirectorApp() {
  const [activeSection, setActiveSection] = useState<SectionId>('overview');
  const [roundOpen, setRoundOpen] = useState(true);
  const [search, setSearch] = useState('');
  const [inbox, setInbox] = useState<ResultItem[]>(initialResults);
  const [announcement, setAnnouncement] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  const announce = (message: string) => setAnnouncement(message);
  const navigate = (section: SectionId) => {
    setActiveSection(section);
    setAnnouncement('');
  };

  const pageTitle =
    navigation.flatMap((group) => group.items).find((item) => item.id === activeSection)?.label ?? 'Overview';
  const resultReviewCount = inbox.filter((item) => item.severity === 'review').length;

  const resolveResult = (id: string, action: string) => {
    const result = inbox.find((item) => item.id === id);
    if (!result) return;
    setInbox((current) => current.filter((item) => item.id !== id));
    announce(`${result.room} ${action}.`);
  };

  const renderPage = () => {
    switch (activeSection) {
      case 'overview':
        return (
          <Overview
            roundOpen={roundOpen}
            onToggleRound={() => setRoundOpen((open) => !open)}
            onNavigate={navigate}
            onAnnounce={announce}
          />
        );
      case 'teams':
        return <TeamsView search={search} onAnnounce={announce} />;
      case 'format':
        return <FormatView onNavigate={navigate} onAnnounce={announce} />;
      case 'rooms':
        return <RoomsView onAnnounce={announce} />;
      case 'packets':
        return <PacketsView onAnnounce={announce} />;
      case 'tournament':
        return <TournamentView onAnnounce={announce} />;
      case 'results':
        return (
          <ResultsView
            inbox={inbox}
            onResolve={resolveResult}
            onAnnounce={announce}
            onAcceptClean={() => {
              const cleanCount = inbox.filter((item) => item.severity === 'clean').length;
              setInbox((current) => current.filter((item) => item.severity !== 'clean'));
              announce(
                cleanCount === 0
                  ? 'There are no clean results to accept.'
                  : `${cleanCount} clean result${cleanCount === 1 ? '' : 's'} accepted.`,
              );
            }}
          />
        );
      case 'standings':
        return <StandingsView onAnnounce={announce} />;
      case 'publish':
        return <PublishView onAnnounce={announce} />;
      case 'settings':
        return <SettingsView onAnnounce={announce} />;
      default:
        return null;
    }
  };

  return (
    <div className="director-app">
      <aside className="director-sidebar">
        <div className="director-brand">
          <BrandLogo className="director-wordmark" />
          <span>Director</span>
        </div>
        <div className="director-tournament-switcher">
          <span className="director-tournament-overline">Tournament</span>
          <strong>Spring Invitational</strong>
          <span>Round 6 · In progress</span>
          <Icon name="chevron" size={14} />
        </div>
        <nav className="director-nav" aria-label="Tournament sections">
          {navigation.map((group, index) => (
            <div className="director-nav-group" key={group.label ?? `primary-${index}`}>
              {group.label && <p className="director-nav-label">{group.label}</p>}
              {group.items.map((item) => (
                <SectionLink
                  key={item.id}
                  section={item}
                  active={item.id === activeSection}
                  onSelect={navigate}
                  count={item.id === 'results' ? resultReviewCount : undefined}
                />
              ))}
            </div>
          ))}
        </nav>
        <div className="director-sidebar-footer">
          <div className="director-server-status">
            <span className="director-server-dot" />
            <div>
              <strong>Server running</strong>
              <small>11 rooms connected</small>
            </div>
          </div>
          <button
            type="button"
            className="director-help-link"
            onClick={() => announce('Help center opened.')}
          >
            <Icon name="help" size={15} /> Help & keyboard shortcuts
          </button>
          <div className="director-operator">
            <span className="director-avatar">GB</span>
            <div>
              <strong>Gibson Bell</strong>
              <small>Tournament director</small>
            </div>
            <Icon name="more" size={16} />
          </div>
        </div>
      </aside>

      <main className="director-main">
        <header className="director-topbar">
          <div className="director-breadcrumb">
            <span>Spring Invitational</span>
            <Icon name="chevron" size={13} />
            <strong>{pageTitle}</strong>
          </div>
          <div className="director-topbar-actions">
            <label className="director-search">
              <Icon name="search" size={16} />
              <span className="visually-hidden">Search tournament</span>
              <input
                ref={searchRef}
                type="search"
                placeholder="Search teams, rooms, games"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <kbd>⌘ K</kbd>
            </label>
            <button
              type="button"
              className="director-icon-button director-topbar-button"
              title="Help"
              aria-label="Help"
              onClick={() => announce('Help center opened.')}
            >
              <Icon name="help" />
            </button>
            <button
              type="button"
              className="director-avatar director-avatar-top"
              title="Operator menu"
              aria-label="Operator menu"
            >
              GB
            </button>
          </div>
        </header>
        <div className="director-content">{renderPage()}</div>
        {announcement && (
          <div className="director-toast" role="status">
            <Icon name="check" size={16} />
            <span>{announcement}</span>
            <button type="button" aria-label="Dismiss notification" onClick={() => setAnnouncement('')}>
              ×
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
