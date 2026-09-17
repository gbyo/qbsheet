/**
 * Every player's line, as a scoresheet has it.
 *
 * Lifted out of `PreSubmitReview` unchanged so the completion screen can show the same table
 * without a second opinion about what a player's line says. It renders `IDerivedTeam` and
 * `IScorekeeperFormat` and calculates nothing: the columns are the format's answer types, in the
 * format's order, so a game with no neg has no neg column and a 20/15/10/-5 game has four.
 */
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IDerivedTeam } from '../scoring/deriveGame';
import { signedAnswerValue } from '../scoring/statsSheet';

/** "+15" / "-5". */
export const signed = signedAnswerValue;

export default function TeamStatLines(props: { format: IScorekeeperFormat; team: IDerivedTeam }) {
  const { format, team } = props;
  const played = team.players.filter((player) => player.tossupsHeard > 0 || player.answerCounts.size > 0);

  return (
    <section className="scorer-check-team" aria-label={`${team.name} players`}>
      <h3 className="scorer-check-team-name">
        {team.name} <span className="scorer-check-team-score">{team.points}</span>
      </h3>
      <table className="scorer-check-table">
        <caption className="visually-hidden">{team.name} player statistics</caption>
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
