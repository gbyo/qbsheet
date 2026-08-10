import { useCallback, useEffect, useMemo, useState } from 'react';
import { RoomConnectionState } from '../app/ConnectionState';
import ScorerHost from '../scorer/ScorerHost';
import { clearGame } from '../scorer/GameSession';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { LeftOrRight } from '../scoring/types';
import PracticeCoach from './PracticeCoach';
import {
  IPracticeStep,
  practiceFormat,
  practiceLeftTeam,
  practiceRightTeam,
  practiceSteps,
} from './PracticeScenario';

export const practiceGameKey = 'qbsheet-guided-practice-v1';
const practiceCompletedKey = 'qbsheet.practice.completed.v1';
const practiceProgressKey = 'qbsheet.practice.progress.v2';

interface IPracticeProgress {
  stepIndex: number;
  acceptedEventCount: number;
}

const initialProgress: IPracticeProgress = { stepIndex: 0, acceptedEventCount: 0 };

export function clearPracticeProgress(): void {
  try {
    window.localStorage.removeItem(practiceProgressKey);
  } catch {
    // Practice still works without persistence.
  }
}

function readPracticeProgress(): IPracticeProgress {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(practiceProgressKey) ?? '') as Partial<IPracticeProgress>;
    if (
      Number.isInteger(parsed.stepIndex) &&
      Number.isInteger(parsed.acceptedEventCount) &&
      (parsed.stepIndex as number) >= 0 &&
      (parsed.stepIndex as number) < practiceSteps.length &&
      (parsed.acceptedEventCount as number) >= 0
    ) {
      return { stepIndex: parsed.stepIndex as number, acceptedEventCount: parsed.acceptedEventCount as number };
    }
  } catch {
    // A stale or unavailable marker should never stop practice from opening.
  }
  return initialProgress;
}

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
  return (
    lineups.some(
      (event) => event.team === 'left' && samePlayers(event.activePlayers, practiceLeftTeam.startingLineup),
    ) &&
    lineups.some(
      (event) => event.team === 'right' && samePlayers(event.activePlayers, practiceRightTeam.startingLineup),
    )
  );
}

function practiceLineupBoundary(events: ScoreEvent[]): number | undefined {
  let left = -1;
  let right = -1;
  events.forEach((event, index) => {
    if (event.type !== 'substitution' || event.questionNumber !== 1) return;
    if (event.team === 'left' && samePlayers(event.activePlayers, practiceLeftTeam.startingLineup)) left = index;
    if (event.team === 'right' && samePlayers(event.activePlayers, practiceRightTeam.startingLineup)) right = index;
  });
  return left >= 0 && right >= 0 ? Math.max(left, right) + 1 : undefined;
}

/**
 * Find the last guided checkpoint the current event history still proves.
 *
 * This is what lets the coach survive reloads and recover when an older action is undone. The undo
 * lesson itself leaves no event behind, so a previously reached step may be used to remember that
 * one lesson; every scoring and correction step is re-proved from the current scoresheet.
 */
export function replayPracticeProgress(events: ScoreEvent[], furthestStepIndex = 0): IPracticeProgress {
  const boundary = practiceLineupBoundary(events);
  if (boundary === undefined) return initialProgress;

  let acceptedEventCount = boundary;
  let stepIndex = 1;
  while (stepIndex < practiceSteps.length) {
    const step = practiceSteps[stepIndex];
    const expectation = step.expectation;
    if (expectation.kind === 'event') {
      const nextExpectation = practiceSteps[stepIndex + 1]?.expectation;
      // The deliberately wrong Q6 ruling is removed by the following Undo lesson. Once that lesson
      // has been reached, its absence is evidence of success rather than a reason to rewind.
      if (nextExpectation?.kind === 'undo' && furthestStepIndex > stepIndex + 1) {
        stepIndex += 2;
        continue;
      }
      const candidate = events[acceptedEventCount];
      if (!candidate || !expectation.matches(candidate)) {
        // An explicit history-correction lesson can replace an event that an earlier lesson
        // originally recorded. Once that correction has been reached and is present, consume the
        // corrected event in the same position instead of rewinding to the obsolete instruction.
        const superseded = practiceSteps.some(
          (laterStep, laterIndex) =>
            laterIndex <= furthestStepIndex &&
            laterStep.expectation.kind === 'history' &&
            laterStep.expectation.supersedes?.includes(step.id) === true &&
            laterStep.expectation.matches(events),
        );
        if (!candidate || !superseded) break;
      }
      acceptedEventCount += 1;
      stepIndex += 1;
      continue;
    }
    if (expectation.kind === 'history') {
      if (!expectation.matches(events)) break;
      stepIndex += 1;
      continue;
    }
    if (expectation.kind === 'undo') {
      if (furthestStepIndex <= stepIndex) break;
      stepIndex += 1;
      continue;
    }
    break;
  }
  return { stepIndex, acceptedEventCount };
}

