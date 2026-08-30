/**
 * The legend, which is what makes a keyboard layer usable instead of folklore.
 *
 * # Why it is always on screen
 *
 * Because the alternative is a help dialog, and a help dialog is a thing nobody opens during a round.
 * A scorekeeper learning this needs the map in peripheral vision on the third tossup and needs it to
 * have stopped mattering by the thirtieth — which is what a small permanent strip does and what a
 * modal cannot.
 *
 * # And why it changes
 *
 * Showing seat keys while a bonus is being asked for would be showing bindings that do nothing. The
 * contextual version is not a nicety: a map that lies about the current state is worse than no map,
 * because it is the thing somebody checks when they are unsure.
 *
 * Every value in it comes from the live format. There is no `+15` in this file.
 */
import { LeftOrRight } from '../scoring/types';
import { IKeyLegendEntry, keyboardSeatNumbers, keyboardShortcutLabels } from './KeyboardScoring';

export type KeyboardMapContext =
  /** A live tossup: the numeric seats and action sequences mean something. */
  | { kind: 'tossup'; actions: IKeyLegendEntry[]; unreachable: string[] }
  /** A bonus, a bounceback, or parts: digits address whatever is on screen. */
  | { kind: 'choices'; title: string; choices: IKeyLegendEntry[]; cancellable: boolean }
  /** A dialog is open, or the game is over. Nothing is bound, and saying so is the point. */
  | { kind: 'inactive'; reason: string };

function Row(props: { entry: IKeyLegendEntry }) {
  const { entry } = props;
  return (
    <li className={entry.available ? 'scorer-keymap-row' : 'scorer-keymap-row is-unavailable'}>
      <kbd className="scorer-keymap-key">{entry.keys}</kbd>
      <span className="scorer-keymap-meaning">{entry.meaning}</span>
    </li>
  );
}

export default function KeyboardMap(props: { context: KeyboardMapContext }) {
  const { context } = props;

  if (context.kind === 'inactive') {
    return (
      <aside className="scorer-keymap is-inactive" aria-label="Keyboard scoring">
        <p className="scorer-keymap-title">Keyboard</p>
        <p className="scorer-keymap-note">{context.reason}</p>
      </aside>
    );
  }

  if (context.kind === 'choices') {
    return (
      <aside className="scorer-keymap" aria-label="Keyboard scoring">
        <p className="scorer-keymap-title">{context.title}</p>
        <ul className="scorer-keymap-list is-choices">
          {context.choices.map((entry) => (
            <Row key={entry.keys} entry={entry} />
          ))}
        </ul>
        {context.cancellable && <p className="scorer-keymap-note">Esc goes back without recording.</p>}
      </aside>
    );
  }

  return (
    <aside className="scorer-keymap" aria-label="Keyboard scoring">
      <p className="scorer-keymap-title">Keyboard</p>
      {/* The seats first, because the shape under the hand is the thing being learned. Rendered as the
          two rows they physically are rather than as a list of eight. */}
      <div className="scorer-keymap-seats">
        {(['left', 'right'] as LeftOrRight[]).map((side) => (
          <p key={side} className="scorer-keymap-seat-row">
            <span className="scorer-keymap-seat-side">{side === 'left' ? 'Left' : 'Right'}</span>
            {keyboardSeatNumbers[side].map((number) => (
              <span key={number} className="scorer-keymap-seat">
                <kbd className="scorer-keymap-key">{number}</kbd>
              </span>
            ))}
          </p>
        ))}
      </div>
      <ul className="scorer-keymap-list">
        {context.actions.map((entry) => (
          <Row key={entry.keys} entry={entry} />
        ))}
        <Row entry={{ keys: keyboardShortcutLabels.noBuzz, meaning: 'no buzz', available: true }} />
        <Row entry={{ keys: keyboardShortcutLabels.undo, meaning: 'undo', available: true }} />
      </ul>
      {context.unreachable.length > 0 && (
        // Said plainly rather than papered over with a new chord. A scorekeeper who knows the middle
        // tier is mouse-only will reach for the mouse; one who does not will hunt for a shortcut that
        // was never designed.
        <p className="scorer-keymap-note">{context.unreachable.join(', ')}: use the buttons.</p>
      )}
    </aside>
  );
}
