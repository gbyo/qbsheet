/**
 * What has just happened, newest first.
 *
 * Only real events. An empty table of twenty numbered rows waiting to be filled is a worse thing to
 * put next to a scorekeeper than nothing at all: it draws the eye, it says nothing, and it makes the
 * one line that matters — the question just scored — harder to find.
 */
import { IDerivedGame, IDerivedQuestion } from '../scoring/deriveGame';

export interface IRecentRailProps {
  game: IDerivedGame;
  /** How many questions to show. The rail is narrow; older questions live in the scoresheet review. */
  // eslint-disable-next-line react/require-default-props
  limit?: number;
}

/** "+15" / "-5", so a neg reads as a neg at a glance. */
function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function questionLines(question: IDerivedQuestion, teamNames: { left: string; right: string }): string[] {
  if (question.dead && question.buzzes.length === 0) return ['No buzz'];

  const lines = question.buzzes.map((buzz) => `${buzz.playerName} ${signed(buzz.answerType.value)}`);
  if (question.bonus) {
    lines.push(`${teamNames[question.bonus.team]} bonus +${question.bonus.controlledPoints}`);
    if (question.bonus.bouncebackPoints > 0) {
      const other = question.bonus.team === 'left' ? 'right' : 'left';
      lines.push(`${teamNames[other]} bounceback +${question.bonus.bouncebackPoints}`);
    }
  }
  return lines;
}

export default function RecentRail(props: IRecentRailProps) {
  const { game, limit = 8 } = props;
  const teamNames = { left: game.left.name, right: game.right.name };
  const recent = game.questions.slice(-limit).reverse();

  return (
    <aside className="scorer-rail" aria-label="Recent activity">
      <h2 className="scorer-rail-heading">Recent</h2>
      {recent.length === 0 ? (
        <p className="scorer-rail-empty">Nothing scored yet.</p>
      ) : (
        <ol className="scorer-rail-list">
          {recent.map((question) => (
            <li key={question.questionNumber} className="scorer-rail-item">
              <span className="scorer-rail-q">
                Q{question.questionNumber}
                {question.period === 'overtime' && <span className="scorer-rail-ot">OT</span>}
              </span>
              <span className="scorer-rail-lines">
                {questionLines(question, teamNames).map((line) => (
                  <span key={line} className="scorer-rail-line">
                    {line}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
