/**
 * The last look before a result leaves the room, and the halftime score check on the way there.
 *
 * # Review is deliberately not a terminal state
 *
 * A paper scoresheet ends with the teams and moderator agreeing on the score, but that agreement is
 * also the last good moment to catch a mistake. The screen therefore stays editable whether this is
 * the room's first send or a later correction of a result that was already handed off.
 *
 * The score is the visual center. Editing stays beside it. Detailed player lines, exports and other
 * forensic information remain available without competing with the one decision the room is making:
 * is this the result we mean to send?
 */
import { useState } from 'react';
import { LeftOrRight } from '../scoring/types';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IDerivedGame, IDerivedTeam } from '../scoring/deriveGame';
import { protestStatusLabels, protestSubjectLabels } from './ProcedureDialogs';
import SpreadsheetCopyPanel from './SpreadsheetCopyPanel';
import { DisplaySideMapping, identityDisplaySideMapping, mapSides } from './DisplaySideMapping';

/** "+15" / "-5". */
function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/** Every player's line, as a scoresheet has it. */
function TeamLines(props: { format: IScorekeeperFormat; team: IDerivedTeam }) {
  const { format, team } = props;
  const played = team.players.filter((player) => player.tossupsHeard > 0 || player.answerCounts.size > 0);

  return (
    <section className="scorer-check-team" aria-label={`${team.name} players`}>
      <h3 className="scorer-check-team-name">
        {team.name} <span className="scorer-check-team-score">{team.points}</span>
      </h3>
      <table className="scorer-check-table">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">TUH</th>
            {format.answerTypes.map((answerType) => (
              <th key={answerType.index} scope="col">
                {signed(answerType.value)}
              </th>
            ))}
            <th scope="col">Pts</th>
          </tr>
        </thead>
        <tbody>
          {played.map((player) => (
            <tr key={player.name}>
              <th scope="row">{player.name}</th>
              <td>{player.tossupsHeard}</td>
              {format.answerTypes.map((answerType) => (
                <td key={answerType.index}>{player.answerCounts.get(answerType.index) ?? 0}</td>
              ))}
              <td>{player.points}</td>
            </tr>
          ))}
          {played.length === 0 && (
            <tr>
              <td colSpan={format.answerTypes.length + 3}>Nobody on this team heard a tossup.</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="scorer-check-breakdown">
        Tossups {team.tossupPoints} · Bonuses {team.bonusPoints}
        {team.bonusBouncebackPoints > 0 && <> · Bouncebacks {team.bonusBouncebackPoints}</>}
        {team.lightningPoints > 0 && <> · Lightning {team.lightningPoints}</>}
        {team.adjustmentPoints !== 0 && <> · Adjustment {signed(team.adjustmentPoints)}</>}
      </p>
    </section>
  );
}

/** The break the room has stopped at. */
export function HalftimeCheck(props: {
  game: IDerivedGame;
  afterQuestion: number;
  /** What this room calls the break it is at. See `roomBreakLabel`. */
  breakName?: string;
  /** Procedure-aware lineup guidance; never assume a tournament permits a change. */
  substitutionMessage?: string;
  onPlayers: () => void;
  onContinue: () => void;
  /** Screen order only; the derived game remains canonical. */
  displaySides?: DisplaySideMapping;
}) {
  const {
    game,
    afterQuestion,
    breakName = 'Halftime',
    substitutionMessage = 'Lineup changes can be recorded here; follow the tournament procedure.',
    onPlayers,
    onContinue,
    displaySides = identityDisplaySideMapping,
  } = props;
  const displayedScore = mapSides({ left: game.left.points, right: game.right.points }, displaySides);

  return (
    <section className="scorer-score-check" aria-label={`${breakName} score check`}>
      <p className="scorer-check-heading">
        {breakName} · after tossup {afterQuestion}
      </p>
      <p className="scorer-complete-score">
        <span>
          {game[displaySides.left].name} <strong>{displayedScore.left}</strong>
        </span>
        <span>
          {game[displaySides.right].name} <strong>{displayedScore.right}</strong>
        </span>
      </p>
      <p className="scorer-dialog-note">Read the score to the moderator. {substitutionMessage}</p>
      <div className="scorer-complete-actions">
        <button type="button" className="scorer-action" onClick={onPlayers}>
          Players
        </button>
        <button type="button" className="scorer-submit" onClick={onContinue}>
          Score confirmed · Continue
        </button>
      </div>
    </section>
  );
}

export interface IPreSubmitReviewProps {
  format: IScorekeeperFormat;
  game: IDerivedGame;
  /** Roster additions this device made that tournament control has not taken yet. */
  unsyncedRosterAdditions: { team: LeftOrRight; playerName: string }[];
  /** Things worth saying that do not stop a submission. */
  warnings: string[];
  submitting: boolean;
  /** Set when the engine says the game cannot be submitted at all. */
  blockers: string[];
  onSubmit: () => void;
  onDownload: () => void;
  /** Opens the auditable question/event editor. */
  onReview: () => void;
  /** Reopens a game whose explicit terminal event can safely be undone. */
  onResume?: () => void;
  /** Canonical spreadsheet copy, when the host has a durable game package to export. */
  spreadsheetTsv?: string;
  spreadsheetGameLabel?: string;
  spreadsheetSuggestedTabName?: string;
  /** Screen order only; canonical event and result semantics are unchanged. */
  displaySides?: DisplaySideMapping;
}

export default function PreSubmitReview(props: IPreSubmitReviewProps) {
  const {
    format,
    game,
    unsyncedRosterAdditions,
    warnings,
    submitting,
    blockers,
    onSubmit,
    onDownload,
    onReview,
    onResume,
    spreadsheetTsv,
    spreadsheetGameLabel,
    spreadsheetSuggestedTabName,
    displaySides = identityDisplaySideMapping,
  } = props;
  // Confirmation belongs to the exact derived result shown here. A correction, undo, or redo
  // replaces `game`, so identity makes a previous acknowledgement invalid without an effect-driven
  // render in between the new result and its checkbox.
  const [confirmedGame, setConfirmedGame] = useState<IDerivedGame | null>(null);
  const confirmed = confirmedGame === game;

  const openProtests = game.protests.filter((protest) => protest.status === 'open');
  const totalTuh = game.tossupsRead;
  const displayedScore = mapSides({ left: game.left.points, right: game.right.points }, displaySides);
  const hasAttention =
    blockers.length > 0 ||
    warnings.length > 0 ||
    openProtests.length > 0 ||
    unsyncedRosterAdditions.length > 0;
  const reversibleFinish =
    game.phase.kind === 'complete' && (game.phase.reason === 'forfeit' || game.phase.reason === 'short');
  const finalScoreLabel =
    game.phase.kind === 'complete' && game.phase.reason === 'forfeit'
      ? 'Final score — forfeit'
      : game.phase.kind === 'complete' && game.phase.reason === 'short'
        ? 'Final score — game ended early'
        : 'Final score';

  return (
    <div className="scorer-presubmit scorer-review-submit">
      <header className="scorer-review-submit-head">
        <div>
          <p className="scorer-review-submit-eyebrow">Review &amp; submit</p>
          <h2 className="scorer-review-submit-title">Confirm the result</h2>
          <p className="scorer-review-submit-state">
            You can still edit this game here. Submit sends the score shown below; if you opened a result
            that was already sent, submit again only after making a correction.
          </p>
        </div>
        <p className="scorer-complete-title scorer-review-submit-phase">{finalScoreLabel}</p>
      </header>

      <section className="scorer-review-score" aria-label="Final score">
        <div className="scorer-review-score-team">
          <span className="scorer-review-score-name">{game[displaySides.left].name}</span>
          <strong className="scorer-review-score-number">{displayedScore.left}</strong>
        </div>
        <span className="scorer-review-score-separator" aria-hidden="true">
          —
        </span>
        <div className="scorer-review-score-team is-right">
          <strong className="scorer-review-score-number">{displayedScore.right}</strong>
          <span className="scorer-review-score-name">{game[displaySides.right].name}</span>
        </div>
      </section>

      <p className="scorer-review-score-detail">
        {totalTuh} tossup{totalTuh === 1 ? '' : 's'} heard
        {game.overtimeTossupsRead > 0 && <>, {game.overtimeTossupsRead} in overtime</>}
        {game.endedEarly && <> · ended early: {game.endedEarly.reason}</>}
      </p>

      <div className="scorer-review-edit-actions">
        <button
          type="button"
          className="scorer-action scorer-review-edit"
          onClick={onReview}
          disabled={submitting}
        >
          Edit game
        </button>
        {reversibleFinish && (
          <button
            type="button"
            className="scorer-action"
            onClick={onResume ?? onReview}
            disabled={submitting}
            aria-describedby={onResume ? undefined : 'scorer-review-resume-note'}
          >
            {onResume ? 'Resume scoring' : 'Resume scoring…'}
          </button>
        )}
        <span className="scorer-review-edit-note">
          Corrections recalculate the score and player statistics automatically.
          {reversibleFinish && !onResume && (
            <>
              {' '}
              <span id="scorer-review-resume-note">
                To continue play, open the review and remove the game-ending event.
              </span>
            </>
          )}
        </span>
      </div>

      {hasAttention && (
        <section className="scorer-review-attention" aria-labelledby="scorer-review-attention-title">
          <div className="scorer-review-attention-head">
            <h3 id="scorer-review-attention-title">Needs attention</h3>
            <button type="button" className="scorer-text-action" onClick={onReview} disabled={submitting}>
              Fix in scoresheet
            </button>
          </div>

          {blockers.length > 0 && (
            <div className="scorer-review-attention-group is-blocking">
              <p className="scorer-review-attention-label">Must fix before submitting</p>
              <ul>
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="scorer-review-attention-group">
              <p className="scorer-review-attention-label">Check before submitting</p>
              <ul>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              {blockers.length === 0 && (
                <p className="scorer-review-attention-note">These do not block submission.</p>
              )}
            </div>
          )}

          {openProtests.length > 0 && (
            <div className="scorer-review-attention-group">
              <p className="scorer-review-attention-label">Unresolved protests</p>
              <ul>
                {openProtests.map((protest) => (
                  <li key={protest.eventId}>
                    Q{protest.questionNumber} · {protest.teamName} · {protestSubjectLabels[protest.subject]}{' '}
                    &mdash; {protest.description} ({protestStatusLabels[protest.status]})
                  </li>
                ))}
              </ul>
              <p className="scorer-review-attention-note">
                The result may still be sent. Tournament control will see the open protest before accepting
                it.
              </p>
            </div>
          )}

          {unsyncedRosterAdditions.length > 0 && (
            <div className="scorer-review-attention-group">
              <p className="scorer-review-attention-label">Players added in this room</p>
              <ul>
                {unsyncedRosterAdditions.map((addition) => (
                  <li key={`${addition.team}-${addition.playerName}`}>
                    {addition.playerName} ({game[addition.team].name}) is not on the tournament roster yet.
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <details className="scorer-review-section">
        <summary>Player stats</summary>
        <p className="scorer-review-section-note">
          Use these lines to check tossups heard and individual scoring.
        </p>
        <div className="scorer-check-teams">
          <TeamLines format={format} team={game[displaySides.left]} />
          <TeamLines format={format} team={game[displaySides.right]} />
        </div>
      </details>

      <details className="scorer-review-section scorer-review-export">
        <summary>Backup &amp; export</summary>
        <p className="scorer-review-section-note">
          These are recovery and spreadsheet tools. They do not submit the result to tournament control.
        </p>
        <div className="scorer-review-export-actions">
          <button type="button" className="scorer-action" onClick={onDownload}>
            Download QBJ backup
          </button>
        </div>
        {spreadsheetTsv !== undefined && spreadsheetGameLabel && (
          <SpreadsheetCopyPanel
            tsv={spreadsheetTsv}
            gameLabel={spreadsheetGameLabel}
            suggestedTabName={spreadsheetSuggestedTabName}
            disabled={submitting || blockers.length > 0}
          />
        )}
      </details>

      <section className="scorer-review-submit-final" aria-label="Submit result">
        <label
          className="scorer-checkbox scorer-confirm scorer-review-confirm"
          htmlFor="scorer-final-confirm"
        >
          <input
            id="scorer-final-confirm"
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmedGame(e.target.checked ? game : null)}
          />
          Final score confirmed with both teams
        </label>
        <div className="scorer-review-submit-buttons">
          <button type="button" className="scorer-action" onClick={onReview} disabled={submitting}>
            Edit game
          </button>
          <button
            type="button"
            className="scorer-submit"
            onClick={onSubmit}
            disabled={submitting || !confirmed || blockers.length > 0}
          >
            {submitting ? 'Sending…' : 'Submit result'}
          </button>
        </div>
        {blockers.length > 0 && (
          <p className="scorer-review-submit-blocked">
            Fix the blocking scoresheet problem above before submitting.
          </p>
        )}
      </section>
    </div>
  );
}
