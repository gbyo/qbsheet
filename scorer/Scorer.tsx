/**
 * The scorekeeping screen.
 *
 * It shows a tournament, a round, a room and two teams. It does not show a product name, a packet, a
 * question, or a reader control, because the scorekeeper is sitting next to somebody reading from
 * paper and none of those things exist for them.
 *
 * # It is never asked what it is scoring
 *
 * There is no Tossup / Bonus / Overtime selector. The phase comes from `deriveGame`, which works it
 * out from the rules and the events so far: a converted tossup moves to the bonus on its own, a neg
 * leaves the other team able to answer, a tied regulation runs into overtime. A scorekeeper telling
 * the software what it already knows is a step that exists only to go wrong.
 */
import { useCallback, useMemo } from 'react';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import deriveGame, { IGameSetup } from '../scoring/deriveGame';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { RoomConnectionState } from '../RoomLifecycle';
import TeamPanel from './TeamPanel';
import BonusPrompt from './BonusPrompt';
import RecentRail from './RecentRail';
import { IGameEventsApi, newEventId } from './useGameEvents';

export interface IScorerProps {
  format: IScorekeeperFormat;
  setup: IGameSetup;
  events: IGameEventsApi;
  /** Shown as the page's identity. The tournament, not the software. */
  tournamentName: string;
  roundName: string;
  // eslint-disable-next-line react/require-default-props
  roomName?: string;
  connection: RoomConnectionState;
  /** Set when the room is degraded: the game is real, the room state behind it is stale. */
  // eslint-disable-next-line react/require-default-props
  degradedMessage?: string;
  /** False when this browser could not save the game locally. */
  // eslint-disable-next-line react/require-default-props
  saved?: boolean;
}

function connectionLabel(connection: RoomConnectionState): string {
  if (connection === RoomConnectionState.Connected) return 'Connected';
  if (connection === RoomConnectionState.Offline) return 'Offline';
  return 'Connection issue';
}

function connectionClass(connection: RoomConnectionState): string {
  if (connection === RoomConnectionState.Connected) return 'scorer-conn is-ok';
  if (connection === RoomConnectionState.Offline) return 'scorer-conn is-offline';
  return 'scorer-conn is-degraded';
}

export default function Scorer(props: IScorerProps) {
  const { format, setup, events, tournamentName, roundName, roomName, connection, degradedMessage, saved } = props;

  const game = useMemo(() => deriveGame(format, setup, events.events), [format, setup, events.events]);
  const { phase } = game;

  const recordBuzz = useCallback(
    (team: 'left' | 'right', playerName: string, answerType: IScorekeeperAnswerType) => {
      if (phase.kind !== 'tossup') return;
      const event: ScoreEvent = {
        id: newEventId(),
        type: 'tossup-buzz',
        questionNumber: phase.questionNumber,
        team,
        playerName,
        answerTypeIndex: answerType.index,
      };
      events.append(event);
    },
    [events, phase],
  );

  const recordNoBuzz = useCallback(() => {
    if (phase.kind !== 'tossup') return;
    events.append({ id: newEventId(), type: 'tossup-dead', questionNumber: phase.questionNumber });
  }, [events, phase]);

  const recordBonus = useCallback(
    (controlledPoints: number, bouncebackPoints?: number) => {
      if (phase.kind !== 'bonus') return;
      events.append({
        id: newEventId(),
        type: 'bonus',
        questionNumber: phase.questionNumber,
        team: phase.team,
        controlledPoints,
        bouncebackPoints,
      });
    },
    [events, phase],
  );

  const scoringEnabled = phase.kind === 'tossup';
  const eligible = (side: 'left' | 'right') => phase.kind === 'tossup' && phase.eligibleTeams.includes(side);

  /** "Tossup 7 of 20", or the overtime equivalent, which does not pretend to be regulation. */
  const progress = (() => {
    if (phase.kind === 'complete') return 'Game complete';
    if (phase.period === 'overtime') {
      const overtimeNumber = game.overtimeTossupsRead + (phase.kind === 'tossup' ? 1 : 0);
      const suddenDeath = format.overtime.suddenDeath ? ' · sudden death' : '';
      return `Overtime tossup ${Math.max(1, overtimeNumber)}${suddenDeath}`;
    }
    if (format.regulation.timed) return `Tossup ${phase.questionNumber} · timed round`;
    return `Tossup ${phase.questionNumber} of ${format.regulation.tossupCount}`;
  })();

  return (
    <div className="scorer">
      <header className="scorer-header">
        <div className="scorer-header-main">
          <h1 className="scorer-tournament">{tournamentName}</h1>
          <p className="scorer-context">
            Round {roundName}
            {roomName && <> · {roomName}</>}
          </p>
        </div>
        <div className="scorer-header-side">
          <span className="scorer-progress">{progress}</span>
          <span className={connectionClass(connection)}>
            <span className="scorer-dot" aria-hidden="true" />
            {connectionLabel(connection)}
          </span>
        </div>
      </header>

      {degradedMessage && <p className="scorer-banner is-warning">{degradedMessage}</p>}
      {saved === false && (
        <p className="scorer-banner is-error">
          This device could not save the game locally. Do not reload the page &mdash; the questions scored so far exist
          only on this screen.
        </p>
      )}

      <div className="scorer-body">
        <main className="scorer-main">
          <div className="scorer-teams">
            <TeamPanel
              format={format}
              team={game.left}
              scoringEnabled={scoringEnabled}
              eligible={eligible('left')}
              onBuzz={(playerName, answerType) => recordBuzz('left', playerName, answerType)}
            />
            <TeamPanel
              format={format}
              team={game.right}
              scoringEnabled={scoringEnabled}
              eligible={eligible('right')}
              onBuzz={(playerName, answerType) => recordBuzz('right', playerName, answerType)}
            />
          </div>

          <div className="scorer-stage">
            {phase.kind === 'tossup' && (
              <div className="scorer-tossup-actions">
                <button type="button" className="scorer-nobuzz" onClick={recordNoBuzz}>
                  No buzz
                </button>
                {phase.eligibleTeams.length === 1 && (
                  <p className="scorer-hint">
                    {phase.eligibleTeams[0] === 'left' ? game.left.name : game.right.name} may still answer.
                  </p>
                )}
              </div>
            )}

            {phase.kind === 'bonus' && (
              <BonusPrompt
                format={format}
                controllingTeamName={phase.team === 'left' ? game.left.name : game.right.name}
                opponentName={phase.team === 'left' ? game.right.name : game.left.name}
                questionNumber={phase.questionNumber}
                onRecord={recordBonus}
              />
            )}

            {phase.kind === 'complete' && (
              <div className="scorer-complete">
                <p className="scorer-complete-title">Game complete</p>
                <p className="scorer-complete-detail">
                  {game.left.name} {game.left.points} &mdash; {game.right.name} {game.right.points}
                </p>
                <p className="scorer-complete-detail">
                  {game.tossupsRead} tossup{game.tossupsRead === 1 ? '' : 's'} heard
                  {game.overtimeTossupsRead > 0 && <>, {game.overtimeTossupsRead} in overtime</>}
                </p>
              </div>
            )}
          </div>
        </main>

        <RecentRail game={game} />
      </div>

      <footer className="scorer-footer">
        <button type="button" className="scorer-action" onClick={events.undo} disabled={!events.canUndo}>
          Undo
        </button>
        <button type="button" className="scorer-action" onClick={events.redo} disabled={!events.canRedo}>
          Redo
        </button>
      </footer>
    </div>
  );
}
