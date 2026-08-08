/**
 * What a room shows between games.
 *
 * The scorekeeper is standing at a Chromebook in a noisy room, so this is deliberately spare: the
 * room, the round, the two teams, and one button. Previous and next games are there for context, in
 * small type, because a scorekeeper asked "are you done with round 4?" should be able to answer
 * without leaving the page.
 *
 * No celebration when a game lands. A submitted result is a piece of tournament administration, and
 * the useful thing to show is what happens next.
 */
import { ReactNode } from 'react';
import {
  IHelpRequest,
  IRoomAssignmentResponse,
  IRoomPresence,
  IRoomMatchupSummary,
  HelpRequestCategory,
  RoomBlockedReason,
} from '../main/server/ServerTypes';
import RoomOperatorControls from './RoomOperatorControls';
import { connectionStatusClass, describeConnection, RoomConnectionState } from './RoomLifecycle';
import { ScorerChoice } from './ScorerChoice';
import { scorekeeperFormatProblems } from '../renderer/Services/ScorekeeperFormat';

export interface IMatchupCardProps {
  assignment: IRoomAssignmentResponse;
  connection: RoomConnectionState;
  /** Set when this matchup is retained from an earlier poll that the latest one could not refresh */
  // eslint-disable-next-line react/require-default-props
  degradedMessage?: string;
  starting: boolean;
  startError: string;
  pendingFinal: boolean;
  /** The result is with tournament control. A normal state of a connected room, not a failure. */
  awaitingReview: boolean;
  submittedSummary: string;
  canStart: boolean;
  scorerChoice: ScorerChoice;
  // eslint-disable-next-line react/require-default-props
  blockedReason?: RoomBlockedReason;
  lifecycleNotice: string;
  onStart: () => void;
  operatorName: string;
  ready: boolean;
  readyAllowed: boolean;
  presence: IRoomPresence | null;
  helpRequest: IHelpRequest | null;
  helpBusy: boolean;
  onOperatorNameChange: (name: string) => void;
  onReadyChange: (ready: boolean) => void;
  onRequestHelp: (category: HelpRequestCategory, message: string) => Promise<void>;
  onCancelHelp: () => Promise<void>;
  onChangeRoom: () => void;
  /** Set when the server's view of this room disagrees with what this device is holding. */
  // eslint-disable-next-line react/require-default-props
  conflictNotice?: string;
  /** The saved-results list. Rendered at the bottom, where it belongs on a normal day. */
  // eslint-disable-next-line react/require-default-props
  savedResults?: ReactNode;
  /** True when this device has cached tournament data good enough to score a game on its own. */
  // eslint-disable-next-line react/require-default-props
  canScoreEmergency?: boolean;
  /** Enter emergency mode in this already-loaded app shell, so an offline click needs no navigation. */
  // eslint-disable-next-line react/require-default-props
  onScoreEmergency?: () => void;
}

/**
 * What to do when this room stays offline.
 *
 * Deliberately a closed disclosure and deliberately low in the page. A room that has been offline
 * for ten seconds needs no instructions — retrying is automatic and the banner already says so. A
 * room that has been offline for ten minutes needs exactly these four steps, and needs them to be
 * findable without anyone walking over to explain them.
 *
 * The order is the important part: the game finishes here first. Nothing in this list asks a
 * scorekeeper to abandon a game in progress in order to chase a server.
 */
