/**
 * The keyboard drill screen.
 *
 * # It listens at the document, like the scoresheet does
 *
 * There is nothing to focus and nothing to type into: the keys being learned are global on the real
 * scoresheet, and a drill that made you click into a box first would be teaching a gesture that does not
 * exist. So the listener is on the document, and while the drill is up it takes every key the layout uses
 * — a digit that scrolled the page or a Ctrl+Z that reached the browser's own undo would be the drill
 * getting its own subject wrong. Everything else (Tab, F5, the arrow keys) is left alone, which is also
 * what stops the drill from calling an innocent keystroke a mistake.
 *
 * # A wrong key clears the sequence
 *
 * Because that is what the scoresheet does. A ruling is two keys, and pressing the wrong second key
 * there does not record a different ruling — it throws the seat away and waits. Repeating that here means
 * the recovery a scorekeeper practises is the recovery they will need.
 *
 * # It does not turn keyboard scoring on
 *
 * It offers to. The preference is the scorekeeper's, off by default and deliberately so (see
 * `keyboardPreference`), and a screen that flipped it as a side effect of being visited would be exactly
 * the surprise that default exists to prevent. So the drill says the keys will do nothing on a real sheet
 * until the toggle is on, and puts the toggle one press away.
 */
import { useCallback, useEffect, useState } from 'react';
import KeyboardMap from '../scorer/KeyboardMap';
import { keyboardShortcutLabels, keystrokeBelongsToControl, sequenceLegend } from '../scorer/KeyboardScoring';
import { setKeyboardEnabled } from '../scorer/keyboardPreference';
import useKeyboardEnabled from '../scorer/useKeyboardEnabled';
import { rulingLabel, unreachableAnswerTypes } from '../scorer/tossupRulings';
import { practiceFormat } from './PracticeScenario';
import { drillTasks, IDrillTask, readKeystrokeLabel } from './KeyboardDrillScenario';

/**
 * What to say when the wrong key arrives.
 *
 * It names the key that was pressed rather than only the key that was wanted, because a scorekeeper who
 * meant to press one thing and pressed another needs to know which of the two happened — and because on
 * the real sheet the same keystroke would have recorded something, and being told what is the lesson.
 */
export function wrongKeyMessage(task: IDrillTask, position: number, pressed: string): string {
  const wanted = task.keys[position];
  const cleared =
    position > 0
      ? ` The half-finished sequence has been cleared, exactly as the scoresheet clears it — start again from ${task.keys[0]}.`
      : '';
  return `You pressed ${pressed}. This step wants ${wanted}. ${task.correction}${cleared}`;
}

export interface IDrillProgress {
  /** Which task is on screen. */
  index: number;
  /** How many keys of it have landed. A ruling is two, so this is not always zero. */
  pressed: number;
  /** The verdict on the task just left behind. Skipping earns a note rather than a tick. */
  feedback: { text: string; pressed: boolean } | null;
  mistake: string;
  done: boolean;
}

export const drillStart: IDrillProgress = { index: 0, pressed: 0, feedback: null, mistake: '', done: false };

/** Leave the current task behind, with a verdict — or finish, if it was the last one. */
function advanced(current: IDrillProgress, verdict: { text: string; pressed: boolean }): IDrillProgress {
  const last = current.index + 1 >= drillTasks.length;
  return {
    index: last ? current.index : current.index + 1,
    pressed: 0,
    feedback: verdict,
    mistake: '',
    done: last,
  };
}

/** The drill state after the current task is given up on. */
export function drillSkipped(current: IDrillProgress): IDrillProgress {
  const task = drillTasks[current.index];
  return task === undefined ? current : advanced(current, { text: `Skipped. ${task.ask}`, pressed: false });
}

/**
 * What one keystroke does to the drill.
 *
 * A pure function of the state it is applied to rather than of whatever the listener last rendered with,
 * for the reason `useScorerKeyboard` keeps its pending seat in a ref: two keys can arrive between renders,
 * and the second one must be judged against what the first one left behind. Judging both against the same
 * stale step is how a drill tells somebody the wrong key was wrong.
 *
 * A wrong key throws away a half-finished sequence, because that is what the scoresheet does with one.
 */
export function drillKeystroke(current: IDrillProgress, label: string): IDrillProgress {
  const task = drillTasks[current.index];
  if (task === undefined || current.done) return current;
  if (label !== task.keys[current.pressed]) {
    return { ...current, pressed: 0, feedback: null, mistake: wrongKeyMessage(task, current.pressed, label) };
  }
  if (current.pressed + 1 < task.keys.length) {
    return { ...current, pressed: current.pressed + 1, mistake: '' };
  }
  return advanced(current, { text: task.success, pressed: true });
}

