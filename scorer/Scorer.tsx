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
 *
 * # Submission is an end-of-game act
 *
 * "Submit" appears when the game is over, not in a toolbar during every question. A button that ends
 * the game sitting next to the buttons that score it is a mis-tap away from a half-finished result
 * reaching tournament control.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import deriveGame, { IGameSetup } from '../scoring/deriveGame';
import { ScoreEvent } from '../scoring/ScoreEvents';
import toQbjMatch, { IQbjMatchMeta } from '../scoring/toQbjMatch';
import { RoomConnectionState } from '../RoomLifecycle';
import TeamPanel from './TeamPanel';
import BonusPrompt from './BonusPrompt';
import RecentRail from './RecentRail';
import GameMenu, { IGameMenuItem } from './GameMenu';
import PlayersDialog from './PlayersDialog';
import { AdjustDialog, ForfeitDialog, LightningDialog, NotesDialog } from './GameDialogs';
import { IGameEventsApi, newEventId } from './useGameEvents';

export interface IScorerSubmitResult {
  ok: boolean;
  message: string;
}

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
  /** Sends the finished game. The room owns what that means; this only decides when. */
  onSubmit: (qbj: object) => Promise<IScorerSubmitResult>;
  /** Writes the current game out as a file, at any point. */
  // eslint-disable-next-line react/require-default-props
  onDownload?: (qbj: object) => void;
  /** Called as the game changes, so tournament control can watch progress. */
  // eslint-disable-next-line react/require-default-props
  onProgress?: (qbj: object, questionsPlayed: number) => void;
  /** Round number and the rest of the non-scoring metadata for the exported match. */
  // eslint-disable-next-line react/require-default-props
  qbjMeta?: IQbjMatchMeta;
}

type OpenDialog = 'players' | 'lightning' | 'notes' | 'adjust' | 'forfeit' | null;

