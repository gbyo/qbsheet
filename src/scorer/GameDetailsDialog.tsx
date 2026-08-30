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
import { IRoomProcedure, roomTakesBreaks } from '../scoring/RoomProcedure';
import { breaksPhrase } from '../scoring/procedureCorrection';
import { exceptionFacts, procedureExceptionLine, procedureExceptions } from '../scoring/ProcedureExceptions';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { playerNameMaxLength } from '../game/Roster';
import { teamNameMaxLength } from '../scoring/identityCorrection';
import { correctionSentence, isCorrectionNote } from '../scoring/gameCorrection';

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

/** How the scoring rules read in one line: what a correct answer is worth, and what follows it. */
function formatSummary(format: IScorekeeperFormat): string {
  const values = format.answerTypes.map((answerType) =>
    answerType.value > 0 ? `+${answerType.value}` : String(answerType.value),
  );
  const length = format.regulation.timed ? 'timed round' : `${format.regulation.tossupCount} tossups`;
  const bonus = format.bonus.enabled
    ? `bonuses to ${format.bonus.maximumScore}${format.bonus.bounceBack ? ', bouncing back' : ''}`
    : 'no bonuses';
  return `${format.name} · ${values.join(' / ')} · ${length} · ${bonus}`;
}

/** How the room procedure reads in one line. */
function procedureSummary(procedure: IRoomProcedure | undefined): string {
  const timeouts =
    (procedure?.timeoutsPerTeam ?? 0) === 0
      ? 'no timeouts tracked'
      : `${procedure?.timeoutsPerTeam} timeout${procedure?.timeoutsPerTeam === 1 ? '' : 's'} each`;
  const breaks = roomTakesBreaks(procedure) ? `breaks ${breaksPhrase(procedure)}` : 'no breaks';
  const substitutions =
    procedure?.substitutionPolicy === 'breaks-timeouts-overtime'
      ? 'lineups change at breaks only'
      : 'lineups change at any boundary';
  return `${timeouts} · ${breaks} · ${substitutions}`;
}

/** Rename one team or one player, without offering a whole roster editor to do it. */
function NameCorrectionForm(props: {
  title: string;
  initial: string;
  maxLength: number;
  /** Set when the proposed name collides with somebody already on this roster. */
  mergeOffer?: string;
  problems: string[];
  onPreview: (name: string) => void;
  onSave: (name: string, merge: boolean) => void;
  onCancel: () => void;
}) {
  const { title, initial, maxLength, mergeOffer, problems, onPreview, onSave, onCancel } = props;
  const [name, setName] = useState(initial);

  return (
    <form
      className="scorer-note-form"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        if (name.trim() === '' || name.trim() === initial) return;
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
          <button type="button" className="scorer-danger" onClick={() => onSave(name.trim(), true)}>
            They are the same person — combine them
          </button>
        </>
      )}
      <div className="rules-correction-actions">
        <button type="button" className="scorer-action" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="scorer-choice"
          disabled={name.trim() === '' || name.trim() === initial || problems.length > 0}
        >
          Save
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
    onClose,
  } = props;
  const [editing, setEditing] = useState<Editing>({ kind: 'none' });
  const [moderatorName, setModeratorName] = useState(moderator);
  const [problems, setProblems] = useState<string[]>([]);
  const [mergeWith, setMergeWith] = useState<string | undefined>(undefined);

  const stopEditing = () => {
    setEditing({ kind: 'none' });
    setProblems([]);
    setMergeWith(undefined);
  };

  if (editing.kind === 'team') {
    const side = editing.side;
    return (
      <ScorerDialog key="team" title={`Correct ${game[side].name}'s name`} onClose={onClose}>
        <p className="scorer-dialog-note">
          Every question already recorded stays with this team. The tournament&apos;s own identity for them is
          kept, so the result still matches their schedule entry.
        </p>
        <NameCorrectionForm
          title="Team name"
          initial={game[side].name}
          maxLength={teamNameMaxLength}
          problems={problems}
          onPreview={(name) => setProblems(name.trim() === '' ? [] : (teamNameProblem?.(side, name) ?? []))}
          onSave={(name) => {
            void Promise.resolve(onCorrectTeamName?.(side, name)).then(stopEditing);
          }}
          onCancel={stopEditing}
        />
      </ScorerDialog>
    );
  }

  if (editing.kind === 'player') {
    const { side, player } = editing;
    return (
      <ScorerDialog key="player" title={`Correct ${player}'s name`} onClose={onClose}>
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
            void Promise.resolve(onCorrectPlayerName?.(side, player, name, merge)).then(stopEditing);
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
                  onClick={() => {
                    setProblems([]);
                    setMergeWith(undefined);
                    setEditing({ kind: 'player', side, player: player.name });
                  }}
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
        {(['left', 'right'] as LeftOrRight[]).map((side) => (
          <DetailRow
            key={side}
            label={side === 'left' ? 'Left team' : 'Right team'}
            value={`${game[side].name} · ${game[side].players.length} on the roster`}
            action={
              onCorrectTeamName
                ? { label: 'Correct…', onSelect: () => setEditing({ kind: 'team', side }) }
                : undefined
            }
          />
        ))}
        {(['left', 'right'] as LeftOrRight[]).map((side) => (
          <DetailRow
            key={`${side}-roster`}
            label={`${game[side].name} roster`}
            value={game[side].players.map((player) => player.name).join(', ') || 'nobody yet'}
            action={
              onCorrectPlayerName
                ? { label: 'Correct…', onSelect: () => setEditing({ kind: 'roster', side }) }
                : undefined
            }
          />
        ))}
        <DetailRow
          label="Moderator"
          value={moderator || 'not recorded'}
          action={{ label: 'Edit', onSelect: () => setEditing({ kind: 'moderator' }) }}
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
            {corrections.map((note) => (
              <li key={`${note.questionNumber}-${note.text}`}>
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
