/**
 * What has just happened, newest first — and the fastest way back to it.
 *
 * Only real events. An empty table of twenty numbered rows waiting to be filled is a worse thing to
 * put next to a scorekeeper than nothing at all: it draws the eye, it says nothing, and it makes the
 * one line that matters — the question just scored — harder to find.
 *
 * # Why the rows are buttons
 *
 * Because "that last one was wrong" is the most common thing a scorekeeper says, and the rail is
 * where they are already looking when they say it. A read-only rail sends them to a menu, then to a
 * dialog, then down a list of every question in the game to find the one that is on screen in front
 * of them. Clicking it opens the review at that question instead.
 *
 * The running score is here for the same reason a paper sheet has a score column: it is what the
 * moderator reads out at the break and what the room checks against, and reconstructing it by adding
 * up a rail is exactly the arithmetic this software exists to remove.
 *
 * On narrower layouts this same source renders only its latest line in a fixed-height compact strip;
 * older activity remains behind scoresheet review instead of moving below the scoring controls.
 */
import { IDerivedGame, IDerivedQuestion } from '../scoring/deriveGame';

export interface IRecentRailProps {
  game: IDerivedGame;
  /** How many questions to show on the wide rail; older questions live in the scoresheet review. */
  limit?: number;
  /** Open the full scoresheet review at this question. */
  onInspect?: (questionNumber: number) => void;
  /**
   * Briefly wash one row, because something just changed it.
   *
   * A correction saved elsewhere and an undo both change a line that is already on screen, and the
   * rail redrawing silently is exactly the problem: the numbers are different and nothing said which
   * ones. The emphasis points at the line rather than describing it, and it is temporary on purpose —
   * a question that stayed marked would be claiming that having been corrected is a property of the
   * question, which it is not. There is no badge and no colour for the same reason.
   *
   * The host owns how long it lasts and clears it. A question no longer in the rail simply matches
   * nothing, which is the right answer: an undo that removed the last question has no row to point
   * at, and inventing an exit for a row that is already gone would be animating a fiction.
   */
  emphasizeQuestion?: number;
  /** One presentation frame for the question an undo removed or a redo restored. */
  motion?: IRecentMotion;
}

export interface IRecentMotion {
  questionNumber: number;
  kind: 'undo' | 'redo';
  token: number;
  /** The inert copy used only when undo removed the real row immediately. */
  snapshot?: IDerivedQuestion;
}

/** "+15" / "-5", so a neg reads as a neg at a glance. */
function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * One line of activity, split so the points can be set in their own column.
 *
 * A rail of "Sarah Mitchell +15" strings has its numbers wherever the names happen to end, which
 * makes the one thing worth scanning — did that question go 10 or 15, 20 or 30 — the hardest thing
 * on it to find. Separating the value lets it be right-aligned against a rule.
 */
interface IRailLine {
  what: string;
  points: string;
}

function questionLines(question: IDerivedQuestion, teamNames: { left: string; right: string }): IRailLine[] {
  if (question.dead && question.buzzes.length === 0 && question.noPenalty.length === 0) {
    return [{ what: 'No buzz', points: '' }];
  }

  const lines: IRailLine[] = question.buzzes.map((buzz) => ({
    what: buzz.playerName,
    points: signed(buzz.answerType.value),
  }));
  for (const missed of question.noPenalty) {
    lines.push({ what: missed.playerName ?? `${teamNames[missed.team]} wrong`, points: '0' });
  }
  if (question.bonus) {
    lines.push({ what: `${teamNames[question.bonus.team]} bonus`, points: `+${question.bonus.controlledPoints}` });
    if (question.bonus.bouncebackPoints > 0) {
      const other = question.bonus.team === 'left' ? 'right' : 'left';
      lines.push({ what: `${teamNames[other]} bounceback`, points: `+${question.bonus.bouncebackPoints}` });
    }
  }
  return lines;
}

function QuestionBody(props: {
  question: IDerivedQuestion;
  teamNames: { left: string; right: string };
  marked: boolean;
  statusText?: string;
}) {
  const { question, teamNames, marked, statusText } = props;
  return (
    <>
      <span className="scorer-rail-q">
        Q{question.questionNumber}
        {question.period === 'overtime' && <span className="scorer-rail-ot">OT</span>}
        {question.replaced && (
          <span className="scorer-rail-mark" title="Replaced question" aria-hidden="true">
            R
          </span>
        )}
        {marked && (
          <span
            className="scorer-rail-mark is-flagged"
            title={question.openProtests > 0 ? 'Protest outstanding' : 'Flagged for tournament control'}
            aria-hidden="true"
          >
            !
          </span>
        )}
        {statusText && <span className="visually-hidden"> {statusText}</span>}
      </span>
      <span className="scorer-rail-lines">
        {questionLines(question, teamNames).map((line, index) => (
          // Position is the identity: identical activity lines may legitimately repeat.
          <span key={index} className="scorer-rail-line">
            <span className="scorer-rail-what">{line.what}</span>
            <span className="scorer-rail-points">{line.points}</span>
          </span>
        ))}
      </span>
      <span className="scorer-rail-running" aria-label="Score after this question">
        {question.scoreAfter.left}&ndash;{question.scoreAfter.right}
      </span>
    </>
  );
}