function OfflineRecoverySteps({
  onChangeRoom,
  canScoreEmergency,
  onScoreEmergency,
}: {
  onChangeRoom: () => void;
  canScoreEmergency: boolean;
  // Absent on any page that cannot enter emergency mode in place. The step that offers it is gated
  // on `canScoreEmergency`, so there is nothing sensible to default it to.
  // eslint-disable-next-line react/require-default-props
  onScoreEmergency?: () => void;
}) {
  return (
    <details className="room-recovery">
      <summary>Still offline? What to do</summary>
      <ol>
        <li>Finish the game you are on. It is saved on this Chromebook as you score it.</li>
        <li>When it ends, the result is kept here and sent automatically as soon as YellowFruit is back.</li>
        <li>
          If tournament control needs it sooner, use <strong>Download QBJ</strong> under Saved results and hand them the
          file.
        </li>
        <li>
          If tournament control has moved to a different computer or address, pair this browser again once the game is
          finished.
        </li>
      </ol>
      {canScoreEmergency && onScoreEmergency && (
        <p className="room-muted">
          If tournament control has told you to start the next game anyway,{' '}
          <a
            href="/room/emergency"
            onClick={(event) => {
              event.preventDefault();
              onScoreEmergency();
            }}
          >
            score it from this device
          </a>
          . That result is not in the tournament until they import it.
        </p>
      )}
      <button type="button" className="room-button room-button-secondary" onClick={onChangeRoom}>
        Pair this browser again
      </button>
    </details>
  );
}

function ContextLine({ label, matchup }: { label: string; matchup: IRoomMatchupSummary | null }) {
  if (!matchup) return null;
  return (
    <div className="room-context-line">
      <span className="room-context-label">{label}</span>
      <span className="room-context-round">Round {matchup.roundName}</span>
      <span className="room-context-teams">
        {matchup.leftTeam} vs {matchup.rightTeam}
      </span>
    </div>
  );
}

function startButtonLabel(starting: boolean, awaitingControl: boolean): string {
  if (starting) return 'Starting…';
  if (awaitingControl) return 'Waiting for tournament control';
  return 'Start Match';
}

function scoringRulesIssue(assignment: IRoomAssignmentResponse, scorerChoice: ScorerChoice) {
  if (scorerChoice === 'legacy') {
    if (assignment.gameFormat !== null) return null;
    return {
      title: "This tournament's rules cannot be used by the legacy scorer.",
      details: assignment.gameFormatErrors,
    };
  }

  if (assignment.scoringFormat === null) {
    return {
      title: 'Room scoring rules are not available yet.',
      details: ['Tournament control has not provided usable room-scoring rules to this browser.'],
    };
  }
  const details = scorekeeperFormatProblems(assignment.scoringFormat);
  if (details.length === 0) return null;
  return {
    title: 'Room scoring rules need attention before this game can start.',
    details,
  };
}

