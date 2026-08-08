/**
 * One team: name, score, and a row per active player carrying that player's scoring buttons.
 *
 * The buttons live on the player row rather than in a shared strip because that is what makes a
 * tossup one click. "Sarah, ten points" is one target, not a player followed by a value; the second
 * step is where a scorekeeper falls behind a reader.
 *
 * The values come from the format. There is no +15 / +10 / -5 anywhere in this file.
 */
import { CSSProperties } from 'react';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IDerivedTeam } from '../scoring/deriveGame';

export interface ITeamPanelProps {
  format: IScorekeeperFormat;
  team: IDerivedTeam;
  /** False while the other team is on a bonus, or the game is over. */
  scoringEnabled: boolean;
  /** False when this team has already answered on the current tossup. */
  eligible: boolean;
  /**
   * False once anybody has answered this tossup.
   *
   * A team answering second has heard the whole question, and a team that has heard the whole
   * question cannot be penalized for missing it. Leaving −5 on screen for them is an invitation to
   * record a neg that the rules do not have.
   */
  negsAvailable: boolean;
  /** Whether a timeout has been used, when the tournament tracks them. */
  // eslint-disable-next-line react/require-default-props
  timeoutsUsed?: number;
  onBuzz: (playerName: string, answerType: IScorekeeperAnswerType) => void;
  /** An answer worth nothing that still spends this team's chance at the tossup. */
  onWrongNoPenalty: (playerName: string) => void;
}

/** "+15" / "-5". The sign is the fastest thing to read, so it is always shown. */
function buttonLabel(answerType: IScorekeeperAnswerType): string {
  // A format that gave this type a real label means it; only fall back to the number.
  if (answerType.shortLabel !== String(answerType.value)) return answerType.shortLabel;
  return answerType.value > 0 ? `+${answerType.value}` : String(answerType.value);
}

function answerButtonClass(answerType: IScorekeeperAnswerType): string {
  if (answerType.isNeg) return 'scorer-answer scorer-answer-neg';
  if (answerType.isPower) return 'scorer-answer scorer-answer-power';
  return 'scorer-answer';
}

export default function TeamPanel(props: ITeamPanelProps) {
  const { format, team, scoringEnabled, eligible, negsAvailable, timeoutsUsed, onBuzz, onWrongNoPenalty } = props;
  const active = team.players.filter((player) => team.activePlayers.includes(player.name));
  /*
   * The rulings actually available to this team on this tossup. Negs disappear once anybody has
   * answered, because from that point the question has been read out and nobody can be penalized on
   * it — which is exactly why the zero-point button beside them exists.
   */
  const answerTypes = negsAvailable ? format.answerTypes : format.answerTypes.filter((type) => !type.isNeg);
  // One extra column for the zero, so the values stay in the same place down every row.
  const columns = answerTypes.length + 1;

  return (
    <section className="scorer-team" aria-label={team.name}>
      <header className="scorer-team-head">
        <h2 className="scorer-team-name">{team.name}</h2>
        <p className="scorer-team-score" aria-label={`${team.name} score`}>
          {team.points}
        </p>
      </header>
      {timeoutsUsed !== undefined && timeoutsUsed > 0 && (
        <p className="scorer-team-timeout">{timeoutsUsed === 1 ? 'Timeout used' : `${timeoutsUsed} timeouts used`}</p>
      )}

      {/*
       * The answer columns are set once on the roster rather than per row, so every player's +15
       * sits directly under the last one. A scorekeeper going for the middle button on the third
       * row should not have to look: on a real scoresheet that column is in the same place all the
       * way down, and ragged flex rows are what stop it being.
       */}
      <ul className="scorer-roster" style={{ '--scorer-answer-columns': columns } as CSSProperties}>
        {active.map((player) => (
          <li key={player.name} className="scorer-player">
            <span className="scorer-player-name">{player.name}</span>
            <span className="scorer-answers">
              {answerTypes.map((answerType) => (
                <button
                  key={answerType.index}
                  type="button"
                  className={answerButtonClass(answerType)}
                  disabled={!scoringEnabled || !eligible}
                  onClick={() => onBuzz(player.name, answerType)}
                  aria-label={`${player.name} ${answerType.label}`}
                >
                  {buttonLabel(answerType)}
                </button>
              ))}
              {/*
                An answer that was simply wrong. It ends this team's chance at the tossup and adds
                nothing to anybody's score or answer counts, which is what makes it different from
                both a neg and No buzz.
              */}
              <button
                type="button"
                className="scorer-answer scorer-answer-zero"
                disabled={!scoringEnabled || !eligible}
                onClick={() => onWrongNoPenalty(player.name)}
                aria-label={`${player.name} ${negsAvailable ? '0 after readout' : '0'} wrong, no penalty`}
                title={negsAvailable ? 'Wrong answer after readout, no penalty' : 'Wrong answer, no penalty'}
              >
                {negsAvailable ? '0 after readout' : '0'}
              </button>
            </span>
          </li>
        ))}
        {active.length === 0 && <li className="scorer-empty-roster">Nobody is on the floor for this team.</li>}
      </ul>
    </section>
  );
}