export default function RecentRail(props: IRecentRailProps) {
  const { game, limit = 8, onInspect, emphasizeQuestion, motion } = props;
  const teamNames = { left: game.left.name, right: game.right.name };
  const recent = game.questions.slice(-limit).reverse();
  const flaggedQuestions = new Set(game.notes.filter((note) => note.flagged).map((note) => note.questionNumber));
  const latest = recent[0] ?? (motion?.kind === 'undo' ? motion.snapshot : undefined);
  const latestLines = latest ? questionLines(latest, teamNames) : [];
  const latestSummary = latest
    ? latestLines.map((line) => `${line.what}${line.points ? ` ${line.points}` : ''}`).join(' · ')
    : 'Nothing scored yet';
  const latestMarked = latest ? latest.openProtests > 0 || flaggedQuestions.has(latest.questionNumber) : false;

  return (
    <aside className="scorer-rail" aria-label="Recent activity">
      <div className="scorer-rail-wide">
        <h2 className="scorer-rail-heading">Recent</h2>
        {recent.length === 0 && !(motion?.kind === 'undo' && motion.snapshot) ? (
          <p className="scorer-rail-empty">Nothing scored yet.</p>
        ) : (
          <ol className="scorer-rail-list">
            {motion?.kind === 'undo' &&
              motion.snapshot &&
              !recent.some((question) => question.questionNumber === motion.questionNumber) && (
                <li
                  key={`undo-${motion.token}`}
                  className="scorer-rail-item is-motion-ghost is-undoing"
                  aria-hidden="true"
                >
                  <QuestionBody question={motion.snapshot} teamNames={teamNames} marked={false} />
                </li>
              )}
            {recent.map((question) => {
              const marked = question.openProtests > 0 || flaggedQuestions.has(question.questionNumber);
              const status = [
                question.replaced ? 'replaced question' : '',
                question.openProtests > 0 ? 'protest outstanding' : '',
                flaggedQuestions.has(question.questionNumber) && question.openProtests === 0
                  ? 'flagged for tournament control'
                  : '',
              ]
                .filter(Boolean)
                .join(', ');
              const body = <QuestionBody question={question} teamNames={teamNames} marked={marked} statusText={status} />;
              const isMotionTarget = question.questionNumber === motion?.questionNumber;

              return (
                <li
                  key={isMotionTarget ? `${question.questionNumber}-${motion.token}` : question.questionNumber}
                  // The class is the whole emphasis: the button inside it is untouched, so a row being
                  // pointed at is still a row that opens the question when it is pressed.
                  className={[
                    'scorer-rail-item',
                    question.questionNumber === emphasizeQuestion ? 'is-emphasized' : '',
                    isMotionTarget ? (motion.kind === 'undo' ? 'is-undoing' : 'is-redoing') : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-motion-token={isMotionTarget ? motion.token : undefined}
                >
                  {onInspect ? (
                    <button
                      type="button"
                      className="scorer-rail-open"
                      onClick={() => onInspect(question.questionNumber)}
                      aria-label={`Review question ${question.questionNumber}${status ? `, ${status}` : ''}`}
                    >
                      {body}
                    </button>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <div className="scorer-rail-compact">
        {latest && onInspect ? (
          <button
            type="button"
            className={[
              'scorer-rail-compact-open',
              latest.questionNumber === emphasizeQuestion ? 'is-emphasized' : '',
              latest.questionNumber === motion?.questionNumber
                ? motion.kind === 'undo'
                  ? 'is-undoing'
                  : 'is-redoing'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            data-motion-token={latest.questionNumber === motion?.questionNumber ? motion.token : undefined}
            onClick={() => onInspect(latest.questionNumber)}
            aria-label={`Review latest question ${latest.questionNumber}${latestMarked ? ', flagged' : ''}`}
          >
            <span className="scorer-rail-compact-label">Recent</span>
            <span className="scorer-rail-compact-summary">
              Q{latest.questionNumber} · {latestSummary}
            </span>
            <span className="scorer-rail-compact-score" aria-label="Latest running score">
              {latest.scoreAfter.left}&ndash;{latest.scoreAfter.right}
            </span>
          </button>
        ) : (
          <span className="scorer-rail-compact-empty">
            <span className="scorer-rail-compact-label">Recent</span>
            <span className="scorer-rail-compact-summary">Nothing scored yet</span>
            <span className="scorer-rail-compact-score" aria-hidden="true">
              {game.left.points}&ndash;{game.right.points}
            </span>
          </span>
        )}
      </div>
    </aside>
  );
}
