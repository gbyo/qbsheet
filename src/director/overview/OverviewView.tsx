import type { DirectorNavigationTarget } from '../app/navigationTarget';
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
import {
  Badge,
  Button,
  Diagnostics,
  EmptyState,
  MetaRow,
  Page,
  PageHeader,
  Panel,
  Progress,
  Section,
  type StatusTone,
} from '../components';
import { labelForSection, type SectionId } from '../app/navigation';
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

type AttentionSeverity = 'blocker' | 'warning' | 'review' | 'info';

const severityRank: Record<AttentionSeverity, number> = { blocker: 0, warning: 1, review: 2, info: 3 };

function severityLabel(severity: AttentionSeverity): string {
  return severity === 'blocker'
    ? 'Blocking'
    : severity === 'warning'
      ? 'Warning'
      : severity === 'review'
        ? 'Needs a decision'
        : 'Check';
}

interface AttentionItem {
  id: string;
  title: string;
  text: string;
  section: SectionId;
  tone: StatusTone;
  /** Ranks the list and picks the marker colour. */
  severity: AttentionSeverity;
  /**
   * Where the fix is, when the item is about a specific thing. A room that has
   * asked for help opens *that* room, not the Rooms page — the point of an
   * attention list is that it ends the search, not that it starts one.
   */
  target?: DirectorNavigationTarget;
}

