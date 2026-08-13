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
import { CSSProperties, useEffect, useId, useRef, useState } from 'react';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IDerivedTeam } from '../scoring/deriveGame';
import { orderBySeating } from './PlayerSeating';
import { lineupMoveMs, lineupSettleMs } from './LineupMotion';
import { availableAnswerTypes, powerCorrect } from './tossupRulings';

/**
 * How long the seat a substitution landed in keeps its emphasis.
 *
 * The travel and the dwell from the lineup work, reused rather than re-chosen: this is the same
 * event as a row crossing between Playing and Bench, seen from the scoresheet instead of from the
 * editor, and two different durations for one thing would read as two different things happening.
 */
export const seatChangeEmphasisMs = lineupMoveMs + lineupSettleMs;

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
  /** Total timeout allowance, when the tournament tracks it. */
  timeoutsPerTeam?: number;
  /** Returns true only when the scoring engine committed the ruling. */
  onBuzz: (playerName: string, answerType: IScorekeeperAnswerType) => boolean;
  /** An answer worth nothing that still spends this team's chance at the tossup. */
  onWrongNoPenalty: (playerName: string) => boolean;
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
   *
   * The visual seat is deliberately *not* reported. It is a fact about this device's row order (see
   * `PlayerSeating`) and the two things a host does with a substitution both have better sources for
   * it: the event stores the lineup in scoring-history order, and the seating store moves the
   * incoming player into the outgoing one's place on its own. A seat handed up from here would be
   * an invitation to write one of those out of the other.
   */
  onSubstitute?: (outgoing: string, incoming: string) => void;
  /** Who is available to come on. Empty means everybody on the roster is already playing. */
  benchPlayers?: readonly string[];
  /**
   * A seat to flash, briefly, because a ruling was just recorded there from the keyboard.
   *
   * Confirmation for an action with no pointer behind it: a scorekeeper who pressed `3` then `P` has no
   * cursor sitting on the button they hit and no way to know they hit the right one. Zero-based, and
   * only ever set for a keystroke — a click needs no echo, because the finger was already there.
   */
  flashSeat?: number;
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

