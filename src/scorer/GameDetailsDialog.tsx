/**
 * What this game *is*, as opposed to what happened in it.
 *
 * # Why this became a summary rather than a form
 *
 * It used to hold one field — the moderator's name — because that was the only thing about the game
 * itself the room could change. Everything else about the game's identity was decided by the
 * assignment and then unreachable: a team whose name came off a bracket with a typo in it stayed
 * misspelled, a room configured for one timeout stayed configured for one timeout, and a player
 * entered as "Sam" stayed a different person from the Samir on the tournament's roster.
 *
 * The fix is not a big editing form. A scorekeeper opening this mid-round is nearly always checking
 * something — which packet is this, who is the moderator, how many timeouts do they get — and a
 * screen of inputs makes checking into a thing you can accidentally change. So this reads as a
 * scoresheet header: short lines of fact, with a quiet action beside the ones that can actually be
 * corrected, and nothing at all beside the ones that cannot.
 *
 * # One place, so there is one place
 *
 * `Correct scoring rules…` used to be its own Game-menu entry, filed under Review. It is a
 * correction to the game's definition rather than to anything that happened, which is what every
 * other row here is, so it lives here now and the menu is one entry shorter. The cost is one press
 * for a rare action; the benefit is that a scorekeeper looking for "the rules are wrong" finds it in
 * the same place as "the team name is wrong" and "the procedure is wrong".
 */
import { useState } from 'react';
import ScorerDialog from './ScorerDialog';
import { LeftOrRight } from '../scoring/types';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IDerivedGame } from '../scoring/deriveGame';
import { IRoomProcedure } from '../scoring/RoomProcedure';
import { formatSummary, procedureSummary } from '../scoring/gameFormatSummary';
import { exceptionFacts, procedureExceptionLine, procedureExceptions } from '../scoring/ProcedureExceptions';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { playerNameMaxLength } from '../game/Roster';
import { teamNameMaxLength } from '../scoring/identityCorrection';
import { correctionSentence, GameCorrectionRefusal, isCorrectionNote } from '../scoring/gameCorrection';
import {
  canonicalSideForDisplay,
  DisplaySideMapping,
  identityDisplaySideMapping,
} from './DisplaySideMapping';

export interface IGameIdentityFacts {
  tournamentName: string;
  roundName: string;
  roomName?: string;
  packetName?: string;
}

/** One line of the summary, with its action only when there is something the room may do. */
function DetailRow(props: {
  label: string;
  value: string;
  action?: { label: string; onSelect: () => void };
}) {
  const { label, value, action } = props;
  return (
    <div className="scorer-detail-row">
      <dt>{label}</dt>
      <dd>
        <span className="scorer-detail-value">{value}</span>
        {action && (
          <button type="button" className="scorer-text-action" onClick={action.onSelect}>
            {action.label}
          </button>
        )}
      </dd>
    </div>
  );
}

/**
 * Rename one team or one player, without offering a whole roster editor to do it.
 *
 * # Why it can be mid-save
 *
 * A rename is persisted by the host, and the host can refuse it: `ScoringScreen.correctGame` throws
 * a `GameCorrectionRefusal` when the journal or the record store would not take the change. This
 * form used to close itself the moment the promise settled either way, which meant a refused rename
 * looked exactly like an applied one — the editor went away, the old name was still on the
 * scoresheet, and whoever typed it had no reason to look again. So the same standard the scoring
 * rules correction already holds itself to: one submission at a time, the reason on screen beside
 * the field it belongs to, and the typed name still there to press Save on again.
 */