export default function KeyboardDrill(props: { onBack: () => void; onHome: () => void }) {
  const { onBack, onHome } = props;
  const keyboardEnabled = useKeyboardEnabled();
  const [progress, setProgress] = useState(drillStart);
  const { index, pressed, feedback, mistake, done } = progress;
  const task = drillTasks[index];

  const restart = useCallback(() => setProgress(drillStart), []);

  useEffect(() => {
    if (done) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      // A held key. The browser repeats it, and a resting finger must not walk through the drill.
      if (event.repeat) return;
      if (keystrokeBelongsToControl(event)) return;
      const label = readKeystrokeLabel(event);
      if (label === null) return;
      event.preventDefault();
      setProgress((current) => drillKeystroke(current, label));
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [done]);

  if (done) {
    return (
      <main className="shell practice-drill practice-complete">
        <p className="practice-label">Keyboard drill</p>
        <h1 className="shell-title">You have pressed every key the layout has.</h1>
        <p>
          The seats, the four rulings, no buzz, a bonus total, undo and redo. Nothing else is bound — which is
          the other half of knowing the layout, because a key you are sure does nothing is a key you will not
          hunt for during a round.
        </p>

        <section className="shell-section">
          <h2 className="shell-heading">The map, as the scoresheet shows it</h2>
          {/*
            The live legend, not a picture of one. It is the same component the scoresheet keeps on screen
            while keyboard scoring is on, drawing the same values from the same format — so what somebody
            leaves this screen having read is what they will be looking at in a round.
          */}
          <KeyboardMap
            context={{
              kind: 'tossup',
              actions: sequenceLegend(practiceFormat, true),
              unreachable: unreachableAnswerTypes(practiceFormat).map(rulingLabel),
            }}
          />
          <p className="shell-hint">
            Redo is {keyboardShortcutLabels.redo}. Substitutions and corrections to an earlier question stay
            on the buttons by design: a chord for each of them would be a layout nobody could hold in their
            head, and these are the things nobody does mid-buzz. A bonus scored part by part — which is what a
            format with bouncebacks opens on — puts its own three digits in this map while it is on screen,
            naming the teams they belong to.
          </p>
        </section>

        {!keyboardEnabled && (
          <section className="shell-section practice-drill-preference">
            <div>
              <h2 className="shell-heading">Keyboard scoring is off on this device</h2>
              <p className="shell-hint">
                The seat and ruling keys do nothing on a real scoresheet until it is on. Space and undo work
                either way. It can also be switched from the Game menu during a game.
              </p>
            </div>
            <button type="button" className="shell-button" onClick={() => setKeyboardEnabled(true)}>
              Turn keyboard scoring on
            </button>
          </section>
        )}

        <div className="practice-complete-actions">
          <button type="button" className="shell-button is-primary" onClick={restart}>
            Run the drill again
          </button>
          <button type="button" className="shell-button" onClick={onBack}>
            Back to the practice summary
          </button>
          <button type="button" className="shell-button" onClick={onHome}>
            Back to QBSheet
          </button>
        </div>
      </main>
    );
  }

  if (task === undefined) return null;

  return (
    <main className="shell practice-drill" aria-label="Keyboard drill">
      <header className="shell-header">
        <p className="practice-label">Keyboard drill</p>
        <h1 className="shell-title">Learn keyboard scoring</h1>
        <p className="shell-subtitle">
          {drillTasks.length} keystrokes, on their own. Read the call, press the keys — no game is being
          scored and nothing here is recorded anywhere.
        </p>
      </header>

      {!keyboardEnabled && (
        <div className="shell-notice practice-drill-preference">
          <p>
            Keyboard scoring is switched off on this device, so the seat and ruling keys will do nothing on a
            real scoresheet until it is on. The drill itself works either way.
          </p>
          <button type="button" className="shell-button" onClick={() => setKeyboardEnabled(true)}>
            Turn keyboard scoring on
          </button>
        </div>
      )}

      <p className="practice-progress">
        Step {index + 1} of {drillTasks.length} · {task.section}
      </p>
      <div
        className="practice-progress-track"
        role="progressbar"
        aria-label="Drill progress"
        aria-valuemin={1}
        aria-valuemax={drillTasks.length}
        aria-valuenow={index + 1}
      >
        <span style={{ width: `${Math.round(((index + 1) / drillTasks.length) * 100)}%` }} />
      </div>

      <section className="practice-drill-task">
        {feedback !== null && (
          <p
            className={feedback.pressed ? 'practice-feedback is-success' : 'practice-feedback'}
            role="status"
          >
            {feedback.pressed && <span aria-hidden="true">✓</span>} {feedback.text}
          </p>
        )}
        {mistake && (
          <div className="practice-feedback is-error" role="alert">
            <strong>Not that key.</strong>
            <p>{mistake}</p>
          </div>
        )}

        <h2>{task.call}</h2>
        <div className="practice-call is-instruction">
          <span>Press</span>
          <p>{task.ask}</p>
          <p className="practice-keystroke">
            {task.keys.map((key, position) => (
              <span key={key}>
                {/* The separator is decorative; a reader should hear a list of keys, not the word "then". */}
                {position > 0 && <span aria-hidden="true"> then </span>}
                <kbd className={position < pressed ? 'is-done' : undefined}>{key}</kbd>
              </span>
            ))}
            {pressed > 0 && <span className="practice-drill-waiting"> — waiting for the ruling</span>}
          </p>
        </div>
        <details key={task.id} className="practice-hint">
          <summary>Why this key</summary>
          <p>{task.why}</p>
        </details>
      </section>

      <div className="shell-actions practice-drill-actions">
        {/*
          Skip exists because a drill you can be stuck in is worse than one you can walk out of: a
          keyboard that cannot produce one of these chords should cost somebody a step, not the drill.
        */}
        <button type="button" className="shell-button" onClick={() => setProgress(drillSkipped)}>
          Skip this step
        </button>
        <button type="button" className="shell-button" onClick={restart}>
          Start over
        </button>
        <button type="button" className="shell-button" onClick={onBack}>
          Back to the practice summary
        </button>
      </div>
    </main>
  );
}
