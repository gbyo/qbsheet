/**
 * Two lists of people, and one action on each row.
 *
 * # Why this is not a column of checkboxes
 *
 * A checkbox says "this is a property of this person". Playing is not a property of a person, it is
 * a place they are standing, and the two lists say so directly: a name is under Playing or it is
 * under Bench, and the way it gets from one to the other is the action on its row. A scorekeeper
 * told "eleven for four" reads the sentence off the screen instead of ticking a box, counting the
 * ticks, and checking the total against the format's cap.
 *
 * It also removes the state the checkbox grid could reach and the game could not. A tick is
 * independent of every other tick, so the grid could sit there showing five names ticked for a
 * four-seat format with an Apply button that would be refused; the count line existed to warn about
 * a shape the editor should never have been able to make. Here the cap is enforced where it is
 * decided: Put in is simply not available once the seats are full.
 *
 * # Why there is nothing here that reorders
 *
 * Because the row order on this screen is not the thing being edited. What order this Chromebook
 * shows people in is a device preference with its own workflow (see `PlayerSeating`), and what order
 * a lineup event stores is scoring history (see `LineupEditing`). Putting arrows in here would offer
 * one control for two unrelated things, and whichever one it wrote would be the wrong one half the
 * time.
 *
 * # Why the row travels
 *
 * The same reason it travels on the starting-lineup screen, and by the same mechanism — this uses
 * `useLineupMotion` from that work rather than a second animation of its own. A press moves a name
 * between two groups that may be a screen apart, and a name that simply vanishes from one list and
 * appears in another leaves the scorekeeper to find it again to confirm the press did what they
 * meant.
 */
import { useLineupMotion } from './LineupMotion';

export interface IPlayingBenchEditorProps {
  /** Distinguishes two editors on one screen, so their rows do not share element ids. */
  idPrefix: string;
  /** Every name that may appear, in the order they should be presented. */
  order: readonly string[];
  /** Who is playing. Membership only; the order shown comes from `order`. */
  playing: ReadonlySet<string>;
  /** The format's cap. Put in is withheld once the playing group has reached it. */
  maximumActive: number;
  /** A quiet trailing fact about a person, such as tossups heard. */
  detailFor?: (name: string) => string | undefined;
  /** A quiet warning about a person, such as their not being rostered at this boundary yet. */
  noteFor?: (name: string) => string | undefined;
  /** What the group headings are labelled. Both editors say Playing and Bench; kept as one place. */
  playingLabel?: string;
  benchLabel?: string;
  onBench: (name: string) => void;
  onPutIn: (name: string) => void;
}

export default function PlayingBenchEditor(props: IPlayingBenchEditorProps) {
  const {
    idPrefix,
    order,
    playing,
    maximumActive,
    detailFor,
    noteFor,
    playingLabel = 'Playing',
    benchLabel = 'Bench',
    onBench,
    onPutIn,
  } = props;
  const motion = useLineupMotion();
  const playingNames = order.filter((name) => playing.has(name));
  const benchNames = order.filter((name) => !playing.has(name));
  // Counted from the membership rather than from the rows, so a lineup that already exceeds the cap
  // cannot be made worse by anybody the caller had a reason not to draw.
  const atCapacity = playing.size >= maximumActive;

  const row = (name: string, isPlaying: boolean) => {
    const detail = detailFor?.(name);
    const note = noteFor?.(name);
    return (
      <li
        key={name}
        ref={motion.rowRef(name)}
        className={motion.rowClassName(name, 'scorer-lineup-entry')}
      >
        <span className="scorer-lineup-player">
          <span className="scorer-lineup-name">{name}</span>
          {note && <span className="scorer-lineup-note">{note}</span>}
        </span>
        {detail && <span className="scorer-lineup-tuh">{detail}</span>}
        {isPlaying ? (
          <button
            type="button"
            className="scorer-text-action"
            id={`${idPrefix}-bench-${name}`}
            aria-label={`Bench ${name}`}
            onClick={() => {
              // Before the state changes, so the row's current position is what the travel starts
              // from. See `LineupMotion`.
              motion.beginMove(name);
              onBench(name);
            }}
          >
            Bench
          </button>
        ) : (
          <button
            type="button"
            className="scorer-text-action"
            id={`${idPrefix}-put-in-${name}`}
            aria-label={`Put ${name} in`}
            disabled={atCapacity}
            onClick={() => {
              motion.beginMove(name);
              onPutIn(name);
            }}
          >
            Put in
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="scorer-lineup-groups">
      <h4 className="scorer-lineup-group">{playingLabel}</h4>
      {playingNames.length > 0 ? (
        <ul className="scorer-lineup-list">{playingNames.map((name) => row(name, true))}</ul>
      ) : (
        <p className="scorer-lineup-count scorer-lineup-empty">Nobody is playing</p>
      )}
      <h4 className="scorer-lineup-group">{benchLabel}</h4>
      {benchNames.length > 0 ? (
        <ul className="scorer-lineup-list">{benchNames.map((name) => row(name, false))}</ul>
      ) : (
        <p className="scorer-lineup-count scorer-lineup-empty">Nobody on the bench</p>
      )}
    </div>
  );
}
