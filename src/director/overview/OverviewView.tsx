import { deriveTeamStandings, runPreflight, type DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, StateLabel } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import type { SectionId } from '../app/navigation';

export function OverviewView({
  state,
  controller,
  onNavigate,
  onAnnounce,
  nativeServerReady = false,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
  nativeServerReady?: boolean;
}) {
  const tournament = state.tournament;
  const round =
    state.rounds.find((entry) => entry.id === tournament?.currentRoundId) ?? state.rounds.at(-1) ?? null;
  const games = round ? state.scheduledGames.filter((game) => game.roundId === round.id) : [];
  const finished = games.filter((game) => game.status === 'accepted').length;
  const live = games.filter((game) => game.status === 'live').length;
  const waiting = games.filter((game) => game.status === 'scheduled' || game.status === 'released').length;
  const reviewCount = state.submissions.filter(
    (submission) => submission.status === 'review' || submission.status === 'received',
  ).length;
  const issues = runPreflight(state, nativeServerReady);
  const standings = deriveTeamStandings(state).slice(0, 5);

  return (
    <>
      <PageHeader
        eyebrow="Tournament overview"
        title={tournament?.name ?? 'No tournament open'}
        description={
          tournament
            ? [tournament.date, tournament.venue].filter(Boolean).join(' · ') ||
              'Tournament details not entered yet'
            : 'Create a tournament to begin planning.'
        }
        actions={
          <>
            <Button variant="secondary" icon="clipboard" onClick={() => onNavigate('tournament')}>
              Preflight
            </Button>
            <Button variant="primary" icon="arrow" onClick={() => onNavigate(round ? 'tournament' : 'teams')}>
              {round ? 'Preview next round' : 'Set up teams'}
            </Button>
          </>
        }
      />

      <div className="director-page-stack">
        {round ? (
          <section className="director-round-banner" aria-labelledby="director-current-round-title">
            <div className="director-round-heading">
              <div className="director-round-number">{String(round.number).padStart(2, '0')}</div>
              <div>
                <p className="director-eyebrow">Current round</p>
                <h2 id="director-current-round-title">{round.name}</h2>
                <p>
                  {round.status === 'closed'
                    ? 'Closed'
                    : round.status === 'released'
                      ? 'Assignments released'
                      : 'Not released'}{' '}
                  · revision {round.revision}
                </p>
              </div>
            </div>
            <div className="director-round-summary" aria-label="Round summary">
              <span>
                <strong>{finished}</strong> accepted
              </span>
              <span>
                <strong>{live}</strong> live
              </span>
              <span>
                <strong>{waiting}</strong> waiting
              </span>
            </div>
            <div className="director-round-actions">
              <Button
                variant="quiet"
                icon={round.status === 'released' ? 'pause' : 'play'}
                onClick={() => {
                  if (round.status === 'released') {
                    const closed = controller.closeRound(round.id);
                    onAnnounce(
                      closed
                        ? `${round.name} closed.`
                        : `${round.name} could not close; accept or cancel every game first.`,
                    );
                  } else {
                    const released = controller.releaseRound(round.id);
                    onAnnounce(
                      released
                        ? `${round.name} released.`
                        : 'The round is not ready to release; review the Director error and room assignments.',
                    );
                  }
                }}
              >
                {round.status === 'released' ? 'Close round' : 'Release assignments'}
              </Button>
              <Button variant="quiet" icon="chevron" onClick={() => onNavigate('tournament')}>
                Open control
              </Button>
            </div>
          </section>
        ) : (
          <section className="director-round-banner director-round-banner-empty">
            <div>
              <p className="director-eyebrow">First step</p>
              <h2>Build the tournament plan</h2>
              <p>Add teams, rooms, and a format. Director will persist each change locally.</p>
            </div>
            <Button variant="primary" onClick={() => onNavigate('teams')}>
              Add teams
            </Button>
          </section>
        )}

        <div className="director-stat-grid" aria-label="Tournament status">
          <StatusStat
            label="Teams"
            value={String(state.teams.filter((team) => team.status === 'confirmed').length)}
            detail={`${state.teams.length} records`}
            onClick={() => onNavigate('teams')}
          />
          <StatusStat
            label="Rooms"
            value={String(state.rooms.length)}
            detail={
              state.rooms.filter((room) => room.available).length
                ? `${state.rooms.filter((room) => room.available).length} available`
                : 'Add rooms'
            }
            onClick={() => onNavigate('rooms')}
          />
          <StatusStat
            label="Results to review"
            value={String(reviewCount)}
            detail={reviewCount ? 'Needs a decision' : 'Inbox clear'}
            onClick={() => onNavigate('results')}
          />
          <StatusStat
            label="Saved locally"
            value={controller.saving ? 'Saving' : state.metadata.lastSavedAt ? 'Yes' : 'Not yet'}
            detail={
              controller.repositoryKind === 'tauri-sqlite'
                ? 'SQLite'
                : controller.repositoryKind === 'indexeddb'
                  ? 'IndexedDB'
                  : 'Memory only'
            }
            onClick={() => onNavigate('settings')}
          />
        </div>

        {issues.length > 0 && (
          <section
            className="director-callout director-callout-warning"
            aria-labelledby="director-attention-title"
          >
            <div className="director-callout-icon">
              <Icon name="alert" size={18} />
            </div>
            <div>
              <p className="director-eyebrow">Before you run the next round</p>
              <h2 id="director-attention-title">
                {issues.filter((issue) => issue.severity === 'blocker').length
                  ? `${issues.filter((issue) => issue.severity === 'blocker').length} blocker(s) need attention`
                  : 'A few checks are still open'}
              </h2>
              <ul className="director-compact-list">
                {issues.slice(0, 3).map((issue) => (
                  <li key={issue.id}>
                    <StateLabel state={issue.severity} label={issue.message} />
                  </li>
                ))}
              </ul>
            </div>
            <Button variant="secondary" onClick={() => onNavigate('tournament')}>
              Review preflight
            </Button>
          </section>
        )}

        <div className="director-two-column">
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Live rooms</p>
                <h2>Rooms now</h2>
              </div>
              <Button variant="quiet" onClick={() => onNavigate('rooms')}>
                View all <Icon name="chevron" size={14} />
              </Button>
            </div>
            {state.rooms.length === 0 ? (
              <div className="director-panel-body">
                <p className="director-empty-copy">No rooms have been added yet.</p>
              </div>
            ) : (
              <div className="director-table-wrap">
                <table className="director-table">
                  <thead>
                    <tr>
                      <th scope="col">Room</th>
                      <th scope="col">Assignment</th>
                      <th scope="col">Status</th>
                      <th scope="col">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.rooms.slice(0, 8).map((room) => {
                      const game = games.find((entry) => entry.roomId === room.id);
                      const session = state.qbtcpSessions.find((entry) => entry.roomId === room.id);
                      return (
                        <tr key={room.id}>
                          <td>
                            <strong>{room.name}</strong>
                          </td>
                          <td>{game ? teamNames(state, game.leftTeamId, game.rightTeamId) : 'Unassigned'}</td>
                          <td>
                            <StateLabel
                              state={
                                session?.state === 'result-received'
                                  ? 'review'
                                  : session?.state === 'live' || game?.status === 'live'
                                    ? 'live'
                                    : game?.status === 'accepted'
                                      ? 'finished'
                                      : room.status
                              }
                              label={
                                session?.state === 'result-received'
                                  ? 'Result received'
                                  : game?.status === 'accepted'
                                    ? 'Finished'
                                    : room.status
                              }
                            />
                          </td>
                          <td>{session?.lastSeenAt ? formatTime(session.lastSeenAt) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Standings</p>
                <h2>Current leaders</h2>
              </div>
              <Button variant="quiet" onClick={() => onNavigate('standings')}>
                Open standings <Icon name="chevron" size={14} />
              </Button>
            </div>
            {standings.length === 0 ? (
              <div className="director-panel-body">
                <p className="director-empty-copy">Accepted results will appear here.</p>
              </div>
            ) : (
              <div className="director-panel-body director-panel-body-list">
                <ol className="director-list director-leader-list">
                  {standings.map((standing, index) => (
                    <li key={standing.teamId}>
                      <span className="director-leader-rank">{index + 1}</span>
                      <span className="director-leader-name">
                        {state.teams.find((team) => team.id === standing.teamId)?.displayName ??
                          'Unknown team'}
                      </span>
                      <strong>
                        {standing.wins}–{standing.losses}
                        {standing.ties ? `–${standing.ties}` : ''}
                      </strong>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </section>
        </div>

        <section className="director-panel director-activity-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Audit history</p>
              <h2>Recent activity</h2>
            </div>
            <Button variant="quiet" icon="history" onClick={() => onNavigate('settings')}>
              View history
            </Button>
          </div>
          {state.audit.length === 0 ? (
            <div className="director-panel-body">
              <p className="director-empty-copy">Changes you make will be recorded here.</p>
            </div>
          ) : (
            <div className="director-panel-body director-panel-body-list">
              <ul className="director-list director-activity-list">
                {[...state.audit]
                  .reverse()
                  .slice(0, 5)
                  .map((event) => (
                    <li key={event.id}>
                      <span className="director-activity-dot" />
                      <div>
                        <strong>{event.summary}</strong>
                        <small>
                          {event.actor} · {formatTime(event.at)}
                        </small>
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function StatusStat({
  label,
  value,
  detail,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="director-stat" onClick={onClick}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </button>
  );
}

function teamNames(state: DirectorState, leftId: string, rightId: string | null): string {
  const left = state.teams.find((team) => team.id === leftId)?.displayName ?? 'Unknown';
  const right = rightId ? (state.teams.find((team) => team.id === rightId)?.displayName ?? 'Unknown') : 'Bye';
  return `${left} · ${right}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