/** How often, at most, to tell tournament control how the game is going. Matches MODAQ's old timer. */
const progressIntervalMs = 5000;

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
  const {
    format,
    setup,
    events,
    tournamentName,
    roundName,
    roomName,
    connection,
    degradedMessage,
    saved,
    onSubmit,
    onDownload,
    onProgress,
    qbjMeta,
  } = props;

  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<IScorerSubmitResult | null>(null);

  const game = useMemo(() => deriveGame(format, setup, events.events), [format, setup, events.events]);
  const { phase } = game;
  const qbj = useMemo(() => toQbjMatch(format, game, qbjMeta), [format, game, qbjMeta]);

  /** The question anything recorded now belongs to. */
  const currentQuestion = phase.kind === 'complete' ? game.tossupsRead : phase.questionNumber;

  /**
   * Tell tournament control how the game is going, but not on every click.
   *
   * The derived game changes with each buzz, and posting a snapshot for each one would put a request
   * on the wire every time a scorekeeper's finger comes down — far more than MODAQ's five-second
   * timer ever did, and enough on a room full of Chromebooks to look like a server fault. So: send
   * at most once per interval, and always send a trailing update so the last thing that happened is
   * never the thing that got dropped.
   */
  const lastProgressAt = useRef(0);
  useEffect(() => {
    if (!onProgress) return undefined;
    const sinceLast = Date.now() - lastProgressAt.current;
    if (sinceLast >= progressIntervalMs) {
      lastProgressAt.current = Date.now();
      onProgress(qbj, game.tossupsRead);
      return undefined;
    }
    const timer = setTimeout(() => {
      lastProgressAt.current = Date.now();
      onProgress(qbj, game.tossupsRead);
    }, progressIntervalMs - sinceLast);
    return () => clearTimeout(timer);
  }, [onProgress, qbj, game.tossupsRead]);

  const record = useCallback((...added: ScoreEvent[]) => events.append(...added), [events]);

  const recordBuzz = useCallback(
    (team: LeftOrRight, playerName: string, answerType: IScorekeeperAnswerType) => {
      if (phase.kind !== 'tossup') return;
      record({
        id: newEventId(),
        type: 'tossup-buzz',
        questionNumber: phase.questionNumber,
        team,
        playerName,
        answerTypeIndex: answerType.index,
      });
    },
    [record, phase],
  );

  const recordNoBuzz = useCallback(() => {
    if (phase.kind !== 'tossup') return;
    record({ id: newEventId(), type: 'tossup-dead', questionNumber: phase.questionNumber });
  }, [record, phase]);

  const recordBonus = useCallback(
    (controlledPoints: number, bouncebackPoints?: number) => {
      if (phase.kind !== 'bonus') return;
      record({
        id: newEventId(),
        type: 'bonus',
        questionNumber: phase.questionNumber,
        team: phase.team,
        controlledPoints,
        bouncebackPoints,
      });
    },
    [record, phase],
  );

  // Space records an unanswered tossup, but only when the keyboard is not already aimed at
  // something: with focus on a button, Space is that button, and stealing it would score the wrong
  // thing. Ctrl/Cmd+Z is undo, which is the one shortcut every scorekeeper already expects.
  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      const target = keyEvent.target as HTMLElement | null;
      const inControl = !!target?.closest('button, input, select, textarea, [role="dialog"]');

      if ((keyEvent.metaKey || keyEvent.ctrlKey) && keyEvent.key.toLowerCase() === 'z') {
        keyEvent.preventDefault();
        if (keyEvent.shiftKey) events.redo();
        else events.undo();
        return;
      }
      if (keyEvent.key === ' ' && !inControl && dialog === null && phase.kind === 'tossup') {
        keyEvent.preventDefault();
        recordNoBuzz();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [events, recordNoBuzz, dialog, phase.kind]);

  const scoringEnabled = phase.kind === 'tossup';
  const eligible = (side: LeftOrRight) => phase.kind === 'tossup' && phase.eligibleTeams.includes(side);

  /** Things worth saying before a result is sent, without stopping anybody scoring. */
  const warnings = useMemo(() => {
    const found: string[] = [];
    const unfinished = game.questions.filter((question) => !question.resolved || question.awaitingBonus);
    if (unfinished.length > 0) {
      found.push(
        `Question ${unfinished[0].questionNumber} is not finished${
          unfinished.length > 1 ? ` (and ${unfinished.length - 1} more)` : ''
        }.`,
      );
    }
    if (game.left.points === game.right.points && phase.kind === 'complete') found.push('This game is a tie.');
    return found;
  }, [game, phase.kind]);

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

  const menuItems: IGameMenuItem[] = [
    { label: 'Players', onSelect: () => setDialog('players') },
    { label: 'Notes', onSelect: () => setDialog('notes') },
  ];
  if (format.lightning.enabled)
    menuItems.push({ label: 'Lightning / worksheet', onSelect: () => setDialog('lightning') });
  if (format.regulation.timed && !game.regulationComplete) {
    menuItems.push({
      label: 'End regulation',
      onSelect: () => record({ id: newEventId(), type: 'end-regulation', questionNumber: currentQuestion }),
    });
  }
  if (onDownload) menuItems.push({ label: 'Download QBJ', onSelect: () => onDownload(qbj) });
  menuItems.push({ label: 'Adjust score', onSelect: () => setDialog('adjust') });
  if (phase.kind !== 'complete') {
    menuItems.push({ label: 'Record forfeit', onSelect: () => setDialog('forfeit'), destructive: true });
  }

  const submit = async () => {
    setSubmitting(true);
    setSubmitResult(null);
    try {
      setSubmitResult(await onSubmit(qbj));
    } catch {
      setSubmitResult({ ok: false, message: 'This result could not be sent. It is still saved on this device.' });
    } finally {
      setSubmitting(false);
    }
  };

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
                <p className="scorer-complete-title">
                  Game complete{phase.reason === 'forfeit' && <> &mdash; forfeit</>}
                </p>
                <p className="scorer-complete-score">
                  <span>
                    {game.left.name} <strong>{game.left.points}</strong>
                  </span>
                  <span>
                    {game.right.name} <strong>{game.right.points}</strong>
                  </span>
                </p>
                <p className="scorer-complete-detail">
                  {game.tossupsRead} tossup{game.tossupsRead === 1 ? '' : 's'} heard
                  {game.overtimeTossupsRead > 0 && <>, {game.overtimeTossupsRead} in overtime</>}
                </p>
                {warnings.map((warning) => (
                  <p key={warning} className="scorer-complete-warning">
                    {warning}
                  </p>
                ))}
                <div className="scorer-complete-actions">
                  <button type="button" className="scorer-submit" onClick={submit} disabled={submitting}>
                    {submitting ? 'Sending…' : 'Submit result'}
                  </button>
                  {onDownload && (
                    <button type="button" className="scorer-action" onClick={() => onDownload(qbj)}>
                      Download QBJ
                    </button>
                  )}
                </div>
                {submitResult && (
                  <p className={submitResult.ok ? 'scorer-complete-ok' : 'scorer-complete-warning'}>
                    {submitResult.message}
                  </p>
                )}
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
        <GameMenu items={menuItems} />
        {warnings.length > 0 && phase.kind !== 'complete' && (
          <span className="scorer-footer-warning">{warnings[0]}</span>
        )}
      </footer>

      {dialog === 'players' && (
        <PlayersDialog
          left={game.left}
          right={game.right}
          maximumActive={format.players.maximumActive}
          questionNumber={currentQuestion}
          onSubstitute={(team, activePlayers) => {
            record({ id: newEventId(), type: 'substitution', questionNumber: currentQuestion, team, activePlayers });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'lightning' && (
        <LightningDialog
          format={format}
          game={game}
          onRecord={(team, points) =>
            record({ id: newEventId(), type: 'lightning', questionNumber: currentQuestion, team, points })
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'notes' && (
        <NotesDialog
          questionNumber={currentQuestion}
          existing={game.notes}
          onRecord={(text, flagged) => {
            record({ id: newEventId(), type: 'note', questionNumber: currentQuestion, text, flagged });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'adjust' && (
        <AdjustDialog
          game={game}
          onAdjust={(team, points, reason) => {
            record({ id: newEventId(), type: 'adjustment', questionNumber: currentQuestion, team, points, reason });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'forfeit' && (
        <ForfeitDialog
          game={game}
          onForfeit={(teams) => {
            record({ id: newEventId(), type: 'forfeit', questionNumber: currentQuestion, teams });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