export function OverviewView({
  state,
  controller,
  onNavigate,
  onAnnounce,
  nativeServerReady = false,
  nativeServerAvailable = true,
  qbtcpHealth,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId, target?: DirectorNavigationTarget | null) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  nativeServerReady?: boolean;
  nativeServerAvailable?: boolean;
  qbtcpHealth?: { lastSuccessfulAt: string | null; error: string | null };
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
  const issues = runPreflight(state, nativeServerReady, nativeServerAvailable, qbtcpHealth);
  const blockers = issues.filter((issue) => issue.severity === 'blocker');
  const [showAllAttention, setShowAllAttention] = useState(false);

  const standings = deriveTeamStandings(state)
    .filter((standing) => standing.gamesPlayed > 0)
    .slice(0, 5);

  const attention: AttentionItem[] = [
    ...blockers.map((issue) => {
      const section = sectionForArea(issue.area);
      return {
        id: issue.id,
        title: issue.message,
        text: `Resolve in ${labelForSection(section)} before tournament play.`,
        section,
        tone: 'danger' as const,
        severity: 'blocker' as const,
      };
    }),
    ...(controller.error
      ? [
          {
            id: 'storage-error',
            title: 'Saving needs attention',
            text: controller.error,
            section: 'settings' as SectionId,
            tone: 'danger' as const,
            severity: 'blocker' as const,
          },
        ]
      : []),
    ...(reviewCount
      ? [
          {
            id: 'results-to-review',
            title: 'Results need review',
            text: `${reviewCount} result${reviewCount === 1 ? '' : 's'} need${reviewCount === 1 ? 's' : ''} a decision.`,
            section: 'results' as SectionId,
            tone: 'warning' as const,
            severity: 'review' as const,
          },
        ]
      : []),
    ...(openProtests
      ? [
          {
            id: 'open-protests',
            title: 'Open protests',
            text:
              openProtests === 1 ? '1 protest awaits a ruling.' : `${openProtests} protests await a ruling.`,
            section: 'results' as SectionId,
            tone: 'warning' as const,
            severity: 'review' as const,
          },
        ]
      : []),
    ...helpRequests.map((request) => ({
      id: request.id,
      title: 'Room requested help',
      text: `${request.roomName} requested help.`,
      target: { section: 'rooms', entityType: 'room', entityId: request.roomId } as DirectorNavigationTarget,
      section: 'rooms' as SectionId,
      tone: 'warning' as const,
      severity: 'warning' as const,
    })),
    ...helpSessions.map((session) => ({
      id: `help-${session.roomId}`,
      title: 'Room requested help',
      text: `${state.rooms.find((room) => room.id === session.roomId)?.name ?? 'A room'} requested help.`,
      target: { section: 'rooms', entityType: 'room', entityId: session.roomId } as DirectorNavigationTarget,
      section: 'rooms' as SectionId,
      tone: 'warning' as const,
      severity: 'warning' as const,
    })),
    ...issues
      .filter((issue) => issue.severity !== 'blocker')
      .map((issue) => {
        const section = sectionForArea(issue.area);
        return {
          id: issue.id,
          title: issue.message,
          text: `Review in ${labelForSection(section)} before tournament play.`,
          section,
          tone: 'info' as const,
          severity: 'info' as const,
        };
      }),
  ].sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);

  return (
    <Page>
      <PageHeader
        title="Overview"
        description={
          tournament
            ? [tournament.name, tournament.date, tournament.venue].filter(Boolean).join(' · ') ||
              'Tournament details not entered yet'
            : 'Create a tournament to begin planning.'
        }
        actions={
          <Button variant="primary" icon="arrow" onClick={() => onNavigate(round ? 'schedule' : 'teams')}>
            {round ? `Open ${round.name}` : 'Set up teams'}
          </Button>
        }
      />

      {round ? (
        <Panel
          title={round.name}
          description={
            nextEvent ? `Up next: ${nextEvent.title} · then ${round.name}` : 'Current tournament round'
          }
          tone={round.status === 'released' ? 'info' : undefined}
          actions={
            <>
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
              {/*
                The panel owns the round's operations — Start, and Finish once
                every game is in. Navigating to the day is the quiet action
                below, and the page header already carries "Open <round>" as the
                one primary thing to do next; offering it twice made the same
                button appear on one screen with the same name.
              */}
              {round.status === 'released' && complete && (
                <Button
                  variant="primary"
                  icon="chevron"
                  onClick={() => onAnnounce(controller.finishRound(round.id).summary)}
                >
                  Finish {round.name}
                </Button>
              )}
              <Button variant="quiet" icon="chevron" onClick={() => onNavigate('schedule')}>
                Tournament day
              </Button>
            </>
          }
        >
          <Progress
            value={finished}
            max={games.length}
            tone={complete ? 'success' : undefined}
            label={`${finished} of ${games.length} results accepted`}
          />
          <MetaRow
            items={[
              playing > 0 && round.status !== 'closed' ? `${playing} still playing` : '',
              round.status === 'closed' ? 'Round complete' : '',
            ]}
          />
        </Panel>
      ) : (
        /*
          Before there is a round, the page header's primary action is what to
          do next and the attention list says what is missing. A third card
          repeating "add teams" put the same instruction on screen three times.
        */
        <EmptyState
          title="No round yet"
          description="Add teams, rooms, and a format, and the day's first round appears here."
          variant="contained"
        />
      )}

      {attention.length > 0 && (
        <Section
          title="Needs attention"
          description="Highest-impact issues appear first. Each item opens the workflow that can resolve it."
        >
          {/*
            Rows rather than a stack of tinted panels. Five full callouts in a
            column give every item the same weight and fill the screen with
            borders; a severity rule down the left says the same thing in 3px,
            and keeps the list scannable when a tournament has a dozen of them.
          */}
          <div className="director-attention director-attention-list">
            {(showAllAttention ? attention : attention.slice(0, 5)).map((item) => (
              <div key={item.id} className="director-attention-item" data-severity={item.severity}>
                <span className="director-attention-marker" aria-hidden="true" />
                <div className="director-attention-text">
                  <p className="director-attention-title">
                    {item.title}
                    <Badge tone={item.tone} label={severityLabel(item.severity)} />
                  </p>
                  <p className="director-attention-detail">{item.text}</p>
                </div>
                <div className="director-attention-action">
                  <Button
                    variant="secondary"
                    iconAfter="chevron"
                    onClick={() => onNavigate(item.section, item.target)}
                  >
                    {`Open ${labelForSection(item.section)}`}
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {attention.length > 5 && (
            <Button variant="quiet" onClick={() => setShowAllAttention((value) => !value)}>
              {showAllAttention ? 'Show fewer checks' : `Show ${attention.length - 5} more checks`}
            </Button>
          )}
        </Section>
      )}

      <Panel
        title="Current leaders"
        actions={
          <Button variant="quiet" icon="chevron" onClick={() => onNavigate('standings')}>
            View standings
          </Button>
        }
      >
        {standings.length === 0 ? (
          <p className="director-empty-copy">Accepted results will appear here.</p>
        ) : (
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
        )}
      </Panel>

      <Diagnostics
        hint="Persistence and system details for troubleshooting."
        items={[
          {
            term: 'Save state',
            value: controller.error
              ? 'Needs attention'
              : controller.saving
                ? 'Saving…'
                : (state.metadata.lastSavedAt ?? 'Not saved yet'),
          },
          {
            term: 'Storage',
            value:
              controller.repositoryKind === 'tauri-sqlite'
                ? 'SQLite'
                : controller.repositoryKind === 'indexeddb'
                  ? 'IndexedDB'
                  : 'Memory only',
          },
          { term: 'Audit history', value: `${state.audit.length} entries` },
          ...(!nativeServerAvailable
            ? [{ term: 'Native server', value: 'Unavailable in this browser' }]
            : []),
        ]}
      >
        <Button variant="quiet" icon="history" onClick={() => onNavigate('settings')}>
          Recovery and history
        </Button>
      </Diagnostics>
    </Page>
  );
}
