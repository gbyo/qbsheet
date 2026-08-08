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
  if (question.dead && question.buzzes.length === 0) return [{ what: 'No buzz', points: '' }];

  const lines: IRailLine[] = question.buzzes.map((buzz) => ({
    what: buzz.playerName,
    points: signed(buzz.answerType.value),
  }));
  if (question.bonus) {
    lines.push({ what: `${teamNames[question.bonus.team]} bonus`, points: `+${question.bonus.controlledPoints}` });
    if (question.bonus.bouncebackPoints > 0) {
      const other = question.bonus.team === 'left' ? 'right' : 'left';
      lines.push({ what: `${teamNames[other]} bounceback`, points: `+${question.bonus.bouncebackPoints}` });
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
                {questionLines(question, teamNames).map((line, index) => (
                  // Position is the identity: identical activity lines may legitimately repeat.
                  // eslint-disable-next-line react/no-array-index-key
                  <span key={index} className="scorer-rail-line">
                    <span className="scorer-rail-what">{line.what}</span>
                    <span className="scorer-rail-points">{line.points}</span>
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
