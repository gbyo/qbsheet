/**
 * The arcade's only animation loop, and the promise that it stops.
 *
 * # Why the games do not each write this
 *
 * Because the property that matters here is not "the game animates", it is "nothing animates when
 * nobody is playing". A scoresheet is open on a Chromebook for eight hours; a frame callback left
 * running by a dialog somebody closed between rounds is a flat battery by the last round, and it is
 * exactly the kind of leak that never shows up in the session where it was written. One
 * implementation, one cleanup, and both games inherit it.
 *
 * # What "stopped" means
 *
 * When `running` is false there is no scheduled frame and no listener. Not a frame that returns
 * early — none scheduled at all, which is why the effect body exits before `requestAnimationFrame`
 * rather than guarding inside the callback. Unmounting does the same thing through the cleanup, so a
 * closed dialog leaves nothing behind that could schedule another frame.
 *
 * # Why the document's visibility is part of it
 *
 * A hidden tab is throttled but not stopped, and a game left mid-flight in a background tab is both
 * a waste of a battery and unfair to whoever comes back to it. Hiding cancels the frame and tells
 * the caller, so the game can put itself into a state a person can return to rather than resuming
 * into an obstacle that arrived while the screen was off.
 *
 * # Why the step is given seconds, and clamped
 *
 * Seconds, because the physics constants in both games are then readable as "pixels per second"
 * rather than "pixels per frame at whatever this display happens to refresh at", and a 120Hz phone
 * plays the same game as a 60Hz Chromebook. Clamped, because the first frame after a stall would
 * otherwise carry the whole stall in one step and teleport the bird through an obstacle.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

/** The largest step a single frame may advance. Two 60Hz frames; anything longer is a stall. */
export const maxArcadeStepSeconds = 1 / 30;

export interface IArcadeLoopInput {
  /** Whether the loop should be scheduling frames at all. False means nothing is scheduled. */
  running: boolean;
  /** Advance the game by this many seconds. Called once per animation frame, never otherwise. */
  step: (seconds: number) => void;
  /** The document was hidden while the loop was running. The loop has already stopped. */
  onHidden?: () => void;
}

export default function useArcadeLoop(input: IArcadeLoopInput): void {
  /*
   * The live callbacks, in a ref. `step` closes over the frame it was created in and therefore has a
   * new identity on every render; depending on it would tear the loop down and build it again
   * several times a second, which is both wasteful and a way to lose the timestamp the delta is
   * measured from. The effect below depends on `running` and nothing else.
   */
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });

  useEffect(() => {
    if (!input.running) return undefined;

    let frame: number | null = null;
    let previous: number | null = null;

    const tick = (now: number) => {
      // The first frame after a start or a resume measures nothing. It only sets the origin.
      const seconds = previous === null ? 0 : Math.min((now - previous) / 1000, maxArcadeStepSeconds);
      previous = now;
      frame = window.requestAnimationFrame(tick);
      if (seconds > 0) latest.current.step(seconds);
    };

    const stop = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      previous = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Stop first, then tell the caller. A caller that reacts by rendering must not be able to
        // observe a state in which the loop is both paused and still holding a scheduled frame.
        stop();
        latest.current.onHidden?.();
        return;
      }
      /*
       * Back on screen, and still running.
       *
       * A caller that answered `onHidden` by pausing has already unmounted this effect, listener and
       * all, so reaching here means nobody stopped the game — and a loop that stayed dead after a
       * screen came back on would be a game that had quietly ended without saying so. `previous` was
       * cleared by `stop`, so the first frame after this measures nothing and the time the tab spent
       * hidden is not played through.
       */
      if (frame === null) frame = window.requestAnimationFrame(tick);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    frame = window.requestAnimationFrame(tick);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [input.running]);
}
