import { CSSProperties, useEffect, useState } from 'react';
import { IPracticeStep, practiceKeystroke } from './PracticeScenario';
import useKeyboardEnabled from '../scorer/useKeyboardEnabled';

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
    title: 'What is the question editor showing me?',
    answer:
      'The whole of one question: every buzz on it, in order, and the bonus it earned — not just the action you selected. Team, Player and Ruling are the three things a scoresheet line records, and Ruling carries the points, so “+10” is one choice rather than two. The score table at the top previews what saving would do. Nothing changes until you choose Save correction, and Close at the top right (or Escape) leaves the question exactly as it was.',
  },
  {
    title: 'A player is missing or substitutes',
    answer:
      'For a straight one-for-one swap, press ⇄ on the outgoing player’s row on the scoresheet and choose who comes on. Players in the bottom toolbar handles everything else: adding somebody to the roster, changing several players at once, or reordering the seats. Either way the change starts at the next tossup, so tossups heard stay honest.',
  },
  {
    title: 'Wrong answer, neg, or no buzz?',
    answer:
      'Use a negative ruling only when the rules assess a penalty. Use Wrong (0) for an answer with no penalty; it stays a pointer/touch button in keyboard mode because Ctrl-letter shortcuts belong to Chrome and ChromeOS. Use No buzz only when the remaining eligible team never answers.',
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
  // The real preference, not a practice-only copy: the guide teaches whatever the scoresheet is doing.
  const keyboardEnabled = useKeyboardEnabled();
  const keystroke = practiceKeystroke(step.id);
  /*
   * Open where the panel gets its full two-column width — the same 1050px the stylesheet gives up the
   * second column below. Narrower than that it reads down the page like the old panel did, tall enough
   * to reach the rulings a step is describing, so it waits behind Open guide instead.
   */
  const [open, setOpen] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1051px)').matches : true,
  );
  const [view, setView] = useState<'guide' | 'help'>('guide');
  const [confirming, setConfirming] = useState<'restart' | 'leave' | null>(null);
  const [controlBarBlockSize, setControlBarBlockSize] = useState<number | null>(null);
  const progress = Math.round(((stepIndex + 1) / stepCount) * 100);
  const placementStyle =
    controlBarBlockSize === null
      ? undefined
      : ({ '--practice-control-bar-block-size': `${controlBarBlockSize}px` } as CSSProperties);

  useEffect(() => {
    setConfirming(null);
  }, [step.id]);

  useEffect(() => {
    const controlBar = document.querySelector<HTMLElement>('.practice-mode > .scorer > .scorer-footer');
    if (!controlBar) return undefined;

    const measure = () => setControlBarBlockSize(controlBar.getBoundingClientRect().height);
    measure();

    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(controlBar);
    return () => observer.disconnect();
  }, []);

  if (!open) {
    return (
      <button
        type="button"
        className="practice-coach-collapsed"
        style={placementStyle}
        aria-expanded="false"
        aria-controls="practice-coach-panel"
        onClick={() => setOpen(true)}
      >
        <span>
          <strong>
            Practice {stepIndex + 1}/{stepCount}
          </strong>
          {/* Collapsed, one line is all there is room for, and the instruction is the useful half. */}
          <span>{step.instruction}</span>
        </span>
        <span className="practice-coach-expand" aria-hidden="true">
          Open guide
        </span>
      </button>
    );
  }

  return (
    <aside id="practice-coach-panel" className="practice-coach" style={placementStyle} aria-label="Practice guide">
      {/* Wide enough to carry the name, the section tabs and the way out on one line. */}
      <header className="practice-coach-header">
        <div className="practice-coach-heading">
          <p className="practice-label">Guided practice</p>
          <p className="practice-progress">
            Step {stepIndex + 1} of {stepCount} · {step.section}
          </p>
        </div>
        <div className="practice-coach-tabs" aria-label="Practice guide sections">
          <button type="button" aria-pressed={view === 'guide'} onClick={() => setView('guide')}>
            Current step
          </button>
          <button type="button" aria-pressed={view === 'help'} onClick={() => setView('help')}>
            Common situations
          </button>
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

      <div className="practice-coach-content">
        {view === 'guide' ? (
          <div className="practice-coach-step">
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
            {/* Left of the pair: what the room did. */}
            <div className="practice-call">
              <span>Situation</span>
              <p>{step.call}</p>
            </div>
            {/*
              Right of the pair: what to do, said outright.

              This used to be hidden behind Get a hint, on the theory that working out which control a
              reader's call maps to is the exercise. In use it was not: a step whose situation is
              "Tucker answers correctly after the neg" leaves a first-time scorekeeper unsure whether
              they are meant to score the same tossup or advance it, and guessing wrong in a tutorial
              teaches nothing except that the tutorial is unclear. The instruction says what to
              record; the hint still says where the control is and why the ruling is what it is.
            */}
            <div className="practice-call is-instruction">
              <span>Do this</span>
              <p>{step.instruction}</p>
              {/*
                The same keystroke the real scoresheet uses, shown only when the scorekeeper has turned
                keyboard scoring on. Beside the instruction rather than buried in the hint, because a
                scorekeeper practising with the keyboard wants the key on the tossup they are on and not
                after opening a disclosure — and because the button and the key are the same ruling, so
                they belong in the same sentence.
              */}
              {keyboardEnabled && keystroke !== null && (
                <p className="practice-keystroke">
                  Keyboard: <kbd>{keystroke}</kbd>
                </p>
              )}
            </div>
            <details key={step.id} className="practice-hint">
              <summary>Show me where</summary>
              <p>{step.hint}</p>
            </details>
          </div>
        ) : (
          <div className="practice-help">
            <h2>Quick answers for the room</h2>
            <p className="practice-help-intro">
              These apply to the real scoresheet too. Tournament-specific procedure always wins.
            </p>
            <div className="practice-help-topics">
              {helpTopics.map((topic) => (
                <details key={topic.title}>
                  <summary>{topic.title}</summary>
                  <p>{topic.answer}</p>
                </details>
              ))}
            </div>
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