export default function MatchupCard(props: IMatchupCardProps) {
  const {
    assignment,
    connection,
    degradedMessage = '',
    starting,
    startError,
    pendingFinal,
    awaitingReview,
    submittedSummary,
    canStart,
    scorerChoice,
    blockedReason,
    lifecycleNotice,
    onStart,
    operatorName,
    ready,
    readyAllowed,
    presence,
    helpRequest,
    helpBusy,
    onOperatorNameChange,
    onReadyChange,
    onRequestHelp,
    onCancelHelp,
    onChangeRoom,
    conflictNotice = '',
    savedResults = null,
    canScoreEmergency = false,
    onScoreEmergency,
  } = props;
  const { current, previous, next, roomName, tournamentName } = assignment;
  const rulesIssue = current === null ? null : scoringRulesIssue(assignment, scorerChoice);

  return (
    <div className="room-shell">
      <header className="room-header">
        <p className="room-tournament">{tournamentName}</p>
        <h1 className="room-name">{roomName}</h1>
      </header>

      {connection === RoomConnectionState.Offline && (
        <>
          <div className="room-banner room-banner-warning">
            <strong>YellowFruit is not reachable.</strong> This page will update as soon as the connection comes back.
            Nothing about this room&apos;s assignment has changed.
          </div>
          <OfflineRecoverySteps
            onChangeRoom={onChangeRoom}
            canScoreEmergency={canScoreEmergency}
            onScoreEmergency={onScoreEmergency}
          />
        </>
      )}

      {conflictNotice !== '' && (
        <div className="room-banner room-banner-error" role="alert">
          <strong>{conflictNotice}</strong>
        </div>
      )}

      {/*
        The server answered, but not with an assignment. The matchup below is the last one YellowFruit
        confirmed, so it stays exactly where it was and this says, quietly, that it is no longer being
        refreshed. Nothing here asks the scorekeeper to do anything: retrying is already automatic.
      */}
      {connection === RoomConnectionState.Degraded && degradedMessage !== '' && (
        <div className="room-banner room-banner-warning room-banner-compact" role="status">
          <strong>{degradedMessage}</strong>
          <div>Showing the last known assignment. The page will keep trying automatically.</div>
        </div>
      )}

      {rulesIssue && (
        <div className="room-banner room-banner-error">
          <strong>{rulesIssue.title}</strong>
          {rulesIssue.details.length > 0 && (
            <ul>
              {rulesIssue.details.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {current !== null &&
        scorerChoice === 'legacy' &&
        rulesIssue === null &&
        assignment.gameFormatWarnings.length > 0 && (
          <div className="room-banner room-banner-info">
            {assignment.gameFormatWarnings.map((message) => (
              <div key={message}>{message}</div>
            ))}
          </div>
        )}

      {pendingFinal && (
        <div className="room-banner room-banner-warning">
          A finished game is still waiting to be sent to YellowFruit. It will go automatically once the connection is
          back. Don&apos;t clear this browser&apos;s data.
        </div>
      )}

      {submittedSummary !== '' && <div className="room-banner room-banner-error">{submittedSummary}</div>}
      {lifecycleNotice !== '' && <div className="room-banner room-banner-info">{lifecycleNotice}</div>}

      {current === null ? (
        <div className="room-empty">
          <p className="room-empty-title">No game assigned</p>
          <p className="room-muted">
            This room has nothing scheduled right now. Leave this page open &mdash; it will update by itself when
            tournament control assigns a game.
          </p>
        </div>
      ) : (
        <div className="room-matchup">
          <p className="room-matchup-round">Round {current.roundName}</p>
          <p className="room-matchup-team">{current.leftTeam.name}</p>
          <p className="room-matchup-vs">vs.</p>
          <p className="room-matchup-team">{current.rightTeam.name}</p>

          {/* The awaiting-review panel below already says this, and more plainly. */}
          {!awaitingReview &&
            blockedReason !== RoomBlockedReason.RulesUnusable &&
            blockedReason !== undefined &&
            assignment.blockedMessage !== undefined && <p className="room-blocked">{assignment.blockedMessage}</p>}

          {startError !== '' && <div className="room-banner room-banner-error">{startError}</div>}

          {/*
            Deliberately not styled as a warning. The room did its job; the result is with tournament
            control, and there is nothing for the scorekeeper to fix or retry.
          */}
          {awaitingReview && (
            <div className="room-banner room-banner-info room-awaiting-review" role="status">
              <strong>Result submitted</strong>
              <span>Waiting for tournament control to review this result.</span>
            </div>
          )}

          <button type="button" className="room-button" onClick={onStart} disabled={!canStart || starting}>
            {startButtonLabel(starting, awaitingReview)}
          </button>
          {!ready && !awaitingReview && (
            <p className="room-muted room-ready-hint">Mark this device ready before starting the match.</p>
          )}
        </div>
      )}

      <div className="room-context">
        <ContextLine label="Previous" matchup={previous} />
        <ContextLine label="Next" matchup={next} />
      </div>

      <RoomOperatorControls
        operatorName={operatorName}
        ready={ready}
        readyAllowed={readyAllowed}
        presence={presence}
        helpRequest={helpRequest}
        helpBusy={helpBusy}
        onOperatorNameChange={onOperatorNameChange}
        onReadyChange={onReadyChange}
        onRequestHelp={onRequestHelp}
        onCancelHelp={onCancelHelp}
        onChangeRoom={onChangeRoom}
      />

      <p className="room-connection">
        <span className={connectionStatusClass(connection)}>
          <span className="room-status-dot" aria-hidden="true" />
          {describeConnection(connection)}
        </span>
      </p>

      {savedResults}
    </div>
  );
}
