import { useCallback, useEffect, useMemo, useState } from 'react';
import { RoomConnectionState } from '../app/ConnectionState';
import ScorerHost from '../scorer/ScorerHost';
import { clearGame } from '../scorer/GameSession';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { LeftOrRight } from '../scoring/types';
import PracticeCoach from './PracticeCoach';
import KeyboardDrill from './KeyboardDrill';
import PracticeSummary from './PracticeSummary';
import {
  IPracticeStep,
  practiceFormat,
  practiceLeftTeam,
  practiceLineupMatches,
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
    const parsed = JSON.parse(
      window.localStorage.getItem(practiceProgressKey) ?? '',
    ) as Partial<IPracticeProgress>;
    if (
      Number.isInteger(parsed.stepIndex) &&
      Number.isInteger(parsed.acceptedEventCount) &&
      (parsed.stepIndex as number) >= 0 &&
      (parsed.stepIndex as number) < practiceSteps.length &&
      (parsed.acceptedEventCount as number) >= 0
    ) {
      return {
        stepIndex: parsed.stepIndex as number,
        acceptedEventCount: parsed.acceptedEventCount as number,
      };
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

/** The real scorer records initial lineups as Q1 substitution events, one per team. */
export function practiceLineupsRecorded(events: ScoreEvent[]): boolean {
  const lineups = events.filter(
    (event): event is Extract<ScoreEvent, { type: 'substitution' }> =>
      event.type === 'substitution' && event.questionNumber === 1,
  );
  return (
    lineups.some(
      (event) =>
        event.team === 'left' && practiceLineupMatches(event.activePlayers, practiceLeftTeam.startingLineup),
    ) &&
    lineups.some(
      (event) =>
        event.team === 'right' &&
        practiceLineupMatches(event.activePlayers, practiceRightTeam.startingLineup),
    )
  );
}

function practiceLineupBoundary(events: ScoreEvent[]): number | undefined {
  let left = -1;
  let right = -1;
  events.forEach((event, index) => {
    if (event.type !== 'substitution' || event.questionNumber !== 1) return;
    if (event.team === 'left' && practiceLineupMatches(event.activePlayers, practiceLeftTeam.startingLineup))
      left = index;
    if (
      event.team === 'right' &&
      practiceLineupMatches(event.activePlayers, practiceRightTeam.startingLineup)
    )
      right = index;
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

/** "Gibson, Jeremy, Owen and Lachlan" — a list a person reads rather than an array. */
function nameList(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Why this side's lineup is not the scenario's — said precisely enough to act on.
 *
 * The seat order matters, and not only to the script. A seat is the number the keyboard addresses and the
 * row the tossups-heard count is kept in, so who sits where is a real property of a real scoresheet and
 * practice teaching a fixed one is teaching something true. What was wrong was never that practice
 * insisted; it was that it said "does not match the scenario" without saying *what* did not match, so the
 * scorekeeper who read four names off the guide and put them in the wrong order was left comparing two
 * lists of four identical names to find a difference that was in their order.
 *
 * So this tells the scorekeeper which players to Bench or Start, or points at the ↑/↓ controls when the
 * names are right but their seat order is not.
 */
function practiceLineupProblem(side: LeftOrRight, chosen: readonly string[] | undefined): string | undefined {
  const team = side === 'left' ? practiceLeftTeam : practiceRightTeam;
  const expected = team.startingLineup;
  const selected = chosen ?? [];
  const extra = selected.filter((player) => !expected.includes(player));
  const missing = expected.filter((player) => !selected.includes(player));

  if (extra.length > 0 && missing.length > 0) {
    return `Bench ${nameList(extra)} and start ${nameList(missing)}.`;
  }
  if (missing.length > 0) return `Start ${nameList(missing)}.`;
  if (extra.length > 0) return `Bench ${nameList(extra)}.`;
  if (selected.length !== expected.length) return `Start ${nameList(expected)}.`;

  const seat = expected.findIndex((player, index) => selected[index] !== player);
  if (seat >= 0) {
    return `Use the ↑/↓ controls to put ${nameList(expected)} in that order.`;
  }
  return undefined;
}

function practiceStartingLineupProblem(lineups: Partial<Record<LeftOrRight, string[]>>): string | undefined {
  // One side at a time. Two lineups' worth of correction in one line is a paragraph nobody reads.
  return practiceLineupProblem('left', lineups.left) ?? practiceLineupProblem('right', lineups.right);
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

export default function PracticeScreen({
  onHome,
  operatorName,
}: {
  onHome: () => void;
  operatorName?: string;
}) {
  const [run, setRun] = useState(0);
  const [progress, setProgress] = useState(readPracticeProgress);
  const { stepIndex, acceptedEventCount } = progress;
  const [feedback, setFeedback] = useState('');
  const [mistake, setMistake] = useState('');
  const [complete, setComplete] = useState(false);
  /**
   * The keyboard drill, offered from the completion screen and held here rather than in `App`.
   *
   * Practice owns its own aftermath: the drill is reachable only from the end of a practice game, it needs
   * nothing the application knows, and keeping it inside this screen means the `practice` screen is still
   * the one thing on the outside — including for `updatesAllowedOn`, which refuses to swap the build under
   * somebody who is halfway through learning the software.
   */
  const [drill, setDrill] = useState(false);
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
    setDrill(false);
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

  if (complete && drill) {
    return <KeyboardDrill onBack={() => setDrill(false)} onHome={onHome} />;
  }

  if (complete) {
    return <PracticeSummary onRestart={restart} onHome={onHome} onDrill={() => setDrill(true)} />;
  }

  return (
    <div className="practice-mode">
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
        operatorName={operatorName}
        connection={RoomConnectionState.Connected}
        /*
         * The header says Practice, not Connected. There is no tournament control behind a practice
         * game, so "Connected" was a claim about a server nobody asked — and the one word the
         * scoring screen spends on status is better spent saying which kind of game this is. It also
         * replaces the strip that used to sit above the scorer saying the same thing at length: the
         * title already reads QBSheet Practice, and a banner repeating it cost a line of a 768px
         * screen on every question.
         */
        statusLabel="Practice"
        onSubmit={finish}
        onDownload={() => undefined}
        onEventsChanged={observe}
        alerts={[]}
        recovery={{ automaticDelivery: false, tournamentControl: false }}
      />
      {coach}
    </div>
  );
}
