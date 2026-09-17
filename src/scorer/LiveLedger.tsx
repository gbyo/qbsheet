/**
 * The full-width history under the ruled scoresheet.
 *
 * This is deliberately a view of `game.questions`, not a second event reducer. The derived question
 * already owns replacements, bouncebacks, overtime, no-penalty answers and running totals; keeping
 * the ledger on that boundary means corrections and undo/redo redraw it for free.
 */
import { IDerivedGame, IDerivedQuestion, ScoringPhase } from '../scoring/deriveGame';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { LeftOrRight } from '../scoring/types';
import { DisplaySideMapping, identityDisplaySideMapping, mapSides } from './DisplaySideMapping';
import type { IRecentMotion } from './RecentRail';

export interface ILiveLedgerProps {
  game: IDerivedGame;
  format: IScorekeeperFormat;
  phase: ScoringPhase;
  currentQuestion: number;
  displaySides?: DisplaySideMapping;
  onInspect: (questionNumber: number) => void;
  emphasizeQuestion?: number;
  motion?: IRecentMotion;
}

function signed(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return '0';
}

function rulingDescription(question: IDerivedQuestion, side: LeftOrRight): string {
  const lines: string[] = [];
  for (const buzz of question.buzzes.filter((candidate) => candidate.team === side)) {
    const genericCorrect = /^correct$/i.test(buzz.answerType.label);
    const genericPower = buzz.answerType.isPower && buzz.answerType.label === String(buzz.answerType.value);
    const kind = buzz.answerType.isNeg
      ? 'neg '
      : genericCorrect
        ? ''
        : genericPower
          ? 'power '
          : `${buzz.answerType.label.toLocaleLowerCase()} `;
    lines.push(`${buzz.playerName} · ${kind}${signed(buzz.answerType.value)}`);
  }
  for (const missed of question.noPenalty.filter((candidate) => candidate.team === side)) {
    lines.push(`${missed.playerName ?? 'Team'} · wrong 0`);
  }
  if (lines.length > 0) return lines.join(' · ');
  if (question.dead && question.buzzes.length === 0 && question.noPenalty.length === 0) return 'No buzz';
  return '—';
}

function bonusDescription(question: IDerivedQuestion, format: IScorekeeperFormat): string {
  if (!question.bonus) return '—';
  const bounce = question.bonus.bouncebackPoints;
  return `${question.bonus.controlledPoints}${bounce > 0 ? ` + ${bounce} bounce` : ''} / ${format.bonus.maximumScore}`;
}

function liveDescription(
  phase: ScoringPhase,
  question: IDerivedQuestion | undefined,
  teamNames: Record<LeftOrRight, string>,
): string {
  switch (phase.kind) {
    case 'tossup':
      if (phase.eligibleTeams.length === 1) return `Live — awaiting ${teamNames[phase.eligibleTeams[0]]}`;
      if ((question?.buzzes.length ?? 0) > 0 || (question?.noPenalty.length ?? 0) > 0)
        return 'Live — waiting on the remaining team';
      return 'Live — waiting on a buzz';
    case 'bonus':
      return `Live — bonus for ${teamNames[phase.team]}`;
    case 'timeout':
      return `Live — timeout for ${teamNames[phase.team]}`;
    case 'score-check':
      return 'Live — score check';
    case 'checkpoint':
      return phase.checkpoint === 'overtime' ? 'Live — regulation complete' : 'Live — overtime checkpoint';
    case 'lineup':
      return 'Live — choose the starting lineups';
    case 'complete':
      return 'Game complete';
  }
}

