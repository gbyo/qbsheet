/**
 * The last look before a result leaves the room, and the halftime score check on the way there.
 *
 * # Why a result needs a check and not just a Submit button
 *
 * Because a paper scoresheet ends with the two teams and the moderator agreeing a final score, and
 * that step is not bureaucracy — it is the only place a transposed bonus or a buzz put on the wrong
 * team gets caught while the people who saw it happen are still in the room. Once the result is with
 * tournament control, the same mistake costs a phone call, a reopened match, and possibly a bracket.
 *
 * So the room shows what it is about to send — the score, the tossups, every player's line, and
 * anything still outstanding — and asks for one confirmation. Not a signature, not a second device,
 * not a workflow. One sentence and one button, the way the paper does it.
 */
import { useState } from 'react';
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IDerivedGame, IDerivedTeam } from '../scoring/deriveGame';
import { protestStatusLabels, protestSubjectLabels } from './ProcedureDialogs';

/** "+15" / "-5". */
function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Every player's line, as a scoresheet has it.
 *
 * Tossups heard first, because that is the number YellowFruit validates and the one a room is most
 * likely to have got wrong; then the answer counts in the format's own order; then points.
 */
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

/**
 * The break between halves.
 *
 * Deliberately the smallest thing that could work: the score, a way to look at the players, and one
 * button that means "the moderator and I agree". Nothing about the scoring engine changes across it.
 */
export function HalftimeCheck(props: {
  game: IDerivedGame;
  afterQuestion: number;
  onPlayers: () => void;
  onContinue: () => void;
}) {
  const { game, afterQuestion, onPlayers, onContinue } = props;

  return (
    <section className="scorer-score-check" aria-label="Halftime score check">
      <p className="scorer-check-heading">Halftime · after tossup {afterQuestion}</p>
      <p className="scorer-complete-score">
        <span>
          {game.left.name} <strong>{game.left.points}</strong>
        </span>
        <span>
          {game.right.name} <strong>{game.right.points}</strong>
        </span>
      </p>
      <p className="scorer-dialog-note">Read the score to the moderator. Substitutions are allowed now.</p>
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
  onReview: () => void;
}

export default function PreSubmitReview(props: IPreSubmitReviewProps) {
  const { format, game, unsyncedRosterAdditions, warnings, submitting, blockers, onSubmit, onDownload, onReview } =
    props;
  const [confirmed, setConfirmed] = useState(false);

  const openProtests = game.protests.filter((protest) => protest.status === 'open');
  const totalTuh = game.tossupsRead;

  return (
    <div className="scorer-presubmit">
      <p className="scorer-complete-title">
        Final score
        {game.phase.kind === 'complete' && game.phase.reason === 'forfeit' && <> &mdash; forfeit</>}
        {game.phase.kind === 'complete' && game.phase.reason === 'short' && <> &mdash; game ended early</>}
      </p>
      <p className="scorer-complete-score">
        <span>
          {game.left.name} <strong>{game.left.points}</strong>
        </span>
        <span>
          {game.right.name} <strong>{game.right.points}</strong>
        </span>
      </p>
      <p className="scorer-complete-detail">
        {totalTuh} tossup{totalTuh === 1 ? '' : 's'} heard
        {game.overtimeTossupsRead > 0 && <>, {game.overtimeTossupsRead} in overtime</>}
        {game.endedEarly && <> · ended early: {game.endedEarly.reason}</>}
      </p>

      <div className="scorer-check-teams">
        <TeamLines format={format} team={game.left} />
        <TeamLines format={format} team={game.right} />
      </div>

      {openProtests.length > 0 && (
        <div className="scorer-check-outstanding">
          <h3>Unresolved protests</h3>
          <ul>
            {openProtests.map((protest) => (
              <li key={protest.eventId}>
                Q{protest.questionNumber} · {protest.teamName} · {protestSubjectLabels[protest.subject]} &mdash;{' '}
                {protest.description} ({protestStatusLabels[protest.status]})
              </li>
            ))}
          </ul>
          <p className="scorer-dialog-note">
            The result can still be sent. Tournament control is told the protest is outstanding and will see it before
            accepting the game.
          </p>
        </div>
      )}

      {unsyncedRosterAdditions.length > 0 && (
        <div className="scorer-check-outstanding">
          <h3>Players added in this room</h3>
          <ul>
            {unsyncedRosterAdditions.map((addition) => (
              <li key={`${addition.team}-${addition.playerName}`}>
                {addition.playerName} ({game[addition.team].name}) is not on the tournament roster yet.
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.map((warning) => (
        <p key={warning} className="scorer-complete-warning">
          {warning}
        </p>
      ))}
      {blockers.map((blocker) => (
        <p key={blocker} className="scorer-problem">
          {blocker}
        </p>
      ))}

      <label className="scorer-checkbox scorer-confirm" htmlFor="scorer-final-confirm">
        <input
          id="scorer-final-confirm"
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        Final score confirmed with both teams
      </label>

      <div className="scorer-complete-actions">
        <button
          type="button"
          className="scorer-submit"
          onClick={onSubmit}
          disabled={submitting || !confirmed || blockers.length > 0}
        >
          {submitting ? 'Sending…' : 'Submit result'}
        </button>
        <button type="button" className="scorer-action" onClick={onReview}>
          Full scoresheet review
        </button>
        <button type="button" className="scorer-action" onClick={onDownload}>
          Download QBJ backup
        </button>
      </div>
    </div>
  );
}
