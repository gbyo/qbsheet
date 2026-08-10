import { useEffect, useState } from 'react';
import { IPracticeStep } from './PracticeScenario';

interface IPracticeCoachProps {
  step: IPracticeStep;
  stepIndex: number;
  stepCount: number;
  feedback: string;
  mistake: string;
  onRestart: () => void;
  onLeave: () => void;
}

const helpTopics = [
  {
    title: 'I recorded the last action wrong',
    answer: 'Use Undo, then record the call again. Redo is available until you make a different scoring action.',
  },
  {
    title: 'I found an older mistake',
    answer:
      'Select that question in Recent, or open Game → Full scoresheet review. Edit the whole question and save; QBSheet recalculates the totals and player stats.',
  },
  {
    title: 'A player is missing or substitutes',
    answer:
      'Open Players. Add a missing player to the roster, or move an active player to the bench and bring the substitute in. The change starts at the next tossup.',
  },
  {
    title: 'Wrong answer, neg, or no buzz?',
    answer:
      'Use a negative ruling only when the rules assess a penalty. Use Wrong (0) for an answer with no penalty. Use No buzz only when the remaining eligible team never answers.',
  },
  {
    title: 'The question or ruling is disputed',
    answer:
      'Use Flag for a protest, packet problem, rules question, or scoring issue. Keep scoring unless your event procedure says the protest blocks play.',
  },
  {
    title: 'The scorekeeper loses connection',
    answer:
      'Keep scoring. QBSheet saves the event history on this device. Select the connection status for exact save and delivery details, and download a QBJ backup before leaving the page if anything looks uncertain.',
  },
  {
    title: 'The final submit button is blocked',
    answer:
      'Read the blocker in the finish review. Typical causes are an incomplete bonus, an unresolved required protest, a lineup inconsistency, or scores that still need confirmation.',
  },
  {
    title: 'The game ends early or by forfeit',
    answer:
      'Use the Game menu. End game early records the last tossup and reason; Record forfeit records which team forfeited. These are deliberate, destructive actions.',
  },
  {
    title: 'I need a portable backup',
    answer:
      'Open Game → Download QBJ backup. The file can be carried to tournament control or used to recover the scoresheet on another device.',
  },
];

export default function PracticeCoach(props: IPracticeCoachProps) {
  const { step, stepIndex, stepCount, feedback, mistake, onRestart, onLeave } = props;
  const [open, setOpen] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1051px)').matches : true,
  );
  const [view, setView] = useState<'guide' | 'help'>('guide');
  const [confirming, setConfirming] = useState<'restart' | 'leave' | null>(null);
  const progress = Math.round(((stepIndex + 1) / stepCount) * 100);

  useEffect(() => {
    setConfirming(null);
  }, [step.id]);

  if (!open) {
    return (
      <button
        type="button"
        className="practice-coach-collapsed"
        aria-expanded="false"
        aria-controls="practice-coach-panel"
        onClick={() => setOpen(true)}
      >
        <span>
          <strong>Practice {stepIndex + 1}/{stepCount}</strong>
          <span>{step.call}</span>
        </span>
        <span className="practice-coach-expand" aria-hidden="true">
          Open guide
        </span>
      </button>
    );
  }

  return (
    <aside id="practice-coach-panel" className="practice-coach" aria-label="Practice guide">
      <header className="practice-coach-header">
        <div>
          <p className="practice-label">Guided practice</p>
          <p className="practice-progress">
            {step.section} · {stepIndex + 1} of {stepCount}
          </p>
        </div>
        <button
          type="button"
          className="practice-icon-button"
          aria-label="Minimize practice guide"
          aria-expanded="true"
          aria-controls="practice-coach-panel"
          onClick={() => setOpen(false)}
        >
          Minimize
        </button>
      </header>

      <div
        className="practice-progress-track"
        role="progressbar"
        aria-label="Practice progress"
        aria-valuemin={1}
        aria-valuemax={stepCount}
        aria-valuenow={stepIndex + 1}
      >
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="practice-coach-tabs" aria-label="Practice guide sections">
        <button type="button" aria-pressed={view === 'guide'} onClick={() => setView('guide')}>
          Current step
        </button>
        <button type="button" aria-pressed={view === 'help'} onClick={() => setView('help')}>
          Common situations
        </button>
      </div>

      <div className="practice-coach-content">
        {view === 'guide' ? (
          <>
            {feedback && (
              <p className="practice-feedback is-success" role="status">
                <span aria-hidden="true">✓</span> {feedback}
              </p>
            )}
            {mistake && (
              <div className="practice-feedback is-error" role="alert">
                <strong>That did not match the call.</strong>
                <p>{mistake}</p>
              </div>
            )}

            <h2>{step.title}</h2>
            <div className="practice-call">
              <span>Situation</span>
              <p>{step.call}</p>
            </div>
            <details key={step.id} className="practice-hint">
              <summary>Get a hint</summary>
              <p>{step.hint}</p>
            </details>
          </>
        ) : (
          <div className="practice-help">
            <h2>Quick answers for the room</h2>
            <p className="practice-help-intro">
              These apply to the real scoresheet too. Tournament-specific procedure always wins.
            </p>
            {helpTopics.map((topic) => (
              <details key={topic.title}>
                <summary>{topic.title}</summary>
                <p>{topic.answer}</p>
              </details>
            ))}
          </div>
        )}
      </div>

      <footer className="practice-actions">
        {confirming === null ? (
          <>
            <button type="button" className="practice-text-button" onClick={() => setConfirming('restart')}>
              Restart
            </button>
            <button type="button" className="practice-text-button" onClick={() => setConfirming('leave')}>
              Leave practice
            </button>
          </>
        ) : (
          <div className="practice-confirm" role="alert">
            <p>
              {confirming === 'restart'
                ? 'Restart from the lineup? This practice run will be cleared.'
                : 'Leave practice? This practice run will be cleared.'}
            </p>
            <div>
              <button
                type="button"
                className="shell-button is-primary"
                onClick={confirming === 'restart' ? onRestart : onLeave}
              >
                {confirming === 'restart' ? 'Restart now' : 'Leave now'}
              </button>
              <button type="button" className="shell-button" onClick={() => setConfirming(null)}>
                Keep practicing
              </button>
            </div>
          </div>
        )}
      </footer>
    </aside>
  );
}
