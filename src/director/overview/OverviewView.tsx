import { useState } from 'react';
import {
  deriveTeamStandings,
  latestRound,
  orderDayItems,
  runPreflight,
  type DirectorState,
  type PreflightIssue,
} from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import type { SectionId } from '../app/navigation';
import { currentOperationalRound } from '../transfers/assignment';
import type { AnnounceInput } from '../notices';

function sectionForArea(area: PreflightIssue['area']): SectionId {
  switch (area) {
    case 'teams':
      return 'teams';
    case 'format':
      return 'format';
    case 'schedule':
      return 'schedule';
    case 'rooms':
    case 'qbtcp':
      return 'rooms';
    case 'packets':
      return 'packets';
    case 'storage':
      return 'settings';
    default:
      return 'settings';
  }
}

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
  const round = currentOperationalRound(state) ?? latestRound(state.rounds);
  const games = round ? state.scheduledGames.filter((game) => game.roundId === round.id && !game.bye) : [];
  const finished = games.filter((game) => game.status === 'accepted').length;
  const complete =
    games.length > 0 &&
    games.every((game) => game.bye || game.status === 'accepted' || game.status === 'cancelled');
  const playing = games.filter((game) => !game.bye && game.status === 'live').length;
  const reviewCount = state.submissions.filter(
    (submission) => submission.status === 'review' || submission.status === 'received',
  ).length;
  const openProtests = state.protests.filter((protest) => protest.status === 'open').length;
  const helpRequests = state.qbtcpHelpRequests.filter((request) => request.status === 'open');
  const helpSessions = state.qbtcpSessions.filter(
    (session) =>
      session.state !== 'abandoned' &&
      session.helpRequestId &&
      !state.qbtcpHelpRequests.some((request) => request.id === session.helpRequestId),
  );
  const dayItems = orderDayItems(state.rounds, state.timeline);
  const roundIndex = dayItems.findIndex((item) => item.id === round?.id);
  const preceding = roundIndex > 0 ? dayItems[roundIndex - 1] : undefined;
  const nextEvent = round?.status !== 'released' && preceding?.kind === 'event' ? preceding.event : undefined;
  const issues = runPreflight(state, nativeServerReady, nativeServerAvailable);
  const blockers = issues.filter((issue) => issue.severity === 'blocker');
  const [showAllAttention, setShowAllAttention] = useState(false);
  /*
   * Leaders are teams that have led something. `deriveTeamStandings` seeds a 0–0 row for every
   * confirmed team, so ranking the raw list numbered five teams that had not played a game yet —
   * a leaderboard invented out of an empty schedule. Filtering on games played leaves the panel's
   * "accepted results will appear here" copy on screen until there is a result to rank.
   */
  const standings = deriveTeamStandings(state)
    .filter((standing) => standing.gamesPlayed > 0)
    .slice(0, 5);
  // Every blocker answers where it can be fixed: the attention item deep-links
  // into the tool that owns the problem instead of dumping everything on the
  // Tournament section.
  const attention: Array<{ id: string; text: string; section: SectionId }> = [
    ...blockers.map((issue) => ({
      id: issue.id,
      text: issue.message,
      section: sectionForArea(issue.area),
    })),
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
    ...helpRequests.map((request) => ({
      id: request.id,
      text: `${request.roomName} requested help.`,
      section: 'rooms' as SectionId,
    })),
    ...(controller.error
      ? [{ id: 'storage-error', text: controller.error, section: 'settings' as SectionId }]
      : []),
    ...helpSessions.map((session) => ({
      id: `help-${session.roomId}`,
      text: `${state.rooms.find((room) => room.id === session.roomId)?.name ?? 'A room'} requested help.`,
      section: 'rooms' as SectionId,
    })),
    ...issues
      .filter((issue) => issue.severity !== 'blocker')
      .map((issue) => ({
        id: issue.id,
        text: issue.message,
        section: sectionForArea(issue.area),
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
          <Button variant="primary" icon="arrow" onClick={() => onNavigate(round ? 'schedule' : 'teams')}>
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
                {nextEvent && (
                  <p>
                    Up next: {nextEvent.title} · then {round.name}
                  </p>
                )}
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
              {round.status !== 'closed' && round.status !== 'released' && (
                <Button
                  variant="primary"
                  icon="play"
                  onClick={() => {
                    void controller.startRound(round.id).then((result) => onAnnounce(result.summary));
                  }}
                >
                  Start {round.name}
                </Button>
              )}
              {round.status === 'released' &&
                (complete ? (
                  <Button
                    variant="primary"
                    icon="chevron"
                    onClick={() => {
                      onAnnounce(controller.finishRound(round.id).summary);
                    }}
                  >
                    Finish {round.name}
                  </Button>
                ) : (
                  <Button variant="primary" icon="chevron" onClick={() => onNavigate('schedule')}>
                    Open {round.name}
                  </Button>
                ))}
              <Button variant="quiet" icon="chevron" onClick={() => onNavigate('schedule')}>
                Open Rounds
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
                {(showAllAttention ? attention : attention.slice(0, 5)).map((item) => (
                  <li key={item.id}>
                    <Button variant="quiet" onClick={() => onNavigate(item.section)}>
                      {item.text}
                    </Button>
                  </li>
                ))}
                {attention.length > 5 && (
                  <li>
                    <Button variant="quiet" onClick={() => setShowAllAttention((value) => !value)}>
                      {showAllAttention ? 'Show fewer checks' : `${attention.length - 5} more checks`}
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