function practiceStartingLineupProblem(lineups: Partial<Record<LeftOrRight, string[]>>): string | undefined {
  const left = lineups.left;
  const right = lineups.right;
  if (
    left &&
    right &&
    samePlayers(left, practiceLeftTeam.startingLineup) &&
    samePlayers(right, practiceRightTeam.startingLineup)
  ) {
    return undefined;
  }
  return 'The starting lineup does not match the scenario. Adjust the lineup or open Show me where, then try again.';
}

function unexpectedMessage(step: IPracticeStep): string {
  if (step.expectation.kind === 'event') {
    return 'That recorded something different from the call. Use Undo to remove it, then try the situation again.';
  }
  if (step.expectation.kind === 'undo') {
    return 'The correction should remove the last scoring action. Use Undo before recording the corrected ruling.';
  }
  if (step.expectation.kind === 'history') {
    return 'That question still does not match the correction. Open it from Recent, update the player, and save.';
  }
  return 'Review the situation or open Show me where, then try again.';
}

export default function PracticeScreen({ onHome }: { onHome: () => void }) {
  const [run, setRun] = useState(0);
  const [progress, setProgress] = useState(readPracticeProgress);
  const { stepIndex, acceptedEventCount } = progress;
  const [feedback, setFeedback] = useState('');
  const [mistake, setMistake] = useState('');
  const [complete, setComplete] = useState(false);
  const step = practiceSteps[stepIndex];

  useEffect(() => {
    if (complete) {
      clearPracticeProgress();
      return;
    }
    try {
      window.localStorage.setItem(practiceProgressKey, JSON.stringify(progress));
    } catch {
      // The live coach remains authoritative when persistence is unavailable.
    }
  }, [complete, progress]);

  const advance = useCallback(
    (nextAcceptedCount: number) => {
      setFeedback(step.success);
      setMistake('');
      setProgress((current) => ({
        acceptedEventCount: nextAcceptedCount,
        stepIndex: Math.min(current.stepIndex + 1, practiceSteps.length - 1),
      }));
    },
    [step.success],
  );

  const observe = useCallback(
    (events: ScoreEvent[]) => {
      if (complete) return;

      const replayed = replayPracticeProgress(events, stepIndex);
      if (replayed.stepIndex < stepIndex && step.expectation.kind !== 'undo') {
        setProgress(replayed);
        setFeedback('The guide moved back to the first step affected by that change.');
        setMistake('');
        return;
      }

      if (step.expectation.kind === 'lineup') {
        const boundary = practiceLineupBoundary(events);
        if (boundary !== undefined) advance(boundary);
        return;
      }

      if (step.expectation.kind === 'event') {
        if (events.length <= acceptedEventCount) {
          if (events.length === acceptedEventCount) setMistake('');
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

      if (step.expectation.kind === 'history') {
        if (step.expectation.matches(events)) advance(acceptedEventCount);
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
    [acceptedEventCount, advance, complete, step, stepIndex],
  );

  const restart = useCallback(() => {
    clearGame(practiceGameKey);
    clearPracticeProgress();
    setRun((current) => current + 1);
    setProgress(initialProgress);
    setFeedback('');
    setMistake('');
    setComplete(false);
  }, []);

  const finish = useCallback(async () => {
    if (step.expectation.kind !== 'submit') {
      return { ok: false, message: 'Finish the guided steps before submitting the practice game.' };
    }
    clearGame(practiceGameKey);
    clearPracticeProgress();
    rememberCompletion();
    setFeedback(step.success);
    setMistake('');
    setComplete(true);
    return { ok: true, message: 'Practice complete.' };
  }, [step]);

  const coach = useMemo(() => {
    return (
      <PracticeCoach
        step={step}
        stepIndex={stepIndex}
        stepCount={practiceSteps.length}
        feedback={feedback}
        mistake={mistake}
        onRestart={restart}
        onLeave={() => {
          clearGame(practiceGameKey);
          clearPracticeProgress();
          onHome();
        }}
      />
    );
  }, [feedback, mistake, onHome, restart, step, stepIndex]);

  if (complete) {
    return (
      <main className="shell practice-complete">
        <p className="practice-label">Practice</p>
        <h1 className="shell-title">You scored a complete practice game.</h1>
        <p>
          You handled powers, normal and zero-point wrong answers, a neg and rebound, bonuses, no buzz, an earlier
          question correction, Undo, a substitution and final review using the same scorer used in a real room.
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
      <div className="practice-banner">Practice game · Local only — not sent or added to Recent Games.</div>
      <ScorerHost
        key={`${practiceGameKey}-${run}`}
        gameKey={practiceGameKey}
        format={practiceFormat}
        requiredStarterCount={{ left: 4, right: 4 }}
        validateStartingLineups={practiceStartingLineupProblem}
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
