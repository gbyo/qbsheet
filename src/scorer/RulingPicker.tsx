/**
 * The ruling, asked for beside the person it is about.
 *
 * # Why it is anchored and not a dialog in the middle of the screen
 *
 * A scorekeeper picking a ruling has just watched somebody buzz, and the thing they are certain of
 * is *who*. A centred modal takes that certainty away and asks them to find it again in a box that
 * covers the table they were looking at. So the choices open against the player, close the instant
 * one lands, and never dim anything: the answer to "who" stays on screen underneath, which is what
 * makes the second half of the decision a glance rather than a re-read.
 *
 * # It is a dialog, and that is load-bearing twice over
 *
 * Once for assistive technology, which needs to be told that a small surface with its own name has
 * taken over. And once for the keyboard: `keystrokeBelongsToControl` treats anything inside a
 * `role="dialog"` as owning its own keystrokes, so an open picker suppresses the global seat/action
 * sequence without this file knowing that layer exists. Sarah's picker being open is exactly why
 * pressing `3` cannot score Jeremy behind it.
 *
 * # Positioned by measurement, not by a library
 *
 * Two rectangles and four comparisons: prefer below, flip above when below does not fit, clamp to the
 * viewport either way. It is a portal on `document.body` because `.scorer-body` scrolls and would
 * otherwise clip it. Measurement happens when it opens and when the world moves under it — a scroll
 * or a resize — and at no other time; a ruling being recorded does not remeasure anything.
 */
import { CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TossupChoice } from './tossupChoices';

/** Clearance from the viewport edge, and from the tile the picker belongs to. */
const viewportMargin = 8;
const anchorGap = 6;

export interface IRulingPickerProps {
  /** Used for the accessible name and drawn as the title, so the choices are never nameless. */
  playerName: string;
  /** Named too, because two teams can field the same surname and the picker is the only context. */
  teamName: string;
  choices: readonly TossupChoice[];
  /** The tile this picker belongs to. Positioning and focus return both come from it. */
  anchor: HTMLElement | null;
  /** Wired to the tile's `aria-controls`. */
  id: string;
  /**
   * A ruling was chosen. The picker does not care whether the engine accepted it: one press is one
   * decision, and leaving a picker open over a rejected action is how a second press happens.
   */
  onChoose: (choice: TossupChoice) => void;
  /** Escape, an outside press, or anything else that ends the question without answering it. */
  onDismiss: (returnFocus: boolean) => void;
}

interface IPlacement {
  left: number;
  top: number;
  /** Which side of the tile the picker ended up on. The motion originates from the other one. */
  side: 'below' | 'above';
  /** Where the tile's centre is, relative to the picker, so the entrance points back at it. */
  originX: number;
}

export default function RulingPicker(props: IRulingPickerProps) {
  const { playerName, teamName, choices, anchor, id, onChoose, onDismiss } = props;
  const surface = useRef<HTMLDivElement | null>(null);
  const firstChoice = useRef<HTMLButtonElement | null>(null);
  const [placement, setPlacement] = useState<IPlacement | null>(null);

  const position = useCallback(() => {
    const element = surface.current;
    if (!element || !anchor) return;
    const tile = anchor.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    const below = tile.bottom + anchorGap;
    const above = tile.top - anchorGap - box.height;
    // Below unless below genuinely does not fit and above does. A picker that flips whenever it is
    // close to the edge changes places between two consecutive tossups for no reason a scorekeeper
    // can see.
    const fitsBelow = below + box.height <= viewportHeight - viewportMargin;
    const side: IPlacement['side'] = fitsBelow || above < viewportMargin ? 'below' : 'above';
    const unclampedTop = side === 'below' ? below : above;
    const top = Math.max(
      viewportMargin,
      Math.min(unclampedTop, Math.max(viewportMargin, viewportHeight - viewportMargin - box.height)),
    );
    const centred = tile.left + tile.width / 2 - box.width / 2;
    const left = Math.max(
      viewportMargin,
      Math.min(centred, Math.max(viewportMargin, viewportWidth - viewportMargin - box.width)),
    );
    setPlacement({ left, top, side, originX: tile.left + tile.width / 2 - left });
  }, [anchor]);

  // Before the first paint, so the picker is never seen at the origin on its way to the tile.
  useLayoutEffect(() => {
    position();
  }, [position, choices]);

  useEffect(() => {
    firstChoice.current?.focus();
  }, [anchor]);

  /*
   * The world moving under an open picker: a scrolled seat strip, a rotated tablet, an on-screen
   * keyboard resizing the viewport. Capture, because the strip that scrolls is not an ancestor of the
   * portal. Passive, because nothing here prevents the scroll.
   */
  useEffect(() => {
    const reposition = () => position();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, { capture: true });
    };
  }, [position]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat) return;
      event.preventDefault();
      // Escape belongs to the picker and stops here, so it cannot also close something behind it.
      event.stopPropagation();
      onDismiss(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // The tile is the toggle. Closing on its own press would fight the press that reopens it.
      if (surface.current?.contains(target) || anchor?.contains(target)) return;
      onDismiss(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [anchor, onDismiss]);

  if (typeof document === 'undefined') return null;

  const style: CSSProperties = {
    left: placement?.left ?? 0,
    top: placement?.top ?? 0,
    // Hidden only for the one frame before the layout effect has measured anything.
    visibility: placement ? 'visible' : 'hidden',
    ['--scorer-picker-origin-x' as string]: `${placement?.originX ?? 0}px`,
  };

  return createPortal(
    <div
      id={id}
      ref={surface}
      className="scorer-ruling-picker"
      data-placement={placement?.side ?? 'below'}
      role="dialog"
      aria-label={`Ruling for ${playerName}, ${teamName}`}
      style={style}
    >
      <p className="scorer-ruling-picker-title">{playerName}</p>
      <div className="scorer-ruling-picker-choices">
        {choices.map((choice, index) => (
          <button
            key={choice.kind === 'answer' ? `answer-${choice.answerType.index}` : 'wrong'}
            type="button"
            ref={index === 0 ? firstChoice : undefined}
            className={[
              'scorer-ruling-choice',
              choice.kind === 'answer' && choice.answerType.isNeg ? 'is-neg' : '',
              choice.kind === 'wrong' ? 'is-zero' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label={
              choice.kind === 'answer'
                ? `${playerName} ${choice.answerType.label}`
                : `${playerName} 0 wrong, no penalty`
            }
            onClick={() => onChoose(choice)}
          >
            <span className="scorer-ruling-choice-value">{choice.label}</span>
            {choice.name !== '' && <span className="scorer-ruling-choice-name">{choice.name}</span>}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
