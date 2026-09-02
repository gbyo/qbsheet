/**
 * QBSheet Live Web.
 *
 * Bootstraps from the URL, loads the tournament directly from *its* backend, and renders five tabs.
 * `live.qbsheet.com` serves this file and the Apple association files, and nothing else: the
 * tournament's data never passes through it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseBootstrapUrl, QbliveBootstrapError, QbliveClient } from '@qbsheet/qblive-protocol';
import { Icon, type IconName } from './components/Icon';
import { Home } from './views/Home';
import { Schedule } from './views/Schedule';
import { Standings, Stats } from './views/Tables';
import { Updates } from './views/Updates';
import { FollowTeam, Problem, SelectPlayer } from './views/Onboarding';
import {
  LiveConnection,
  readCache,
  readLastPublication,
  rememberLastPublication,
  writeCache,
  type ConnectionState,
  type LiveWebState,
} from './state/store';
import { formatAge } from './state/format';
import { publishesPlayers } from './state/derive';

type TabId = 'home' | 'schedule' | 'standings' | 'stats' | 'updates';

const tabs: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'schedule', label: 'Schedule', icon: 'schedule' },
  { id: 'standings', label: 'Standings', icon: 'standings' },
  { id: 'stats', label: 'Stats', icon: 'stats' },
  { id: 'updates', label: 'Updates', icon: 'updates' },
];

const emptyState: LiveWebState = {
  publicationId: null,
  backendOrigin: null,
  snapshot: null,
  manifest: null,
  followedTeamId: null,
  selectedPlayerId: null,
  connection: 'loading',
  receivedAt: null,
  error: null,
};

/**
 * Resolve the bootstrap from the address bar, falling back to the last tournament this device saw
 * only for a bare visit (no tournament bootstrap attempt). A URL that clearly tries to name a
 * tournament but is malformed must show an error for that link, not silently open another
 * tournament.
 *
 * The fallback matters for the notification case: a tap that reopens the app does not always carry
 * the original invocation URL, and reopening on a blank screen would be the wrong answer.
 */
function resolveBootstrap(
  href: string,
): { publicationId: string; backendOrigin: string } | { error: string } {
  let hasBootstrapAttempt = false;
  try {
    hasBootstrapAttempt = hasBootstrapAttemptInUrl(href);
  } catch {
    // If href is not parseable, treat it as an attempt - do not fallback.
    hasBootstrapAttempt = true;
  }
  try {
    const bootstrap = parseBootstrapUrl(href);
    return { publicationId: bootstrap.publicationId, backendOrigin: bootstrap.backendOrigin };
  } catch (reason) {
    if (!hasBootstrapAttempt) {
      const last = readLastPublication();
      if (last) return last;
    }
    return {
      error:
        reason instanceof QbliveBootstrapError
          ? reason.message
          : 'That link does not name a QBSheet Live tournament.',
    };
  }
}

function hasBootstrapAttemptInUrl(href: string): boolean {
  const url = new URL(href, window.location.origin);
  if (/^\/t(\/|$)/.test(url.pathname)) return true;
  if (url.searchParams.has('b') || url.searchParams.has('v')) return true;
  return false;
}

