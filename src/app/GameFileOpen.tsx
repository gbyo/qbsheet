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
import { IGameDefinitionOverrides, IQbjMatchCandidate, IQbjSource, orderCandidates } from '../qbj/ParseQbjAssignment';
import { IRosterPlayer } from '../game/Roster';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import ScoringRulesSetup from './ScoringRulesSetup';
import RosterSetup from './RosterSetup';

/** A document holding several games, waiting for one to be chosen. */
interface IPendingChoice {
  source: IQbjSource;
  candidates: IQbjMatchCandidate[];
}

/**
 * A game the scoresheet could read but not yet score.
 *
 * Carries the overrides gathered so far, because the questions chain: a document with neither rules
 * nor rosters asks for rules, then asks for players, and the answer to the first must survive the
 * second. Losing it would send the scorekeeper back to the rules form after typing six names.
 */
interface IPendingSetup {
  source: IQbjSource;
  index: number;
  reason: string[];
  overrides: IGameDefinitionOverrides;
  /** Which teams still need a roster. Empty for the rules question. */
  teams: string[];
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
  const [needsRules, setNeedsRules] = useState<IPendingSetup | null>(null);
  const [needsRoster, setNeedsRoster] = useState<IPendingSetup | null>(null);

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
    setNeedsRules(null);
    setNeedsRoster(null);
    const result = await new FileGameSource(file).open();
    setBusy(false);
    if (!result.ok) {
      // A gap the room can answer gets a form; anything else is something upstream has to fix, and
      // saying so plainly is the most useful thing this can do.
      if (result.source && (result.needsScoringRules || result.needsRoster)) {
        await resolve(result.source, result.index ?? 0, {});
        return;
      }
      setErrors(result.errors);
      return;
    }
    if (result.kind === 'choice') {
      setChoice({ source: result.source, candidates: orderCandidates(result.source.candidates) });
      return;
    }
    await accept(result.definition);
  };

  /**
   * Define a game, or ask the one question standing in the way of it.
   *
   * Every route into a game goes through here — opening a file, picking from the list, answering
   * the rules form, answering the roster form — so an answerable gap is asked about the same way
   * whichever route uncovered it, and the accumulated answers are carried forward.
   */
  const resolve = async (source: IQbjSource, index: number, overrides: IGameDefinitionOverrides) => {
    const defined = chooseGame(source, index, overrides);
    if (defined.ok) {
      setChoice(null);
      setNeedsRules(null);
      setNeedsRoster(null);
      await accept(defined.definition);
      return;
    }
    const pending: IPendingSetup = { source, index, reason: defined.errors, overrides, teams: [] };
    if (defined.needsScoringRules) {
      setChoice(null);
      setNeedsRoster(null);
      setNeedsRules(pending);
      return;
    }
    if (defined.needsRoster) {
      setChoice(null);
      setNeedsRules(null);
      setNeedsRoster({ ...pending, teams: defined.missingRosters ?? [] });
      return;
    }
    setErrors(defined.errors);
  };

  const pick = async (candidate: IQbjMatchCandidate) => {
    if (!choice) return;
    await resolve(choice.source, candidate.index, {});
  };

  const applyRules = async (format: IScorekeeperFormat) => {
    if (!needsRules) return;
    await resolve(needsRules.source, needsRules.index, {
      ...needsRules.overrides,
      scorekeeperFormat: format,
      timed: format.regulation.timed,
    });
  };

  const applyRosters = async (rosters: Record<string, IRosterPlayer[]>) => {
    if (!needsRoster) return;
    await resolve(needsRoster.source, needsRoster.index, {
      ...needsRoster.overrides,
      rosters: { ...needsRoster.overrides.rosters, ...rosters },
    });
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
      {needsRules && (
        <ScoringRulesSetup
          reason={needsRules.reason}
          onUse={(format) => void applyRules(format)}
          onCancel={() => setNeedsRules(null)}
        />
      )}
      {needsRoster && (
        <RosterSetup
          teams={needsRoster.teams}
          reason={needsRoster.reason}
          onUse={(rosters) => void applyRosters(rosters)}
          onCancel={() => setNeedsRoster(null)}
        />
      )}
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
