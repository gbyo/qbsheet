import { deriveTeamStandings, latestRound, runPreflight, type DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import type { SectionId } from '../app/navigation';
import type { AnnounceInput } from '../notices';

export function OverviewView({
  state,
  controller,
  onNavigate,
  onAnnounce,
  nativeServerReady = false,
  nativeServerAvailable = true,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  nativeServerReady?: boolean;
  nativeServerAvailable?: boolean;
}) {
  const tournament = state.tournament;
  const round =
    state.rounds.find((entry) => entry.id === tournament?.currentRoundId) ?? latestRound(state.rounds);
  const games = round ? state.scheduledGames.filter((game) => game.roundId === round.id) : [];
  const finished = games.filter((game) => game.status === 'accepted').length;
  const playing = games.filter(
    (game) => game.status === 'live' || game.status === 'released' || game.status === 'scheduled',
  ).length;
  const reviewCount = state.submissions.filter(
    (submission) => submission.status === 'review' || submission.status === 'received',
  ).length;
  const openProtests = state.protests.filter((protest) => protest.status === 'open').length;
  const helpSessions = state.qbtcpSessions.filter((session) => session.helpRequestId);
  const issues = runPreflight(state, nativeServerReady, nativeServerAvailable);
  const blockers = issues.filter((issue) => issue.severity === 'blocker');
  const otherChecks = issues.length - blockers.length;
  const standings = deriveTeamStandings(state).slice(0, 5);
  const attention: Array<{ id: string; text: string; section: SectionId }> = [
    ...blockers.map((issue) => ({ id: issue.id, text: issue.message, section: 'tournament' as SectionId })),
    ...(reviewCount
      ? [
          {
            id: 'results-to-review',
            text: `${reviewCount} result${reviewCount === 1 ? '' : 's'} need${reviewCount === 1 ? 's' : ''} a decision.`,
            section: 'results' as SectionId,
          },
        ]
      : []),
    ...(openProtests
      ? [
          {
            id: 'open-protests',
            text: `${openProtests} open protest${openProtests === 1 ? '' : 's'}.`,
            section: 'results' as SectionId,
          },
        ]
      : []),
    ...helpSessions.map((session) => ({
      id: `help-${session.roomId}`,
      text: `${state.rooms.find((room) => room.id === session.roomId)?.name ?? 'A room'} requested help.`,
      section: 'rooms' as SectionId,
    })),
  ];

  return (
    <>
      <PageHeader
        title={tournament?.name ?? 'No tournament open'}
        description={
          tournament
            ? [tournament.date, tournament.venue].filter(Boolean).join(' · ') ||
              'Tournament details not entered yet'
            : 'Create a tournament to begin planning.'
        }
        actions={
          <Button variant="primary" icon="arrow" onClick={() => onNavigate(round ? 'tournament' : 'teams')}>
            {round ? `Open ${round.name}` : 'Set up teams'}
          </Button>
        }
      />

      <div className="director-page-stack">
        {round ? (
          <section className="director-round-banner" aria-labelledby="director-current-round-title">
            <div className="director-round-heading">
              <div className="director-round-number">{String(round.number).padStart(2, '0')}</div>
              <div>
                <h2 id="director-current-round-title">{round.name}</h2>
                <p>
                  {finished} of {games.length} result{games.length === 1 ? '' : 's'} accepted
                  {playing > 0 && round.status !== 'closed'
                    ? ` · ${playing} still playing`
                    : round.status === 'closed'
                      ? ' · complete'
                      : ''}
                </p>
              </div>
            </div>
            <div className="director-round-actions">
              {round.status !== 'closed' && (
                <Button
                  variant="quiet"
                  icon={
                    round.status === 'released' ? 'pause' : round.status === 'planned' ? 'clipboard' : 'play'
                  }
                  onClick={() => {
                    if (round.status === 'planned') {
                      const prepared = controller.prepareRound(round.id);
                      onAnnounce(
                        prepared
                          ? `${round.name} prepared.`
                          : `${round.name} could not be prepared; review the schedule first.`,
                      );
                    } else if (round.status === 'prepared') {
                      const released = controller.releaseRound(round.id);
                      onAnnounce(
                        released
                          ? `${round.name} released.`
                          : 'The round is not ready to release; review the Director error and room assignments.',
                      );
                    } else {
                      const closed = controller.closeRound(round.id);
                      onAnnounce(
                        closed
                          ? `${round.name} closed.`
                          : `${round.name} could not close; accept or cancel every game first.`,
                      );
                    }
                  }}
                >
                  {round.status === 'planned'
                    ? 'Prepare round'
                    : round.status === 'prepared'
                      ? 'Release assignments'
                      : 'Close round'}
                </Button>
              )}
              <Button variant="quiet" icon="chevron" onClick={() => onNavigate('tournament')}>
                Open control
              </Button>
            </div>
          </section>
        ) : (
          <section className="director-round-banner director-round-banner-empty">
            <div>
              <h2>Build the tournament plan</h2>
              <p>Add teams, rooms, and a format. Director will persist each change locally.</p>
            </div>
            <Button variant="primary" onClick={() => onNavigate('teams')}>
              Add teams
            </Button>
          </section>
        )}

        {attention.length > 0 && (
          <section
            className="director-callout director-callout-warning"
            aria-labelledby="director-attention-title"
          >
            <div className="director-callout-icon">
              <Icon name="alert" size={18} />
            </div>
            <div>
              <h2 id="director-attention-title">Needs attention</h2>
              <ul className="director-compact-list">
                {attention.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    <Button variant="quiet" onClick={() => onNavigate(item.section)}>
                      {item.text}
                    </Button>
                  </li>
                ))}
                {otherChecks > 0 && (
                  <li>
                    <Button variant="quiet" onClick={() => onNavigate('tournament')}>
                      {otherChecks} more check{otherChecks === 1 ? '' : 's'} in preflight.
                    </Button>
                  </li>
                )}
              </ul>
            </div>
          </section>
        )}

        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <h2>Current leaders</h2>
            </div>
            <Button variant="quiet" onClick={() => onNavigate('standings')}>
              View standings <Icon name="chevron" size={14} />
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
                      {state.teams.find((team) => team.id === standing.teamId)?.displayName ?? 'Unknown team'}
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

        <details className="director-panel director-diagnostics">
          <summary>Diagnostics</summary>
          <div className="director-panel-body">
            <p className="director-empty-copy">
              Saved:{' '}
              {controller.error
                ? 'needs attention'
                : controller.saving
                  ? 'saving…'
                  : (state.metadata.lastSavedAt ?? 'not yet')}{' '}
              ·{' '}
              {controller.repositoryKind === 'tauri-sqlite'
                ? 'SQLite'
                : controller.repositoryKind === 'indexeddb'
                  ? 'IndexedDB'
                  : 'memory only'}
              {' · '}
              {state.audit.length} audit {state.audit.length === 1 ? 'entry' : 'entries'}
              {!nativeServerAvailable && ' · native server unavailable in this browser'}
            </p>
            <Button variant="quiet" icon="history" onClick={() => onNavigate('settings')}>
              Recovery and history
            </Button>
          </div>
        </details>
      </div>
    </>
  );
}