export default function App() {
  /**
   * The bootstrap is resolved once, during the first render, rather than in an effect.
   *
   * It is a pure function of the address bar and cannot change while the page is open, so an effect
   * that computed it would only be a way to render an empty screen first and then correct it.
   */
  const [bootstrap] = useState(() => resolveBootstrap(window.location.href));
  const [state, setState] = useState<LiveWebState>(() => {
    if ('error' in bootstrap) return { ...emptyState, connection: 'error', error: bootstrap.error };
    const cached = readCache(bootstrap.publicationId);
    return {
      ...emptyState,
      ...cached,
      publicationId: bootstrap.publicationId,
      backendOrigin: bootstrap.backendOrigin,
      connection: cached?.snapshot ? 'offline' : 'loading',
    };
  });
  const [tab, setTab] = useState<TabId>('home');
  const [choosingPlayer, setChoosingPlayer] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const connectionRef = useRef<LiveConnection | null>(null);

  // A ticking clock, so "Last updated 6 minutes ago" and "next event" stay honest without a reload.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if ('error' in bootstrap) return;
    const { publicationId, backendOrigin } = bootstrap;
    rememberLastPublication(publicationId, backendOrigin);
    const cached = readCache(publicationId);

    const client = new QbliveClient({ backendOrigin, publicationId });
    const connection = new LiveConnection(client, {
      onSnapshot: (snapshot) =>
        setState((previous) => {
          const next: LiveWebState = {
            ...previous,
            snapshot,
            receivedAt: Date.now(),
            connection: previous.connection === 'live' ? 'live' : 'polling',
            error: null,
            // A followed team that is no longer in the tournament is dropped rather than left
            // pointing at nothing: teams do withdraw, and a Home tab about a missing team is worse
            // than being asked to choose again.
            followedTeamId:
              previous.followedTeamId && snapshot.teams.some((team) => team.id === previous.followedTeamId)
                ? previous.followedTeamId
                : null,
          };
          writeCache(next);
          return next;
        }),
      onConnection: (connectionState: ConnectionState, error?: string) =>
        setState((previous) => ({
          ...previous,
          connection: connectionState,
          error: error ?? (connectionState === 'error' ? previous.error : null),
        })),
    });
    connectionRef.current = connection;
    void connection.start(cached?.snapshot ?? null);

    // Coming back to a backgrounded tab should show current data, not whatever it had on the way out.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void connection.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      connection.stop();
      connectionRef.current = null;
    };
  }, [bootstrap]);

  const follow = useCallback((teamId: string) => {
    setState((previous) => {
      const next = { ...previous, followedTeamId: teamId };
      writeCache(next);
      return next;
    });
    setChoosingPlayer(true);
  }, []);

  const selectPlayer = useCallback((playerId: string | null) => {
    setState((previous) => {
      const next = { ...previous, selectedPlayerId: playerId };
      writeCache(next);
      return next;
    });
    setChoosingPlayer(false);
  }, []);

  const refresh = useCallback(() => void connectionRef.current?.refresh(), []);

  const stale = state.connection === 'offline' || state.connection === 'polling';
  const age = useMemo(() => formatAge(state.receivedAt, now.getTime()), [state.receivedAt, now]);

  if (state.connection === 'error' && !state.snapshot) {
    return <Problem title="This link did not open a tournament" detail={state.error ?? 'Unknown problem.'} />;
  }
  if (!state.snapshot) {
    return (
      <div className="gate">
        <h1>Loading…</h1>
        <p className="lede">Fetching the tournament.</p>
      </div>
    );
  }
  const snapshot = state.snapshot;

  if (!state.followedTeamId) {
    return <FollowTeam snapshot={snapshot} onFollow={follow} />;
  }
  if (choosingPlayer && publishesPlayers(snapshot)) {
    return (
      <SelectPlayer
        snapshot={snapshot}
        teamId={state.followedTeamId}
        onSelect={(playerId) => selectPlayer(playerId)}
        onSkip={() => setChoosingPlayer(false)}
      />
    );
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <div className="masthead-inner">
          <h1>{snapshot.tournament.name}</h1>
          <span className="status" data-connection={state.connection}>
            <span className="status-dot" aria-hidden="true" />
            {state.connection === 'live' ? 'Live' : state.connection === 'offline' ? 'Offline' : 'Updated'}
          </span>
        </div>
      </header>

      <main className="app" id="main">
        {/* An explicit staleness line whenever the data is not arriving over a socket. Live Web
            never lets cached data look current. */}
        {stale && (
          <p className="stale" role="status">
            {age}
            {state.connection === 'offline' && ' · reconnecting'}{' '}
            <button
              type="button"
              onClick={refresh}
              style={{ minHeight: 32, padding: '0 10px', marginLeft: 8, fontSize: 14 }}
            >
              Refresh
            </button>
          </p>
        )}
        {snapshot.final && (
          <p className="stale" role="status">
            Final results. This tournament is over.
          </p>
        )}

        {tab === 'home' && (
          <Home
            snapshot={snapshot}
            followedTeamId={state.followedTeamId}
            selectedPlayerId={state.selectedPlayerId}
            now={now}
          />
        )}
        {tab === 'schedule' && (
          <Schedule snapshot={snapshot} followedTeamId={state.followedTeamId} now={now} />
        )}
        {tab === 'standings' && <Standings snapshot={snapshot} followedTeamId={state.followedTeamId} />}
        {tab === 'stats' && (
          <Stats
            snapshot={snapshot}
            followedTeamId={state.followedTeamId}
            selectedPlayerId={state.selectedPlayerId}
          />
        )}
        {tab === 'updates' && <Updates snapshot={snapshot} followedTeamId={state.followedTeamId} now={now} />}

        <p className="faint" style={{ marginTop: 24 }}>
          <button
            type="button"
            onClick={() => {
              selectPlayer(null);
              setState((previous) => {
                const next = { ...previous, followedTeamId: null };
                writeCache(next);
                return next;
              });
            }}
            style={{ minHeight: 36, fontSize: 14 }}
          >
            Follow a different team
          </button>
        </p>
      </main>

      <nav className="tabbar" aria-label="Sections">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-current={tab === entry.id ? 'page' : undefined}
            onClick={() => setTab(entry.id)}
          >
            <Icon name={entry.icon} />
            {entry.label}
          </button>
        ))}
      </nav>
    </>
  );
}
