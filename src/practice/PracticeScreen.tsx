import { useCallback, useMemo, useState } from 'react';
import { RoomConnectionState } from '../app/ConnectionState';
import ScorerHost from '../scorer/ScorerHost';
import { clearGame } from '../scorer/GameSession';
import { ScoreEvent } from '../scoring/ScoreEvents';
import {
  IPracticeStep,
  practiceFormat,
  practiceLeftTeam,
  practiceRightTeam,
  practiceSteps,
} from './PracticeScenario';

export const practiceGameKey = 'qbsheet-guided-practice-v1';
const practiceCompletedKey = 'qbsheet.practice.completed.v1';

function rememberCompletion(): void {
  try {
    window.localStorage.setItem(practiceCompletedKey, 'true');
  } catch {
    // Completion is only a convenience marker. Practice itself does not depend on it.
  }
}

function samePlayers(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every((player) => actual.includes(player));
}

/** The real scorer records initial lineups as Q1 substitution events, one per team. */
export function practiceLineupsRecorded(events: ScoreEvent[]): boolean {
  const lineups = events.filter(
    (event): event is Extract<ScoreEvent, { type: 'substitution' }> =>
      event.type === 'substitution' && event.questionNumber === 1,
  );
  const left = lineups.find((event) => event.team === 'left');
  const right = lineups.find((event) => event.team === 'right');
  return (
    left !== undefined &&
    right !== undefined &&
    samePlayers(left.activePlayers, practiceLeftTeam.startingLineup) &&
    samePlayers(right.activePlayers, practiceRightTeam.startingLineup)
  );
}

function unexpectedMessage(step: IPracticeStep): string {
  if (step.expectation.kind === 'event') {
    return 'That recorded something different from the call. Use Undo to remove it, then try the instruction again.';
  }
  if (step.expectation.kind === 'undo') {
    return 'The correction should remove the last scoring action. Use Undo before recording the corrected ruling.';
  }
  return 'Follow the practice instruction shown here, then try again.';
}

export default function PracticeScreen({ onHome }: { onHome: () => void }) {
  const [run, setRun] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [acceptedEventCount, setAcceptedEventCount] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [mistake, setMistake] = useState('');
  const [complete, setComplete] = useState(false);
  const step = practiceSteps[stepIndex];

  const advance = useCallback(
    (nextAcceptedCount: number) => {
      setFeedback(step.success);
      setMistake('');
      setAcceptedEventCount(nextAcceptedCount);
      setStepIndex((current) => Math.min(current + 1, practiceSteps.length - 1));
    },
    [step.success],
  );

  const observe = useCallback(
    (events: ScoreEvent[]) => {
      if (complete) return;

      if (step.expectation.kind === 'lineup') {
        if (practiceLineupsRecorded(events)) advance(events.length);
        return;
      }

      if (step.expectation.kind === 'event') {
        if (events.length <= acceptedEventCount) {
          if (events.length < acceptedEventCount) {
            setMistake('You undid an earlier completed practice step. Use Practice again to restart the guided sequence.');
          }
          return;
        }
        const candidate = events[acceptedEventCount];
        if (candidate && step.expectation.matches(candidate)) {
          advance(events.length);
        } else {
          setMistake(unexpectedMessage(step));
        }
        return;
      }

      if (step.expectation.kind === 'undo') {
        if (events.length === acceptedEventCount - 1) {
          advance(events.length);
        } else if (events.length > acceptedEventCount) {
          setMistake(unexpectedMessage(step));
        }
      }
    },
    [acceptedEventCount, advance, complete, step],
  );

  const restart = useCallback(() => {
    clearGame(practiceGameKey);
    setRun((current) => current + 1);
    setStepIndex(0);
    setAcceptedEventCount(0);
    setFeedback('');
    setMistake('');
    setComplete(false);
  }, []);

  const finish = useCallback(async () => {
    if (step.expectation.kind !== 'submit') {
      return { ok: false, message: 'Finish the guided steps before submitting the practice game.' };
    }
    clearGame(practiceGameKey);
    rememberCompletion();
    setFeedback(step.success);
    setMistake('');
    setComplete(true);
    return { ok: true, message: 'Practice complete.' };
  }, [step]);

  const coach = useMemo(() => {
    const progress = `${Math.min(stepIndex + 1, practiceSteps.length)} of ${practiceSteps.length}`;
    return (
      <aside className="practice-coach" aria-live="polite">
        <div className="practice-coach-topline">
          <span className="practice-label">Practice</span>
          <span className="practice-progress">{progress}</span>
        </div>
        <h2>{step.title}</h2>
        <p className="practice-call">{step.call}</p>
        <p className="practice-instruction">{step.instruction}</p>
        {feedback && <p className="practice-feedback is-success">✓ {feedback}</p>}
        {mistake && <p className="practice-feedback is-error">{mistake}</p>}
        <details className="practice-hint">
          <summary>Need a hint?</summary>
          <p>{step.hint}</p>
        </details>
        <div className="practice-actions">
          <button type="button" className="shell-button" onClick={restart}>
            Restart practice
          </button>
          <button
            type="button"
            className="shell-button shell-button-quiet"
            onClick={() => {
              clearGame(practiceGameKey);
              onHome();
            }}
          >
            Leave practice
          </button>
        </div>
      </aside>
    );
  }, [feedback, mistake, onHome, restart, step, stepIndex]);

  if (complete) {
    return (
      <main className="shell practice-complete">
        <p className="practice-label">Practice</p>
        <h1 className="shell-title">You scored a complete practice game.</h1>
        <p>
          You handled powers, normal tossups, a neg and rebound, bonuses, a dead tossup, Undo, a substitution and the
          final submission using the same scorer used in a real room.
        </p>
        <div className="practice-complete-actions">
          <button type="button" className="shell-button is-primary" onClick={restart}>
            Practice again
          </button>
          <button type="button" className="shell-button" onClick={onHome}>
            Back to QBSheet
          </button>
        </div>
      </main>
    );
  }

  return (
    <div className="practice-mode">
      <div className="practice-banner">Practice game · Nothing here is sent to tournament control or added to Recent Games.</div>
      <ScorerHost
        key={`${practiceGameKey}-${run}`}
        gameKey={practiceGameKey}
        format={practiceFormat}
        leftTeam={practiceLeftTeam}
        rightTeam={practiceRightTeam}
        tournamentName="QBSheet Practice"
        roundName="Guided game"
        roomName="Practice room"
        connection={RoomConnectionState.Connected}
        onSubmit={finish}
        onDownload={() => undefined}
        onEventsChanged={observe}
        alerts={[]}
        recovery={{ automaticDelivery: false }}
      />
      {coach}
    </div>
  );
}