function NameCorrectionForm(props: {
  title: string;
  initial: string;
  maxLength: number;
  /** Set when the proposed name collides with somebody already on this roster. */
  mergeOffer?: string;
  problems: string[];
  /** What the device said when it refused to write the correction. Empty until it has. */
  failure: string;
  /** True while the correction is being persisted, when nothing may be submitted again. */
  saving: boolean;
  onPreview: (name: string) => void;
  onSave: (name: string, merge: boolean) => void;
  onCancel: () => void;
}) {
  const { title, initial, maxLength, mergeOffer, problems, failure, saving, onPreview, onSave, onCancel } =
    props;
  const [name, setName] = useState(initial);
  const unusable = name.trim() === '' || name.trim() === initial || problems.length > 0;

  return (
    <form
      className="scorer-note-form"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        if (unusable || saving) return;
        onSave(name.trim(), false);
      }}
    >
      <label htmlFor="scorer-name-correction">
        {title}
        <input
          id="scorer-name-correction"
          data-dialog-autofocus
          value={name}
          maxLength={maxLength}
          disabled={saving}
          onChange={(changeEvent) => {
            setName(changeEvent.target.value);
            onPreview(changeEvent.target.value);
          }}
        />
      </label>
      {problems.map((problem) => (
        <p key={problem} className="scorer-problem" role="alert">
          {problem}
        </p>
      ))}
      {mergeOffer !== undefined && (
        <>
          <p className="scorer-dialog-note">
            If {initial} and {mergeOffer} are the same person, everything recorded for {initial} can be moved
            onto {mergeOffer}. That cannot be undone by renaming them back.
          </p>
          <button
            type="button"
            className="scorer-danger"
            disabled={saving || name.trim() === ''}
            onClick={() => onSave(name.trim(), true)}
          >
            They are the same person — combine them
          </button>
        </>
      )}
      {failure !== '' && (
        <p className="scorer-problem" role="alert">
          {failure}
        </p>
      )}
      <div className="rules-correction-actions">
        <button type="button" className="scorer-action" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="scorer-choice" disabled={unusable || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

export interface IGameDetailsDialogProps {
  identity: IGameIdentityFacts;
  game: IDerivedGame;
  format: IScorekeeperFormat;
  procedure: IRoomProcedure | undefined;
  events: readonly ScoreEvent[];
  moderator: string;
  scorekeeper: string;
  onSaveModerator: (moderator: string) => void;
  /**
   * Correct a name. Absent when nothing above the scorer can persist the change — the practice
   * screen, chiefly — in which case the row shows the fact and no action, exactly as the rows that
   * were never editable do.
   */
  onCorrectTeamName?: (side: LeftOrRight, name: string) => void | Promise<void>;
  onCorrectPlayerName?: (side: LeftOrRight, from: string, to: string, merge: boolean) => void | Promise<void>;
  /** What the proposed name would be refused for, asked as it is typed. */
  teamNameProblem?: (side: LeftOrRight, name: string) => string[];
  playerNameProblem?: (
    side: LeftOrRight,
    from: string,
    to: string,
  ) => { problems: string[]; mergeWith?: string };
  onCorrectScoringRules?: () => void;
  onCorrectProcedure?: () => void;
  /** Current presentation order; scoring facts and corrections remain canonical. */
  displaySides?: DisplaySideMapping;
  /** Swap only the two displayed columns. This must not write a score event. */
  onSwapSides?: () => void;
  onClose: () => void;
}

type Editing =
  | { kind: 'none' }
  | { kind: 'moderator' }
  | { kind: 'team'; side: LeftOrRight }
  | { kind: 'player'; side: LeftOrRight; player: string }
  | { kind: 'roster'; side: LeftOrRight };

export default function GameDetailsDialog(props: IGameDetailsDialogProps) {
  const {
    identity,
    game,
    format,
    procedure,
    events,
    moderator,
    scorekeeper,
    onSaveModerator,
    onCorrectTeamName,
    onCorrectPlayerName,
    teamNameProblem,
    playerNameProblem,
    onCorrectScoringRules,
    onCorrectProcedure,
    displaySides = identityDisplaySideMapping,
    onSwapSides,
    onClose,
  } = props;
  const [editing, setEditing] = useState<Editing>({ kind: 'none' });
  const [moderatorName, setModeratorName] = useState(moderator);
  const [problems, setProblems] = useState<string[]>([]);
  const [mergeWith, setMergeWith] = useState<string | undefined>(undefined);
  /** True from the moment a rename is submitted until the host has accepted or refused it. */
  const [saving, setSaving] = useState(false);
  /** The refusal on screen, if the last attempt was refused. Cleared by the next attempt. */
  const [failure, setFailure] = useState('');

  const stopEditing = () => {
    setEditing({ kind: 'none' });
    setProblems([]);
    setMergeWith(undefined);
    setSaving(false);
    setFailure('');
  };

  /** Open one editor with nothing left over from the last one that was open. */
  const beginEditing = (next: Editing) => {
    setProblems([]);
    setMergeWith(undefined);
    setSaving(false);
    setFailure('');
    setEditing(next);
  };

  /**
   * Submit one name correction and only close on success.
   *
   * The refusal's own sentence is preferred when the host marked one for the room, because "nothing
   * has changed" is a claim only the host can make; anything else thrown is reported in this
   * screen's own words rather than rendered, which is what every other surface in this application
   * does with an error string. See `GameCorrectionRefusal`.
   */
  const persistCorrection = async (write: () => void | Promise<void>): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setFailure('');
    try {
      await write();
    } catch (thrown) {
      // Still open, still holding what was typed: pressing Save again is the retry.
      setSaving(false);
      setFailure(
        thrown instanceof GameCorrectionRefusal && thrown.message.trim() !== ''
          ? thrown.message
          : 'That correction could not be saved on this device. Nothing has changed; try again.',
      );
      return;
    }
    stopEditing();
  };

  if (editing.kind === 'team') {
    const side = editing.side;
    return (
      /*
        Not dismissible while the write is in flight. Disabling the form's own controls was not
        enough: Escape and the close button reach the dialog rather than the form, and a Game
        details that has unmounted has nowhere to show the refusal that arrives after it.
      */
      <ScorerDialog
        key="team"
        title={`Correct ${game[side].name}'s name`}
        onClose={onClose}
        dismissible={!saving}
      >
        <p className="scorer-dialog-note">
          Every question already recorded stays with this team. The tournament&apos;s own identity for them is
          kept, so the result still matches their schedule entry.
        </p>
        <NameCorrectionForm
          title="Team name"
          initial={game[side].name}
          maxLength={teamNameMaxLength}
          problems={problems}
          failure={failure}
          saving={saving}
          onPreview={(name) => setProblems(name.trim() === '' ? [] : (teamNameProblem?.(side, name) ?? []))}
          onSave={(name) => {
            void persistCorrection(() => onCorrectTeamName?.(side, name));
          }}
          onCancel={stopEditing}
        />
      </ScorerDialog>
    );
  }

  if (editing.kind === 'player') {
    const { side, player } = editing;
    return (
      <ScorerDialog key="player" title={`Correct ${player}'s name`} onClose={onClose} dismissible={!saving}>
        <p className="scorer-dialog-note">
          Everything {player} has already been credited with follows the new name. Their tossups heard do not
          change.
        </p>
        <NameCorrectionForm
          title="Player name"
          initial={player}
          maxLength={playerNameMaxLength}
          problems={problems}
          mergeOffer={mergeWith}
          failure={failure}
          saving={saving}
          onPreview={(name) => {
            if (name.trim() === '' || name.trim() === player) {
              setProblems([]);
              setMergeWith(undefined);
              return;
            }
            const verdict = playerNameProblem?.(side, player, name) ?? { problems: [] };
            setProblems(verdict.problems);
            setMergeWith(verdict.mergeWith);
          }}
          onSave={(name, merge) => {
            void persistCorrection(() => onCorrectPlayerName?.(side, player, name, merge));
          }}
          onCancel={stopEditing}
        />
      </ScorerDialog>
    );
  }

  if (editing.kind === 'roster') {
    const side = editing.side;
    return (
      <ScorerDialog key="roster" title={`${game[side].name} roster`} onClose={onClose}>
        <p className="scorer-dialog-note">
          Correcting a name here rewrites every question that already refers to it. To add somebody or change
          who is on the floor, use Players on the scoresheet.
        </p>
        <ul className="scorer-detail-roster">
          {game[side].players.map((player) => (
            <li key={player.name}>
              <span>{player.name}</span>
              <span className="scorer-lineup-tuh">{player.tossupsHeard} TUH</span>
              {onCorrectPlayerName && (
                <button
                  type="button"
                  className="scorer-text-action"
                  onClick={() => beginEditing({ kind: 'player', side, player: player.name })}
                >
                  Correct
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="rules-correction-actions">
          <button type="button" className="scorer-action" onClick={stopEditing}>
            Back
          </button>
        </div>
      </ScorerDialog>
    );
  }

  if (editing.kind === 'moderator') {
    return (
      <ScorerDialog key="moderator" title="Who read this round" onClose={onClose}>
        <form
          className="scorer-note-form"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            onSaveModerator(moderatorName.trim());
            stopEditing();
          }}
        >
          <label htmlFor="scorer-moderator">
            Moderator / reader
            <input
              id="scorer-moderator"
              data-dialog-autofocus
              value={moderatorName}
              maxLength={120}
              placeholder="Optional"
              onChange={(changeEvent) => setModeratorName(changeEvent.target.value)}
            />
          </label>
          <p className="scorer-dialog-note">
            Recorded on the result for later auditing. It does not affect scoring.
          </p>
          <div className="rules-correction-actions">
            <button type="button" className="scorer-action" onClick={stopEditing}>
              Cancel
            </button>
            <button type="submit" className="scorer-choice">
              Save
            </button>
          </div>
        </form>
      </ScorerDialog>
    );
  }

  const interventions = procedureExceptions(events);
  const corrections = game.notes.filter((note) => isCorrectionNote(note.text));

  return (
    <ScorerDialog key="summary" title="Game details" onClose={onClose} wide>
      <dl className="scorer-detail-list">
        <DetailRow label="Tournament" value={identity.tournamentName} />
        <DetailRow
          label="Round"
          value={[identity.roundName, identity.roomName].filter(Boolean).join(' · ')}
        />
        {identity.packetName && <DetailRow label="Packet" value={identity.packetName} />}
        {(['left', 'right'] as LeftOrRight[]).map((displaySide) => {
          const side = canonicalSideForDisplay(displaySides, displaySide);
          return (
            <DetailRow
              key={displaySide}
              label={displaySide === 'left' ? 'Left team' : 'Right team'}
              value={`${game[side].name} · ${game[side].players.length} on the roster`}
              action={
                onCorrectTeamName
                  ? { label: 'Correct…', onSelect: () => beginEditing({ kind: 'team', side }) }
                  : undefined
              }
            />
          );
        })}
        {(['left', 'right'] as LeftOrRight[]).map((displaySide) => {
          const side = canonicalSideForDisplay(displaySides, displaySide);
          return (
            <DetailRow
              key={`${displaySide}-roster`}
              label={`${game[side].name} roster`}
              value={game[side].players.map((player) => player.name).join(', ') || 'nobody yet'}
              action={
                onCorrectPlayerName
                  ? { label: 'Correct…', onSelect: () => beginEditing({ kind: 'roster', side }) }
                  : undefined
              }
            />
          );
        })}
        <DetailRow
          label="Sides on screen"
          value={`${game[displaySides.left].name} on left · ${game[displaySides.right].name} on right`}
          action={onSwapSides ? { label: 'Swap team sides', onSelect: onSwapSides } : undefined}
        />
        <DetailRow
          label="Moderator"
          value={moderator || 'not recorded'}
          action={{ label: 'Edit', onSelect: () => beginEditing({ kind: 'moderator' }) }}
        />
        <DetailRow label="Scorekeeper" value={scorekeeper || 'not signed in on this device'} />
        <DetailRow
          label="Scoring rules"
          value={formatSummary(format)}
          action={onCorrectScoringRules ? { label: 'Correct…', onSelect: onCorrectScoringRules } : undefined}
        />
        <DetailRow
          label="Room procedure"
          value={procedureSummary(procedure)}
          action={onCorrectProcedure ? { label: 'Change…', onSelect: onCorrectProcedure } : undefined}
        />
      </dl>

      {/*
        The audit, and only when there is one. A game nobody had to intervene in shows nothing here,
        which is every ordinary game.
      */}
      {(interventions.length > 0 || corrections.length > 0) && (
        <section className="scorer-detail-interventions" aria-label="Interventions">
          <h3 className="scorer-dialog-subhead">What has been changed or allowed</h3>
          <ul className="scorer-note-list">
            {corrections.map((note, index) => (
              <li key={`${note.questionNumber}-${note.text}-${index}`}>
                <span className="scorer-note-q">Q{note.questionNumber}</span>
                <span>{correctionSentence(note.text)}</span>
              </li>
            ))}
            {interventions.map((exception) => (
              <li key={exception.id}>
                <span>
                  {procedureExceptionLine(
                    exceptionFacts(exception, { left: game.left.name, right: game.right.name }),
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </ScorerDialog>
  );
}
