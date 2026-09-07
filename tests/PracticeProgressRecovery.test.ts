import { describe, expect, it } from 'vitest';
import { shouldReplayPracticeProgress } from '../src/practice/PracticeScreen';
import { practiceSteps } from '../src/practice/PracticeScenario';

describe('guided practice progress recovery', () => {
  const undoStepIndex = practiceSteps.findIndex((step) => step.expectation.kind === 'undo');

  it('keeps the expected one-action undo on its current lesson', () => {
    expect(undoStepIndex).toBeGreaterThan(0);
    expect(shouldReplayPracticeProgress(undoStepIndex, 12, 11, undoStepIndex - 1)).toBe(false);
  });

  it('rewinds an undo lesson when the journal is further behind than one action', () => {
    expect(undoStepIndex).toBeGreaterThan(0);
    expect(shouldReplayPracticeProgress(undoStepIndex, 12, 9, 8)).toBe(true);
  });

  it('rewinds when replay is several lessons behind despite a one-event count difference', () => {
    expect(undoStepIndex).toBeGreaterThan(1);
    expect(shouldReplayPracticeProgress(undoStepIndex, 12, 11, undoStepIndex - 2)).toBe(true);
  });
});
