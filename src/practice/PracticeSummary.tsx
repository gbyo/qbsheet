/**
 * What a finished practice game leaves on the screen.
 *
 * Its own component because it is the one place the guided game hands somebody on to something else, and
 * because everything on it is a choice about *what to do next* rather than about the game just scored —
 * which is also why the drill offer belongs here rather than on the front door. Somebody who has just
 * scored eight tossups by hand is the one person for whom "these all have keys" is useful information;
 * somebody who has not yet opened a scoresheet is not.
 *
 * The offer is quiet on purpose. Blue on this screen already means Practice again (see `app-shell.css`),
 * and an optional second lesson is not the thing to press.
 */
export default function PracticeSummary(props: {
  onRestart: () => void;
  onHome: () => void;
  onDrill: () => void;
}) {
  const { onRestart, onHome, onDrill } = props;

  return (
    <main className="shell practice-complete">
      <p className="practice-label">Practice</p>
      <h1 className="shell-title">You scored a complete practice game.</h1>
      <p>
        You handled powers, normal and zero-point wrong answers, a neg and rebound, bonuses, no buzz, an
        earlier question correction, Undo, a substitution and final review using the same scorer used in a
        real room.
      </p>
      <div className="practice-complete-actions">
        <button type="button" className="shell-button is-primary" onClick={onRestart}>
          Practice again
        </button>
        <button type="button" className="shell-button" onClick={onHome}>
          Back to QBSheet
        </button>
      </div>

      <section className="shell-section practice-next">
        <h2 className="shell-heading">Optional next step</h2>
        <p>
          Every ruling you just recorded with a button also has a key behind it, and a scorekeeper who knows
          them scores a tossup in two keystrokes without looking away from the room. The drill is the layout
          on its own — the seats, the four rulings, no buzz, a bonus total, undo and redo — in about a minute.
          No game is scored and nothing is saved.
        </p>
        <button type="button" className="shell-button" onClick={onDrill}>
          Learn keyboard scoring
        </button>
      </section>
    </main>
  );
}