function answerButtonClass(format: IScorekeeperFormat, answerType: IScorekeeperAnswerType): string {
  if (answerType.isNeg) return 'scorer-answer scorer-answer-neg';
  // `isPower` is a value-derived compatibility flag (`value > 10`), not proof that this format
  // offers a separate power ruling. Style only the structurally selected highest positive tier.
  if (powerCorrect(format)?.index === answerType.index) {
    return 'scorer-answer scorer-answer-power';
  }
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
    timeoutsPerTeam,
    onBuzz,
    onWrongNoPenalty,
    seatOrder,
    onSubstitute,
    flashSeat,
    benchPlayers = [],
    substitutionAllowed = true,
    substitutionBlockedReason,
    substitutionQuestionNumber,
  } = props;
  /** Which row, if any, has its replacement list open. One at a time, by name. */
  const [substituting, setSubstituting] = useState<string | null>(null);
  const substitutionTrigger = useRef<HTMLButtonElement | null>(null);
  const firstBenchChoice = useRef<HTMLButtonElement | null>(null);
  const substitutionReasonId = useId();
  /**
   * The seat a substitution has just landed in.
   *
   * A seat and not a player, because the seat is the thing being asserted. "Sarah → Olivia" is a
   * change of person and explicitly not a change of position: the row keeps its number, the answer
   * buttons under it do not move, and the only thing that happens is that a different name arrives
   * in it. Emphasising the row says that; animating the row would say the opposite.
   */
  /*
   * Held as a fresh object rather than as a bare number so that two substitutions into the same seat
   * are two events. A number set to the value it already has is not a state change, and the second
   * one would inherit the first one's remaining time instead of starting its own.
   */
  const [landed, setLanded] = useState<{ seat: number } | null>(null);
  /**
   * Pointer/touch confirmation for the ruling the engine actually accepted.
   *
   * Keyboard scoring deliberately does not enter this path. Its established `is-keyed` row wash is
   * the row acknowledgement, avoiding two nearly identical flashes on the same keystroke.
   */
  const [recorded, setRecorded] = useState<
    { playerName: string; answerTypeIndex: number | 'zero'; isNeg: boolean; token: number } | null
  >(null);
  const recordedSequence = useRef(0);
  useEffect(() => {
    if (substituting !== null) firstBenchChoice.current?.focus();
  }, [substituting]);
  useEffect(() => {
    if (substituting === null) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat) return;
      event.preventDefault();
      setSubstituting(null);
      substitutionTrigger.current?.focus();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [substituting]);
  useEffect(() => {
    if (landed === null) return undefined;
    const timer = window.setTimeout(() => setLanded(null), seatChangeEmphasisMs);
    return () => window.clearTimeout(timer);
  }, [landed]);
  useEffect(() => {
    if (recorded === null) return undefined;
    const timer = window.setTimeout(() => setRecorded(null), 220);
    return () => window.clearTimeout(timer);
  }, [recorded]);

  const acknowledgeRuling = (playerName: string, answerTypeIndex: number | 'zero', isNeg: boolean) => {
    recordedSequence.current += 1;
    setRecorded({ playerName, answerTypeIndex, isNeg, token: recordedSequence.current });
  };
  const active = orderBySeating(
    team.players.filter((player) => team.activePlayers.includes(player.name)),
    seatOrder ?? [],
    (player) => player.name,
  );
  /*
   * The rulings actually available to this team on this tossup. Negs disappear once anybody has
   * answered, because from that point the question has been read out and nobody can be penalized on
   * it — which is exactly why the zero-point button beside them exists.
   *
   * Derived in `tossupRulings` rather than here, because the keyboard layer binds to the same rule and
   * two copies of "is a neg legal right now" would disagree the first time either was corrected.
   */
  const answerTypes = availableAnswerTypes(format, negsAvailable);
  // One extra column for the zero, so the values stay in the same place down every row.
  const columns = answerTypes.length + 1;
  /*
   * Which way the score last moved, recorded when it moves.
   *
   * The direction has to be readable while rendering, and a ref read during render is the one place
   * React will not promise a value. Recording it as state at the moment the points change says the
   * same thing without the promise: `started` keeps the first paint still, because a score that has
   * not moved yet has no direction to roll in.
   */
  const [scoreMotion, setScoreMotion] = useState({ points: team.points, direction: 'is-up', started: false });
  if (scoreMotion.points !== team.points) {
    setScoreMotion({
      points: team.points,
      direction: team.points < scoreMotion.points ? 'is-down' : 'is-up',
      started: true,
    });
  }

  // The row the picker belongs to can leave the floor — by the substitution itself, or by a change
  // made in the Players dialog — and an open picker attached to nobody must not stay on screen.
  // Closed as the render that would have drawn it happens, so it is never painted orphaned.
  if (substituting !== null && !team.activePlayers.includes(substituting)) setSubstituting(null);

  return (
    <section className="scorer-team" aria-label={team.name}>
      <header className="scorer-team-head">
        <h2 className="scorer-team-name" title={team.name}>
          {team.name}
        </h2>
        <p className="scorer-team-score" aria-label={`${team.name} score`}>
          <span
            key={team.points}
            className={`scorer-team-score-value${scoreMotion.started ? ` ${scoreMotion.direction}` : ''}`}
          >
            {team.points}
          </span>
        </p>
      </header>
      {timeoutsUsed !== undefined && timeoutsPerTeam !== undefined && timeoutsPerTeam > 0 && (
        <p className="scorer-team-timeout">
          {Math.max(0, timeoutsPerTeam - timeoutsUsed)} remaining
          {timeoutsUsed > 0 && ` (${timeoutsUsed} used)`}
        </p>
      )}
      {onSubstitute && !substitutionAllowed && (
        <p id={substitutionReasonId} className="scorer-substitution-note">
          {substitutionBlockedReason ?? 'Lineup changes are not available in this phase.'}
        </p>
      )}

      {/*
       * The answer columns are set once on the roster rather than per row, so every player's +15
       * sits directly under the last one. A scorekeeper going for the middle button on the third
       * row should not have to look: on a real scoresheet that column is in the same place all the
       * way down, and ragged flex rows are what stop it being.
       */}
      <ul className="scorer-roster" style={{ '--scorer-answer-columns': columns } as CSSProperties}>
        {active.map((player, seat) => (
          <li
            key={player.name}
            className={[
              'scorer-player',
              seat === flashSeat ? 'is-keyed' : '',
              seat === landed?.seat ? 'is-substituted' : '',
              recorded?.playerName === player.name ? 'is-ruling-recorded' : '',
              recorded?.playerName === player.name && recorded.isNeg ? 'is-neg-recorded' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {/* The seat, not an identity. Hidden from assistive technology, which reads the name. */}
            <span className="scorer-player-seat" aria-hidden="true">
              {seat + 1}
            </span>
            {/* Keyed by the name so a substitution replaces the element rather than editing its text,
                which is what lets the arriving name have an entrance and the seat around it not. */}
            <span key={player.name} className="scorer-player-name" title={player.name}>
              {player.name}
            </span>
            {recorded?.playerName === player.name && (
              <span className="visually-hidden" role="status">
                {player.name}{' '}
                {recorded.answerTypeIndex === 'zero'
                  ? '0, wrong answer with no penalty'
                  : answerTypes.find((answerType) => answerType.index === recorded.answerTypeIndex)?.label ??
                    'ruling'}{' '}
                recorded.
              </span>
            )}
            {/*
              Against the name, because that is whose substitution it is — not against the rulings,
              where it spent its time being a fifth target beside +10 for a thumb to find while a
              reader was still talking. Distance from that block is the safety here.

              The swap arrows rather than the word, because the word was repeated down every row of
              both teams — eight copies of "Sub" on a full sheet, competing for the eye with the one
              thing on the line that has to be read at a glance, which is the name. The accessible
              name and the tooltip still spell it out for anyone the glyph does not reach.
            */}
            {onSubstitute && (
              <button
                type="button"
                className={substituting === player.name ? 'scorer-sub-action is-open' : 'scorer-sub-action'}
                aria-expanded={substituting === player.name}
                aria-label={`Substitute for ${player.name}`}
                disabled={!substitutionAllowed}
                aria-describedby={!substitutionAllowed ? substitutionReasonId : undefined}
                title={substitutionAllowed ? `Substitute for ${player.name}` : substitutionBlockedReason}
                onClick={(event) => {
                  substitutionTrigger.current = event.currentTarget;
                  setSubstituting((current) => (current === player.name ? null : player.name));
                }}
              >
                &#8644;
              </button>
            )}
            <span className="scorer-answers">
              {answerTypes.map((answerType) => (
                <button
                  key={answerType.index}
                  type="button"
                  className={`${answerButtonClass(format, answerType)}${
                    recorded?.playerName === player.name && recorded.answerTypeIndex === answerType.index
                      ? ' is-recorded'
                      : ''
                  }`}
                  disabled={!scoringEnabled || !eligible}
                  onClick={() => {
                    if (onBuzz(player.name, answerType)) acknowledgeRuling(player.name, answerType.index, answerType.isNeg);
                  }}
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
                className={`scorer-answer scorer-answer-zero${
                  recorded?.playerName === player.name && recorded.answerTypeIndex === 'zero' ? ' is-recorded' : ''
                }`}
                disabled={!scoringEnabled || !eligible}
                onClick={() => {
                  if (onWrongNoPenalty(player.name)) acknowledgeRuling(player.name, 'zero', false);
                }}
                aria-label={`${player.name} ${negsAvailable ? '0 after readout' : '0'} wrong, no penalty`}
                title={negsAvailable ? 'Wrong answer after readout, no penalty' : 'Wrong answer, no penalty'}
              >
                0
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
                        ref={benchPlayers[0] === name ? firstBenchChoice : undefined}
                        onClick={() => {
                          setSubstituting(null);
                          // The seat this row is in, before the lineup changes and while the row it
                          // came from is still the row the scorekeeper is looking at. Kept here
                          // rather than reported upward: the emphasis is the only thing that wants
                          // it, and it is drawn here.
                          setLanded({ seat });
                          onSubstitute(player.name, name);
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="scorer-text-action"
                  onClick={() => {
                    setSubstituting(null);
                    substitutionTrigger.current?.focus();
                  }}
                >
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
