/**
 * Opening a game file, by picker or by drop.
 *
 * The drop zone is the button. There is no separate dashed rectangle, because a scorekeeper who
 * knows to drag a file will drag it onto the thing that says "Open game file", and one who does not
 * will click it — and a large empty target that does nothing when clicked is worse than no target.
 *
 * Errors from validation are shown in full and in place. A game file that will not open is somebody
 * else's problem to fix, and "That file could not be opened" tells them nothing they can act on.
 */
import { DragEvent, useRef, useState } from 'react';
import { FileGameSource, fileFromDrop, gameFileAccept } from '../integrations/file/FileGameSource';
import { IGameDefinition } from '../game/GameDefinition';
import { chooseGame } from '../game/OpenGameDefinition';
import { IQbjMatchCandidate, IQbjSource, orderCandidates } from '../qbj/ParseQbjAssignment';

/** A document holding several games, waiting for one to be chosen. */
interface IPendingChoice {
  source: IQbjSource;
  candidates: IQbjMatchCandidate[];
}

export default function GameFileOpen(props: {
  label?: string;
  onOpen: (definition: IGameDefinition) => void | Promise<void>;
}) {
  const { label = 'Open game file', onOpen } = props;
  const input = useRef<HTMLInputElement | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<IPendingChoice | null>(null);

  /*
   * Provenance notices are deliberately not shown here. Opening a game replaces this screen, so
   * anything rendered at this point is unmounted before it can be read; `GameOriginNotice` shows it
   * alongside the game instead. What stays here is what happens *before* a game starts: the picker,
   * and the reasons a document could not be opened at all.
   */
  const accept = async (definition: IGameDefinition) => {
    await onOpen(definition);
  };

  const read = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setErrors([]);
    setChoice(null);
    const result = await new FileGameSource(file).open();
    setBusy(false);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (result.kind === 'choice') {
      setChoice({ source: result.source, candidates: orderCandidates(result.source.candidates) });
      return;
    }
    await accept(result.definition);
  };

  const pick = async (candidate: IQbjMatchCandidate) => {
    if (!choice) return;
    const defined = chooseGame(choice.source, candidate.index);
    if (!defined.ok) {
      setErrors(defined.errors);
      return;
    }
    setChoice(null);
    await accept(defined.definition);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void read(fileFromDrop(event.dataTransfer));
  };

  return (
    <div
      className={dragging ? 'file-open is-dragging' : 'file-open'}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={input}
        type="file"
        className="file-open-input"
        accept={gameFileAccept}
        onChange={(event) => {
          void read(event.target.files?.[0] ?? null);
          // Clear it, so choosing the same file twice in a row still fires a change.
          event.target.value = '';
        }}
      />
      <button type="button" className="shell-button" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Opening…' : label}
      </button>
      {choice && <GamePicker choice={choice} onPick={(candidate) => void pick(candidate)} />}
      {errors.length > 0 && (
        <div className="shell-errors" role="alert">
          <strong>That game file cannot be used.</strong>
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Choosing one game out of a document that holds several.
 *
 * A list, grouped by round, in schedule order. Not cards, not a grid, not a search box: a room
 * opening a whole-tournament QBJ is looking for one line and the fastest way to find it is for the
 * lines to be short and in the order the schedule is in.
 *
 * A game that already carries a result is shown with what it is rather than hidden, because the
 * scorekeeper may well be looking for exactly that one — and is never the game offered first.
 */
function GamePicker(props: { choice: IPendingChoice; onPick: (candidate: IQbjMatchCandidate) => void }) {
  const { choice, onPick } = props;

  const groups: { label: string; candidates: IQbjMatchCandidate[] }[] = [];
  for (const candidate of choice.candidates) {
    const label = candidate.roundName
      ? `Round ${candidate.roundName}`.replace(/^Round Round /, 'Round ')
      : candidate.phaseName ?? 'Games';
    const existing = groups.find((group) => group.label === label);
    if (existing) existing.candidates.push(candidate);
    else groups.push({ label, candidates: [candidate] });
  }

  return (
    <div className="game-picker">
      <h2 className="game-picker-title">Choose a game</h2>
      {groups.map((group) => (
        <section key={group.label} className="game-picker-group">
          <h3 className="game-picker-round">{group.label}</h3>
          <ul className="game-picker-list">
            {group.candidates.map((candidate) => (
              <li key={candidate.index}>
                <button type="button" className="game-picker-entry" onClick={() => onPick(candidate)}>
                  <span className="game-picker-room">{candidate.location ?? ''}</span>
                  <span className="game-picker-matchup">
                    {candidate.leftName} vs {candidate.rightName}
                  </span>
                  {candidate.state !== 'unplayed' && (
                    <span className="game-picker-state">
                      {candidate.state === 'complete' ? 'Has a result' : 'Partly scored'}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
