import { navigationTargetForOperational, type DirectorNavigationTarget } from '../app/navigationTarget';
import { useState } from 'react';
import {
  deriveRoundOperations,
  deriveTeamStandings,
  latestRound,
  nextOperationsRound,
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
import type { QbtcpOperationalHealth } from '../server/qbtcpHealth';

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
  severity: AttentionSeverity;
  action?: string;
  /** The exact entity that owns the fix, when one is known. */
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
  qbtcpOperationalHealth,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId, target?: DirectorNavigationTarget | null) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  nativeServerReady?: boolean;
  nativeServerAvailable?: boolean;
  qbtcpHealth?: { lastSuccessfulAt: string | null; error: string | null };
  qbtcpOperationalHealth?: QbtcpOperationalHealth | null;
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

  const nextOperationalRound = nextOperationsRound(state);
  const nextRoundOperations = nextOperationalRound
    ? deriveRoundOperations(state, nextOperationalRound.id)
    : null;
  const nextOperationalIssue = nextRoundOperations
    ? (nextRoundOperations.blockers[0] ?? nextRoundOperations.warnings[0] ?? null)
    : null;
  const firstNextGame = nextOperationalRound
    ? state.scheduledGames.find(
        (game) => game.roundId === nextOperationalRound.id && !game.bye && game.status !== 'cancelled',
      )
    : null;
  const nextOperationsTarget: DirectorNavigationTarget | null = nextOperationalIssue?.target
    ? navigationTargetForOperational(nextOperationalIssue.target)
    : firstNextGame && nextOperationalRound
      ? {
          section: 'rooms',
          entityType: 'game',
          entityId: firstNextGame.id,
          parentId: nextOperationalRound.id,
        }
      : null;

  const standings = deriveTeamStandings(state)
    .filter((standing) => standing.gamesPlayed > 0)
    .slice(0, 5);

  const attention: AttentionItem[] = [
    ...(qbtcpOperationalHealth?.kind === 'stale'
      ? [
          {
            id: 'qbtcp-sync-stale',
            title: 'QBTCP snapshot sync is delayed',
            text: 'Open Operations to check the native server and restore current scorer activity.',
            section: 'rooms' as SectionId,
            tone: 'warning' as const,
            severity: 'warning' as const,
          },
        ]
      : []),
    ...blockers.map((issue) => {
      const target = issue.entity ? navigationTargetForOperational(issue.entity) : undefined;
      const section = target?.section ?? sectionForArea(issue.area);
      return {
        id: issue.id,
        title: issue.message,
        text: `Resolve in ${labelForSection(section)} before tournament play.`,
        section,
        tone: 'danger' as const,
        severity: 'blocker' as const,
        action: issue.action,
        target,
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
        const target = issue.entity ? navigationTargetForOperational(issue.entity) : undefined;
        const section = target?.section ?? sectionForArea(issue.area);
        return {
          id: issue.id,
          title: issue.message,
          text: `Review in ${labelForSection(section)} before tournament play.`,
          section,
          tone: 'info' as const,
          severity: 'info' as const,
          action: issue.action,
          target,
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
        <EmptyState
          title="No round yet"
          description="Add teams, rooms, and a format, and the day's first round appears here."
          variant="contained"
        />
      )}

      {nextRoundOperations?.round && (
        <Panel
          title={nextRoundOperations.round.name}
          description="Next-round readiness"
          actions={
            <Button
              variant={nextOperationalIssue ? 'secondary' : 'quiet'}
              icon="chevron"
              onClick={() =>
                nextOperationsTarget
                  ? onNavigate(nextOperationsTarget.section, nextOperationsTarget)
                  : onNavigate('rooms')
              }
            >
              {nextOperationalIssue?.action ?? 'Open Operations'}
            </Button>
          }
        >
          <MetaRow
            items={[
              `${nextRoundOperations.summary.games} game${nextRoundOperations.summary.games === 1 ? '' : 's'}`,
              state.rooms.length > 0
                ? `${nextRoundOperations.summary.gamesWithRooms}/${nextRoundOperations.summary.games} rooms assigned`
                : '',
              state.staff.length > 0
                ? `${nextRoundOperations.summary.staffPositionsFilled}/${nextRoundOperations.summary.staffPositionsRequired} staff positions filled`
                : '',
              nextRoundOperations.summary.scorekeepersExpected > 0
                ? `${nextRoundOperations.summary.scorekeepersConnected}/${nextRoundOperations.summary.scorekeepersExpected} scorekeepers connected`
                : '',
              `${nextRoundOperations.summary.issues} issue${nextRoundOperations.summary.issues === 1 ? '' : 's'}`,
            ]}
          />
          <p className="director-empty-copy">
            {nextOperationalIssue?.message ?? 'No operational blockers are known for this round.'}
          </p>
        </Panel>
      )}

      {attention.length > 0 && (
        <Section
          title="Needs attention"
          description="Highest-impact issues appear first. Each item opens the workflow that can resolve it."
        >
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
                    {item.action ?? `Open ${labelForSection(item.section)}`}
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