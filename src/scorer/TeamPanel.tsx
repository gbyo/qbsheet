/**
 * One team: name, score, and a row per active player carrying that player's scoring buttons.
 *
 * The buttons live on the player row rather than in a shared strip because that is what makes a
 * tossup one click. "Sarah, ten points" is one target, not a player followed by a value; the second
 * step is where a scorekeeper falls behind a reader.
 *
 * The values come from the format. There is no +15 / +10 / -5 anywhere in this file.
 *
 * # The numbers down the left
 *
 * A scoresheet gives each player a column, and a scorekeeper who has been watching one all morning
 * knows the person in the third seat by the number rather than by reading the name. The number here
 * is the same thing: the player's position on the floor, in whatever order the room has arranged
 * them (see `PlayerSeating`). It is positional and not an identity — a substitute takes the seat of
 * the player they came on for — which is what keeps the third column the third column all game.
 */
import { CSSProperties, useEffect, useRef, useState } from 'react';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IDerivedTeam } from '../scoring/deriveGame';
import { orderBySeating } from './PlayerSeating';

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
  timeoutsUsed?: number;
  onBuzz: (playerName: string, answerType: IScorekeeperAnswerType) => void;
  /** An answer worth nothing that still spends this team's chance at the tossup. */
  onWrongNoPenalty: (playerName: string) => void;
  /**
   * The players on the floor, in the order the room wants to see them.
   *
   * A view preference and nothing more; the team's own `activePlayers` decides who is playing. See
   * `PlayerSeating`.
   */
  seatOrder?: readonly string[];
  /**
   * One-for-one substitution from the player's own row.
   *
   * A substitution is the most frequent thing that happens to a lineup, and routing every one of
   * them through the Players dialog meant leaving the scoresheet, finding the right team, finding the
   * right row, and coming back — for a change the reader announces in four words. The row already
   * knows who is coming off, so the only question left is who comes on, and it is asked here.
   *
   * The dialog is not going anywhere: adding somebody to the roster, reordering seats and anything
   * that is not one-for-one still live there. Absent means the host offers no quick path, and no Sub
   * button is drawn.
   */
  onSubstitute?: (outgoing: string, incoming: string) => void;
  /** Who is available to come on. Empty means everybody on the roster is already playing. */
  benchPlayers?: readonly string[];
  /** False when the procedure does not allow a lineup change at this point in the game. */
  substitutionAllowed?: boolean;
  /** Why not, when it is not allowed. Shown in place of the bench list. */
  substitutionBlockedReason?: string;
  /** The question the change takes effect from, so the row can say so before it is written. */
  substitutionQuestionNumber?: number;
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
  const {
    format,
    team,
    scoringEnabled,
    eligible,
    negsAvailable,
    timeoutsUsed,
    onBuzz,
    onWrongNoPenalty,
    seatOrder,
    onSubstitute,
    benchPlayers = [],
    substitutionAllowed = true,
    substitutionBlockedReason,
    substitutionQuestionNumber,
  } = props;
  /** Which row, if any, has its replacement list open. One at a time, by name. */
  const [substituting, setSubstituting] = useState<string | null>(null);
  const active = orderBySeating(
    team.players.filter((player) => team.activePlayers.includes(player.name)),
    seatOrder ?? [],
    (player) => player.name,
  );
  /*
   * The rulings actually available to this team on this tossup. Negs disappear once anybody has
   * answered, because from that point the question has been read out and nobody can be penalized on
   * it — which is exactly why the zero-point button beside them exists.
   */
  const answerTypes = negsAvailable ? format.answerTypes : format.answerTypes.filter((type) => !type.isNeg);
  // One extra column for the zero, so the values stay in the same place down every row.
  const columns = answerTypes.length + 1;
  const previousPoints = useRef(team.points);
  const hasRendered = useRef(false);
  const scoreDirection = team.points < previousPoints.current ? 'is-down' : 'is-up';

  useEffect(() => {
    previousPoints.current = team.points;
    hasRendered.current = true;
  }, [team.points]);

  // The row the picker belongs to can leave the floor — by the substitution itself, or by a change
  // made in the Players dialog — and an open picker attached to nobody must not stay on screen.
  useEffect(() => {
    if (substituting !== null && !team.activePlayers.includes(substituting)) setSubstituting(null);
  }, [substituting, team.activePlayers]);

  return (
    <section className="scorer-team" aria-label={team.name}>
      <header className="scorer-team-head">
        <h2 className="scorer-team-name">{team.name}</h2>
        <p className="scorer-team-score" aria-label={`${team.name} score`}>
          <span
            key={team.points}
            className={`scorer-team-score-value${hasRendered.current ? ` ${scoreDirection}` : ''}`}
          >
            {team.points}
          </span>
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
        {active.map((player, seat) => (
          <li key={player.name} className="scorer-player">
            {/* The seat, not an identity. Hidden from assistive technology, which reads the name. */}
            <span className="scorer-player-seat" aria-hidden="true">
              {seat + 1}
            </span>
            <span className="scorer-player-name">{player.name}</span>
            {/*
              Between the name and the rulings, and deliberately the quietest thing on the line. It
              sits beside the buttons that get pressed while a reader is talking, and a fifth target
              of the same weight would be a fifth thing to hit by mistake mid-tossup. It stays out of
              the ruling block so that block keeps its own alignment down the sheet.
            */}
            {onSubstitute && (
              <button
                type="button"
                className={substituting === player.name ? 'scorer-sub-action is-open' : 'scorer-sub-action'}
                aria-expanded={substituting === player.name}
                aria-label={`Substitute for ${player.name}`}
                disabled={!substitutionAllowed}
                title={substitutionAllowed ? `Substitute for ${player.name}` : substitutionBlockedReason}
                onClick={() => setSubstituting((current) => (current === player.name ? null : player.name))}
              >
                Sub
              </button>
            )}
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
            {/*
              The second half of the sentence, and the only question the row cannot answer for
              itself. Names rather than a select: a bench of one or two is the normal case, and
              choosing from a list of names is one press where a dropdown is three.
            */}
            {onSubstitute && substituting === player.name && (
              <div className="scorer-sub-picker" aria-label={`Replace ${player.name}`}>
                <p className="scorer-sub-picker-title">
                  Who comes on for {player.name}?
                  {substitutionQuestionNumber !== undefined && (
                    <span> Effective starting Tossup {substitutionQuestionNumber}.</span>
                  )}
                </p>
                {benchPlayers.length === 0 ? (
                  <p className="scorer-sub-picker-empty">
                    Everybody on this roster is already playing. Use Players to add somebody first.
                  </p>
                ) : (
                  <div className="scorer-sub-picker-choices">
                    {benchPlayers.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="scorer-choice"
                        onClick={() => {
                          setSubstituting(null);
                          onSubstitute(player.name, name);
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
                <button type="button" className="scorer-text-action" onClick={() => setSubstituting(null)}>
                  Cancel
                </button>
              </div>
            )}
          </li>
        ))}
        {active.length === 0 && <li className="scorer-empty-roster">Nobody is on the floor for this team.</li>}
      </ul>
    </section>
  );
}
