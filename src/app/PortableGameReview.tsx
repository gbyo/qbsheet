import { useRef, useState } from 'react';
import { IGameDefinition } from '../game/GameDefinition';
import { IManualGameInput, defineManualGame } from '../game/ManualGame';
import { readRosterLines } from '../game/Roster';
import { gameFormatSummary } from '../scoring/gameFormatSummary';
import NativeDialog from './NativeDialog';

export interface PortableGameActions {
  onStartManualGame?: (definition: IGameDefinition) => void | Promise<void>;
  onEditManualGame?: (input: IManualGameInput) => void;
}

export function PortableGameSummary({ input }: { input: IManualGameInput }) {
  const defined = defineManualGame(input);
  if (!defined.ok) return <p role="alert">This setup is invalid.</p>;
  const summary = gameFormatSummary(defined.definition.scorekeeperFormat, defined.definition.procedure);
  return (
    <div>
      {input.gameLabel.trim() && <h2>{input.gameLabel}</h2>}
      <p>
        <strong>
          {input.left.name} vs {input.right.name}
        </strong>
      </p>
      <div className="manual-teams">
        {(['left', 'right'] as const).map((side) => (
          <section key={side} aria-label={`${input[side].name} roster`}>
            <h3>{input[side].name}</h3>
            <ul>
              {readRosterLines(input[side].players).map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p>
        <strong>Scoring:</strong> {summary.format}
      </p>
      <p>
        <strong>Room:</strong> {summary.procedure}
      </p>
      {input.rules.mode === 'advanced' && (
        <p>
          Answer types:{' '}
          {input.rules.advanced.answerTypes
            .map(
              (row) =>
                `${row.label || row.shortLabel || 'Answer'} (${row.value}; ${row.awardsBonus ? 'earns a bonus' : 'no bonus'})`,
            )
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

/** In-memory review only. The owning screen retains all of its pairing form state behind the modal. */
export default function PortableGameReview(
  props: PortableGameActions & {
    input: IManualGameInput;
    onCancel: () => void;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const start = async () => {
    if (inFlight.current || !props.onStartManualGame) return;
    const defined = defineManualGame(props.input);
    if (!defined.ok) {
      setError('This setup is invalid. Edit it before starting.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await props.onStartManualGame(defined.definition);
    } catch {
      setError(
        'This game could not be saved locally. Your setup is still here; try again after storage is repaired.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <NativeDialog title="Review game package" onClose={props.onCancel} dismissible={!busy}>
      <p>
        Nothing has been created yet. Check the teams, players, and game settings before starting. This
        package does not connect to tournament control.
      </p>
      <PortableGameSummary input={props.input} />
      {error && (
        <p className="shell-warning" role="alert">
          {error}
        </p>
      )}
      <div className="shell-actions">
        <button
          type="button"
          className="shell-button is-primary"
          disabled={busy || !props.onStartManualGame}
          onClick={() => void start()}
        >
          {busy ? 'Starting…' : 'Start game'}
        </button>
        <button
          type="button"
          className="shell-button"
          disabled={busy || !props.onEditManualGame}
          onClick={() => props.onEditManualGame?.(props.input)}
        >
          Edit setup
        </button>
        <button type="button" className="shell-button" disabled={busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </NativeDialog>
  );
}
