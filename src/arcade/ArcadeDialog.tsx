/**
 * The arcade: a picker, and whichever game it picked, in one dialog.
 *
 * # One dialog, two doors
 *
 * The Game menu opens this and so does Settings, and they open the same component with the same
 * state — there is no scorer arcade and no settings arcade. That is the whole reason this file
 * exists rather than the games being rendered wherever somebody wanted them: a second copy would be
 * a second set of lifecycle bugs, and the lifecycle is the only part of an arcade that can hurt a
 * scoresheet.
 *
 * # Why the modal is not implemented here
 *
 * `ScorerDialog` over `NativeDialog` is what every other infrequent action opens in, and a native
 * `<dialog>` supplies the page inertness, the focus trap and the Escape behaviour that a positioned
 * div would have to reimplement. Reimplementing it for a game would mean the one dialog in QBSheet
 * that could leak a keystroke to the scoresheet underneath is the one nobody is scoring with. So
 * this is an ordinary dialog, and the games inside it are ordinary content.
 *
 * # Why only the chosen game is mounted
 *
 * `game === 'qbbird' ? <QBBird /> : <Snake />` and nothing hidden behind CSS. An unmounted game has
 * no frame callback, no listener and no timer, because React ran its cleanups; a hidden one would
 * have all three and no way to tell. Returning to the picker unmounts, and so does closing.
 */
import { useEffect, useRef, useState } from 'react';
import ScorerDialog from '../scorer/ScorerDialog';
import QBBird from './QBBird';
import Snake from './Snake';
import './arcade.css';

export type ArcadeGameChoice = 'qbbird' | 'snake';

interface IArcadeEntry {
  id: ArcadeGameChoice;
  name: string;
  summary: string;
}

/** What the picker offers, in the order it offers it. Adding a third game is adding an entry here. */
const entries: IArcadeEntry[] = [
  { id: 'qbbird', name: 'QBBird', summary: 'Fly through the gaps in the score columns.' },
  { id: 'snake', name: 'Snake', summary: 'Collect tossup cards without hitting a wall or your tail.' },
];

export default function ArcadeDialog(props: { onClose: () => void; initialGame?: ArcadeGameChoice }) {
  const { onClose } = props;
  const [game, setGame] = useState<ArcadeGameChoice | null>(props.initialGame ?? null);
  const picker = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  /** The card to come back to. Held past the return to the picker, which is the point of it. */
  const [chosenLast, setChosenLast] = useState<ArcadeGameChoice | null>(null);

  /**
   * Put focus where the thing that just happened put attention.
   *
   * Choosing a game moves it to the way back out, which is the first control in the new view;
   * returning moves it to the card that was chosen, rather than to the top of a list somebody has to
   * find their place in again. The first render is deliberately not handled here — `NativeDialog`
   * focuses `[data-dialog-autofocus]` when it opens, which is the first card.
   */
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (game !== null) back.current?.focus();
    else picker.current?.querySelector<HTMLElement>('[data-arcade-return]')?.focus();
  }, [game]);

  const chosen = entries.find((entry) => entry.id === game);

  return (
    <ScorerDialog title={chosen === undefined ? 'Arcade' : chosen.name} onClose={onClose}>
      {chosen === undefined ? (
        <div className="arcade-picker" ref={picker}>
          <p className="scorer-dialog-note">
            Something to do between rounds. Nothing here touches the game you are scoring.
          </p>
          {entries.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              className="arcade-card"
              data-dialog-autofocus={index === 0 ? true : undefined}
              data-arcade-return={entry.id === chosenLast ? true : undefined}
              onClick={() => {
                setChosenLast(entry.id);
                setGame(entry.id);
              }}
            >
              <span className="arcade-card-name">{entry.name}</span>
              <span className="arcade-card-summary">{entry.summary}</span>
              <span className="arcade-card-play" aria-hidden="true">
                Play →
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="arcade-play">
          <button
            data-dialog-autofocus
            ref={back}
            type="button"
            className="arcade-back"
            onClick={() => setGame(null)}
          >
            <span aria-hidden="true">←</span> Back to Arcade
          </button>
          {chosen.id === 'qbbird' ? <QBBird /> : <Snake />}
        </div>
      )}
    </ScorerDialog>
  );
}