export default function LiveLedger(props: ILiveLedgerProps) {
  const {
    game,
    format,
    phase,
    currentQuestion,
    onInspect,
    emphasizeQuestion,
    motion,
    displaySides = identityDisplaySideMapping,
  } = props;
  const displayedTeams = mapSides({ left: game.left, right: game.right }, displaySides);
  const canonicalNames = { left: game.left.name, right: game.right.name };
  const flagged = new Set(game.notes.filter((note) => note.flagged).map((note) => note.questionNumber));
  const complete = game.questions.filter((question) => question.resolved && !question.awaitingBonus);
  const liveQuestion = game.questions.find((question) => question.questionNumber === currentQuestion);
  const liveHasActivity =
    liveQuestion !== undefined && (liveQuestion.buzzes.length > 0 || liveQuestion.noPenalty.length > 0);
  const showLive = phase.kind !== 'lineup' && phase.kind !== 'complete';
  const liveScore = mapSides({ left: game.left.points, right: game.right.points }, displaySides);

  return (
    <section className="scorer-ledger" aria-label="This game so far">
      <header className="scorer-ledger-title">
        <h2>This game so far</h2>
        <p>Click any line to correct it</p>
      </header>
      <div className="scorer-ledger-columns" aria-hidden="true">
        <span>TU</span>
        <span>{displayedTeams.left.name}</span>
        <span>{displayedTeams.right.name}</span>
        <span>Bonus</span>
        <span>Score</span>
      </div>
      <div className="scorer-ledger-scroll">
        {motion?.kind === 'undo' &&
          motion.snapshot &&
          !complete.some((question) => question.questionNumber === motion.questionNumber) && (
            <div className="scorer-ledger-row is-motion-ghost is-undoing" aria-hidden="true">
              <span className="scorer-ledger-question">{motion.questionNumber}</span>
              <span className="scorer-ledger-live-copy">Question removed by undo</span>
              <span className="scorer-ledger-score">
                {mapSides(motion.snapshot.scoreAfter, displaySides).left} ·{' '}
                {mapSides(motion.snapshot.scoreAfter, displaySides).right}
              </span>
            </div>
          )}
        {complete.map((question) => {
          const displayedScore = mapSides(question.scoreAfter, displaySides);
          const noBuzz = question.dead && question.buzzes.length === 0 && question.noPenalty.length === 0;
          const left = noBuzz ? 'No buzz' : rulingDescription(question, displaySides.left);
          const right = noBuzz ? '—' : rulingDescription(question, displaySides.right);
          const marked = flagged.has(question.questionNumber) || question.openProtests > 0;
          const status = [
            question.period === 'overtime' ? 'overtime' : '',
            question.replaced ? 'replacement' : '',
            question.openProtests > 0 ? 'protest outstanding' : '',
            flagged.has(question.questionNumber) ? 'flagged' : '',
          ]
            .filter(Boolean)
            .join(', ');
          return (
            <button
              key={question.questionNumber}
              type="button"
              className={`scorer-ledger-row${question.questionNumber === emphasizeQuestion ? ' is-emphasized' : ''}${
                question.questionNumber === motion?.questionNumber ? ` is-${motion.kind}ing` : ''
              }`}
              onClick={() => onInspect(question.questionNumber)}
              aria-label={`Review question ${question.questionNumber}${status ? `, ${status}` : ''}`}
            >
              <span className="scorer-ledger-question">
                {question.questionNumber}
                {question.period === 'overtime' && <small>OT</small>}
                {question.replaced && <small>R</small>}
                {marked && <small>!</small>}
              </span>
              <span className={left.includes('neg ') ? 'is-neg' : undefined}>{left}</span>
              <span className={right.includes('neg ') ? 'is-neg' : undefined}>{right}</span>
              <span className="scorer-ledger-bonus">{bonusDescription(question, format)}</span>
              <span className="scorer-ledger-score" aria-label="Score after this question">
                {displayedScore.left} · {displayedScore.right}
              </span>
            </button>
          );
        })}
        {showLive && (
          <button
            type="button"
            className={`scorer-ledger-row is-live${
              currentQuestion === emphasizeQuestion ? ' is-emphasized' : ''
            }${currentQuestion === motion?.questionNumber ? ` is-${motion.kind}ing` : ''}`}
            aria-live="polite"
            aria-label={liveHasActivity ? `Review question ${currentQuestion}` : undefined}
            disabled={!liveHasActivity}
            onClick={() => onInspect(currentQuestion)}
          >
            <span className="scorer-ledger-question">{currentQuestion}</span>
            {liveHasActivity && liveQuestion ? (
              <>
                <span
                  className={
                    rulingDescription(liveQuestion, displaySides.left).includes('neg ') ? 'is-neg' : undefined
                  }
                >
                  {rulingDescription(liveQuestion, displaySides.left)}
                </span>
                <span
                  className={
                    rulingDescription(liveQuestion, displaySides.right).includes('neg ')
                      ? 'is-neg'
                      : undefined
                  }
                >
                  {rulingDescription(liveQuestion, displaySides.right)}
                </span>
                <strong className="scorer-ledger-live-bonus">
                  {phase.kind === 'bonus' ? 'Live bonus' : 'Live'}
                </strong>
              </>
            ) : (
              <strong className="scorer-ledger-live-copy">
                {liveDescription(phase, liveQuestion, canonicalNames)}
              </strong>
            )}
            <span className="scorer-ledger-score">
              {liveScore.left} · {liveScore.right}
            </span>
          </button>
        )}
        {complete.length === 0 && !showLive && <p className="scorer-ledger-empty">Nothing scored yet.</p>}
      </div>
    </section>
  );
}
