/**
 * What the keyboard is currently doing, said out loud at the bottom of the screen.
 *
 * # Why a popup and not more legend
 *
 * `KeyboardMap` answers "what can I press?". It is a reference, it never changes mid-tossup, and by
 * the thirtieth question a scorekeeper has stopped reading it. This answers a different and more
 * urgent question — "what did I just press?" — and it only exists for the moment there is an answer.
 *
 * The two-key sequence is what makes it necessary. Pressing `3` puts the scoresheet into a state that
 * is otherwise invisible: nothing on screen moves, but the next letter typed will score against a
 * particular person. Showing the seat *and the name it resolved to* is the confirmation, and it comes
 * before the ruling rather than after it, while there is still time to press something else.
 *
 * # Why it is dark
 *
 * Everything else on the scoresheet is a white panel with a hairline border. A single inverted pill is
 * legible in peripheral vision without being a colour anybody has to interpret, and it cannot be
 * mistaken for part of the sheet — which matters, because it is the one thing here that is about the
 * scorekeeper's own input rather than about the game.
 */
import { IPendingSeat } from './useScorerKeyboard';

export type KeyboardStatus =
  /** A seat is chosen and the sequence is waiting. `actions` is what would land next, this format. */
  | { kind: 'armed'; seat: IPendingSeat; actions: readonly string[] }
  /** A ruling landed. `ruling` is already rendered — this file names no points of its own. */
  | { kind: 'ruled'; seat: IPendingSeat; ruling: string };

export default function KeyboardStatus(props: { status: KeyboardStatus | null }) {
  const { status } = props;

  return (
    /*
     * The region is always mounted, empty or not. A live region that appears at the same moment as its
     * first message is a region assistive technology has not started watching yet, and the first
     * ruling of the game is the one most worth hearing.
     *
     * Polite, never assertive: this confirms something the scorekeeper just did on purpose. It has no
     * business cutting off whatever is being read.
     */
    <div className="scorer-keystatus" role="status" aria-live="polite" aria-label="Keyboard shortcut status">
      {status !== null && (
        <p className={status.kind === 'ruled' ? 'scorer-keystatus-pill is-ruled' : 'scorer-keystatus-pill'}>
          <span className="scorer-keystatus-seat">{status.seat.number}</span>
          <span className="scorer-keystatus-player">{status.seat.playerName}</span>
          {status.kind === 'armed' ? (
            <span className="scorer-keystatus-prompt">
              {/* The separator is decorative; a screen reader should read a list of keys, not bullets. */}
              {status.actions.map((key, index) => (
                <span key={key}>
                  {index > 0 && <span aria-hidden="true"> · </span>}
                  <kbd className="scorer-keystatus-key">{key}</kbd>
                </span>
              ))}
            </span>
          ) : (
            <>
              <span className="scorer-keystatus-ruling">{status.ruling}</span>
              {/* The tick is the confirmation the ruling is already carrying. Decorative to a reader. */}
              <span className="scorer-keystatus-check" aria-hidden="true">
                ✓
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
