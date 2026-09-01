/**
 * The bonus, asked for the way the moderator reads one.
 *
 * # Which question the prompt opens on
 *
 * Two different bonuses are being scored under one name, and they want opposite interfaces.
 *
 * Where only the controlling team can score, the scorekeeper hears one number and the totals row is
 * the whole interaction: 0 / 10 / 20 / 30, one press, done. Enumerating parts there would be three
 * presses for information the room already summed.
 *
 * Where bonuses bounce back, the scorekeeper hears no number at all. They hear a sequence — this
 * team got that part, the other team got the next one on the bounce, nobody got the last — and a
 * totals row asks them to do the arithmetic and then remember which half of it belongs to whom
 * while the next tossup is being read. So a bouncing bonus opens on its parts, which is the thing
 * that was actually said, and QBSheet does the adding. `partEntryIsDefault` is that rule.
 *
 * An irregular bonus has neither: its parts need not be worth the same and there is no fixed number
 * of them, so nothing here can enumerate either totals or parts, and the only honest control is a
 * number field per team.
 *
 * # One panel, never a sequence of screens
 *
 * Every part is on screen the whole time, in a fixed position, with the one being asked about
 * emphasised. Nothing is disabled: reaching ahead and going back over an earlier part are both
 * ordinary. The bonus commits itself the moment the last part has an answer, because a Record
 * button after three explicit choices is a fourth press that confirms nothing.
 *
 * What is recorded is exactly what the old part route recorded — one `bonus` event carrying
 * `parts`. There is no such thing as a per-part event, and undo still takes the whole bonus.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IBonusPartResult } from '../scoring/ScoreEvents';
import {
  BonusPartOutcome,
  bonusOutcomeTotals,
  bonusPartForOutcome,
  bonusScoreProblem,
  bonusTotalProblem,
  bouncebackOptions,
  livePartCount,
  partEntryIsDefault,
  regularBonusTotals,
} from './bonusOptions';
import {
  BonusKeyboardStage,
  bonusOptionForCode,
  bonusPartChoices,
  bonusPartOutcomeForCode,
  keystrokeBelongsToControl,
} from './KeyboardScoring';
import MotionNumber, { partAcknowledgementMotionMs } from './ScoringMotion';

export interface IBonusPromptProps {
  format: IScorekeeperFormat;
  /** The team that converted the tossup. */
  controllingTeamName: string;
  opponentName: string;
  questionNumber: number;
  onRecord: (controlledPoints: number, bouncebackPoints?: number) => void;
  /** Record the bonus part by part instead of as a total. Still one bonus event. */
  onRecordParts: (parts: IBonusPartResult[]) => void;
  /**
   * Whether the digit shortcuts are live, and what the legend should say they do.
   *
   * The shortcut lives here rather than in the scorer's own listener because the choices on screen are
   * this component's state — which part is being asked about, or what is left to bounce back. Handling
   * it anywhere else would mean lifting that state so a keyboard layer could read it, which is a bad
   * trade. `onStageChange` reports upward so the persistent map can change with the screen; every
   * meaning in it is built from the same values the buttons carry.
   */
  keyboardEnabled?: boolean;
  onStageChange?: (stage: BonusKeyboardStage | null) => void;
}

/**
 * Bind the digits to whatever the bonus is currently asking.
 *
 * One listener for both stages, dispatching on the stage's own kind, so a keystroke cannot record
 * something the buttons on screen could not. Attached once and reading through a ref: the bonus
 * re-renders on every part, and rebuilding the listener each time would be free to miss a keystroke
 * between renders.
 */
function useBonusKeys(
  stage: BonusKeyboardStage | null,
  handlers: { onTotal: (points: number) => void; onPart: (outcome: BonusPartOutcome) => void },
  enabled: boolean,
): void {
  const latest = useRef({ stage, handlers, enabled });
  useLayoutEffect(() => {
    latest.current = { stage, handlers, enabled };
  }, [stage, handlers, enabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current;
      if (!current.enabled || current.stage === null || event.repeat) return;
      // The irregular-bonus path puts number fields on screen, and their digits are their own. This is
      // the check that keeps a typed total from also being a shortcut.
      if (keystrokeBelongsToControl(event)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

      if (current.stage.kind === 'totals') {
        const points = bonusOptionForCode(event.code, current.stage.options);
        if (points === null) return;
        event.preventDefault();
        current.handlers.onTotal(points);
        return;
      }

      // Every part answered. The digits address nothing — there is no current part — and the key
      // that finishes the bonus is Enter on the focused Record button, which needs nothing here.
      if (current.stage.kind === 'record') return;

      const outcome = bonusPartOutcomeForCode(event.code, current.stage.choices);
      if (outcome === null) return;
      event.preventDefault();
      current.handlers.onPart(outcome);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** A press that has just landed, kept only long enough for the acknowledgement to play. */
interface IPartAcknowledgement {
  index: number;
  outcome: BonusPartOutcome;
  token: number;
}

export default function BonusPrompt(props: IBonusPromptProps) {
  const {
    format,
    controllingTeamName,
    opponentName,
    questionNumber,
    onRecord,
    onRecordParts,
    keyboardEnabled = false,
    onStageChange,
  } = props;

  const bouncesBack = format.bonus.bounceBack;
  const perPart = format.bonus.pointsPerPart ?? 0;
  const totals = useMemo(() => regularBonusTotals(format.bonus), [format.bonus]);
  const partCount = useMemo(() => livePartCount(format.bonus), [format.bonus]);

  /*
   * Which entry this bonus opened in, and the scorekeeper's answer if they changed it.
   *
   * Not a preference and not a mode: the component is keyed on the question, so every new bonus
   * starts on whichever entry its format calls for. A room that wants totals for one reconstructed
   * bonus is not thereby asking for totals for the rest of the round.
   */
  const [byParts, setByParts] = useState(() => partEntryIsDefault(format.bonus));
  const [outcomes, setOutcomes] = useState<Array<BonusPartOutcome | null>>(() =>
    Array.from({ length: partCount ?? 0 }, () => null),
  );
  const [controlled, setControlled] = useState<number | null>(null);
  const [typedControlled, setTypedControlled] = useState('');
  const [typedBounceback, setTypedBounceback] = useState('');
  const [acknowledgement, setAcknowledgement] = useState<IPartAcknowledgement | null>(null);
  const acknowledgementSequence = useRef(0);
  const recordRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!acknowledgement) return undefined;
    const token = acknowledgement.token;
    const timer = window.setTimeout(
      () => setAcknowledgement((current) => (current?.token === token ? null : current)),
      partAcknowledgementMotionMs,
    );
    return () => window.clearTimeout(timer);
  }, [acknowledgement]);

  /**
   * The part being asked about: the first one nobody has answered.
   *
   * Derived rather than stored, which is what makes going back to correct part 1 harmless. Answering
   * an already-answered part creates no new gap, so the emphasis stays where the bonus actually is
   * instead of walking backwards to the row that was just touched.
   */
  const activeIndex = outcomes.findIndex((outcome) => outcome === null);
  const answeredCount = outcomes.filter((outcome) => outcome !== null).length;
  const runningTotals = bonusOutcomeTotals(format.bonus, outcomes);

  /** Answer one part. Answering is not recording; see `recordParts`. */
  const choosePart = (index: number, outcome: BonusPartOutcome) => {
    setOutcomes((current) => current.map((existing, position) => (position === index ? outcome : existing)));
    acknowledgementSequence.current += 1;
    setAcknowledgement({ index, outcome, token: acknowledgementSequence.current });
  };

  /**
   * Write the bonus.
   *
   * A deliberate act, and the only one on this panel that changes the game. Committing on the last
   * part press instead read as an ambush: three presses that did nothing and a fourth that silently
   * ended the bonus and moved the room on, with no moment in between to look at what had been
   * entered. A bonus is worth up to thirty points and the panel is worked at speed — the press that
   * says "yes, that" should be a press that says only that.
   */
  const recordParts = () => {
    if (outcomes.some((entry) => entry === null)) return;
    onRecordParts(outcomes.map((entry) => bonusPartForOutcome(format.bonus, entry as BonusPartOutcome)));
  };

  /** The controlling team's total. Without bouncebacks that is the whole bonus. */
  const chooseControlledTotal = (points: number) => {
    if (!bouncesBack) {
      onRecord(points);
      return;
    }
    /*
     * A bonus the controlling team swept leaves nothing to bounce, so there is no second answer to
     * give. Asking for a press on a `0` that is the only button left would be asking the scorekeeper
     * to confirm arithmetic QBSheet has already done.
     */
    if (format.bonus.maximumScore - points <= 0) {
      onRecord(points, 0);
      return;
    }
    setControlled(points);
  };

  /*
   * What the opponent can still take, bounded by what the controlling team left.
   *
   * Always enumerable here, and deliberately so: this row is only rendered for a bonus that had a
   * row of totals to begin with, and a bonus whose totals fit on screen cannot have a bounceback
   * range that does not. The typed fallback belongs to the irregular path below, which is the only
   * bonus that genuinely has nothing to enumerate.
   */
  const opponentOptions = useMemo(
    () => (bouncesBack ? bouncebackOptions(format.bonus, controlled ?? 0) : null),
    [bouncesBack, format.bonus, controlled],
  );

  const controlledNumber = typedControlled === '' ? null : Number(typedControlled);
  const bouncebackNumber = typedBounceback === '' ? 0 : Number(typedBounceback);
  /*
   * Both halves of a typed bonus, checked together by the helpers the correction editor uses, so
   * the same figures are refused with the same sentence wherever a room enters them.
   */
  const typedProblem =
    controlledNumber === null
      ? null
      : bouncesBack
        ? bonusScoreProblem(format.bonus, controlledNumber, bouncebackNumber)
        : bonusTotalProblem(format.bonus, controlledNumber);

  /**
   * What the keyboard is aimed at.
   *
   * Part entry gets a stage of its own rather than being squeezed into the totals shape. A part is
   * not a number of points and the digits over it do not count anything; saying so in the type is
   * what lets the legend name the actual teams instead of listing values.
   */
  const stage = useMemo<BonusKeyboardStage | null>(() => {
    if (byParts && partCount !== null) {
      if (activeIndex === -1) {
        return {
          kind: 'record',
          title: 'Bonus · every part answered',
          summary: bouncesBack
            ? `${controllingTeamName} ${runningTotals.controlled} · ${opponentName} ${runningTotals.bounceback}`
            : `${controllingTeamName} ${runningTotals.controlled}`,
        };
      }
      return {
        kind: 'part',
        title: `Bonus part ${activeIndex + 1} of ${partCount}`,
        partNumber: activeIndex + 1,
        partCount,
        controllingTeamName,
        opponentName,
        choices: bonusPartChoices({
          partNumber: activeIndex + 1,
          controllingTeamName,
          opponentName,
          bounceBack: bouncesBack,
        }),
      };
    }
    // The irregular path is number fields, which own their own digits and report no stage.
    if (totals === null) return null;
    if (controlled !== null && opponentOptions !== null) {
      return {
        kind: 'totals',
        title: `${opponentName}, from missed parts`,
        options: opponentOptions,
        cancellable: true,
      };
    }
    return { kind: 'totals', title: `${controllingTeamName} bonus`, options: totals, cancellable: false };
  }, [
    byParts,
    partCount,
    activeIndex,
    controllingTeamName,
    opponentName,
    bouncesBack,
    totals,
    controlled,
    opponentOptions,
    runningTotals.controlled,
    runningTotals.bounceback,
  ]);

  useEffect(() => {
    onStageChange?.(stage);
  }, [stage, onStageChange]);

  // Cleared on the way out, so a bonus that finishes does not leave the map advertising its digits.
  useEffect(() => () => onStageChange?.(null), [onStageChange]);

  const keyHandlers = useMemo(
    () => ({
      onTotal: (points: number) =>
        controlled !== null ? onRecord(controlled, points) : chooseControlledTotal(points),
      onPart: (outcome: BonusPartOutcome) => {
        if (activeIndex !== -1) choosePart(activeIndex, outcome);
      },
    }),
    // The handlers close over the current draft, which is the point: they must do what the buttons
    // beside them would do at this moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controlled, activeIndex, outcomes, onRecord, format.bonus],
  );
  useBonusKeys(stage, keyHandlers, keyboardEnabled);

  /**
   * Take the focus to Record the moment the breakdown is finished.
   *
   * This is what makes Enter finish a bonus without a shortcut being invented for it: the button is
   * focused, so Enter is that button, whether or not the keyboard layer is switched on. Only on the
   * transition into complete, so correcting an answered part afterwards does not snatch the focus
   * back off whatever the scorekeeper has moved to.
   */
  const partsComplete = byParts && partCount !== null && activeIndex === -1;
  const wasComplete = useRef(false);
  useEffect(() => {
    if (partsComplete && !wasComplete.current) recordRef.current?.focus();
    wasComplete.current = partsComplete;
  }, [partsComplete]);

  /**
   * Escape releases a chosen controlling total without recording anything.
   *
   * Only in totals entry, and only once a total has been chosen: nothing is written until both halves
   * are known, so this is a genuine cancel. There is deliberately no Escape over part entry — parts
   * are answers a scorekeeper has already given, and a key that quietly erased three of them would be
   * the one destructive shortcut on this screen.
   */
  useEffect(() => {
    if (!keyboardEnabled || byParts || controlled === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat) return;
      if (keystrokeBelongsToControl(event)) return;
      event.preventDefault();
      setControlled(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [keyboardEnabled, byParts, controlled]);

  if (byParts && partCount !== null) {
    const complete = activeIndex === -1;
    /** Three cues on a chosen outcome — fill, weight and a tick — so it does not rest on colour. */
    const choiceClass = (index: number, outcome: BonusPartOutcome, selected: boolean) =>
      [
        'scorer-choice',
        selected ? 'is-selected' : '',
        acknowledgement?.index === index && acknowledgement.outcome === outcome ? 'is-part-recorded' : '',
      ]
        .filter(Boolean)
        .join(' ');

    /**
     * One outcome for one part.
     *
     * The button says whose points these are, on every row, at every width. It used to say `+10`
     * and leave a column heading three rows above it to explain which `+10` this was — which meant
     * the answer to "who is getting the bounceback?" lived nowhere near the button that answered it,
     * and vanished entirely on a narrow screen. The value is the same for every part of a regular
     * bonus and is in the context line and the running total; the team is the thing that differs
     * between two buttons sitting side by side, so the team is what is written on them.
     */
    const partChoice = (index: number, outcome: BonusPartOutcome, label: string, teamName?: string) => (
      <button
        type="button"
        aria-pressed={outcomes[index] === outcome}
        aria-label={
          teamName === undefined
            ? `No points on part ${index + 1}`
            : `Part ${index + 1} to ${teamName}, ${perPart} points`
        }
        // A name too long for its column is truncated in paint only; this and the accessible name
        // both keep the whole of it.
        title={teamName}
        className={choiceClass(index, outcome, outcomes[index] === outcome)}
        data-selection-token={
          acknowledgement?.index === index && acknowledgement.outcome === outcome
            ? acknowledgement.token
            : undefined
        }
        onClick={() => choosePart(index, outcome)}
      >
        {label}
      </button>
    );

    return (
      <section className="scorer-prompt scorer-bonus-prompt" aria-label="Bonus">
        <div className="scorer-prompt-content">
          <p className="scorer-prompt-title">
            <span className="scorer-prompt-team">{controllingTeamName}</span> bonus
            <span className="scorer-prompt-context">
              Q{questionNumber} · {partCount} {partCount === 1 ? 'part' : 'parts'}, {perPart} each
            </span>
            {/*
              Up here with what this panel is, not down among the answers.
              
              It is a way of saying "ask me differently", which is a different kind of thing from
              the buttons that answer the question — and putting it under them left it floating
              below the panel looking like a stray link, in reach of a hand aiming at Record. Being
              in the heading also puts it as far as it can be from the controls a mispress would
              cost something.
            */}
            <button
              type="button"
              className="scorer-text-action scorer-prompt-switch"
              onClick={() => setByParts(false)}
            >
              Enter totals instead
            </button>
          </p>
          {/*
            The format, explained once, in a sentence, where a subtitle goes — rather than as a note
            wedged under a column heading. It names both teams and says what the bounce actually is,
            which is the one thing about this bonus a scorekeeper new to the format needs told.
          */}
          {bouncesBack && (
            <p className="scorer-prompt-note">
              {opponentName} can score any part {controllingTeamName} misses.
            </p>
          )}
          <div className="scorer-bonus-parts">
            {/*
              Not a list: every row is a `group`, and an `<ol>` whose children all carry another role
              is announced as a list with nothing in it. The grouping that matters is the one that
              says which part these buttons belong to, and that is on the row itself.
            */}
            <div className="scorer-part-list">
              {outcomes.map((outcome, index) => {
                // Position is the identity of a bonus part; there is nothing else to key on.
                const rowClass = [
                  'scorer-part-row',
                  bouncesBack ? '' : 'is-two-way',
                  index === activeIndex ? 'is-active' : '',
                  outcome !== null ? 'is-answered' : '',
                  acknowledgement?.index === index ? 'is-part-set' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <div
                    key={index}
                    className={rowClass}
                    data-motion-token={acknowledgement?.index === index ? acknowledgement.token : undefined}
                    role="group"
                    aria-label={`Part ${index + 1} of ${partCount}`}
                  >
                    <span className="scorer-part-label">Part {index + 1}</span>
                    {partChoice(index, 'controlled', controllingTeamName, controllingTeamName)}
                    {bouncesBack && partChoice(index, 'bounceback', opponentName, opponentName)}
                    {partChoice(index, 'missed', 'No points')}
                  </div>
                );
              })}
            </div>
            {/*
              Whose points these are, not how they were come by. "20 controlled · 10 bounceback" is
              the storage; the room wants to know that Ninety Six has 20 and Greenwood has 10.
            */}
            <div className="scorer-part-footer">
              <p className="scorer-part-total">
                <span className="scorer-part-total-team">
                  <span aria-hidden="true">{controllingTeamName} </span>
                  <MotionNumber
                    value={runningTotals.controlled}
                    minimumDigits={2}
                    aria-label={`${controllingTeamName} ${runningTotals.controlled} points`}
                  />
                </span>
                {bouncesBack && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="scorer-part-total-team">
                      <span aria-hidden="true">{opponentName} </span>
                      <MotionNumber
                        value={runningTotals.bounceback}
                        minimumDigits={2}
                        aria-label={`${opponentName} ${runningTotals.bounceback} points`}
                      />
                    </span>
                  </>
                )}
              </p>
              {/*
                Focused the moment the last part is answered, so the key that finishes a bonus is
                Enter without a shortcut having to be invented for it — and so the eye is taken to
                the one thing left to do.
              */}
              <button
                ref={recordRef}
                type="button"
                className="scorer-submit scorer-part-record"
                disabled={!complete}
                onClick={recordParts}
              >
                Record bonus
              </button>
              {!complete && (
                <p className="scorer-part-progress">
                  {answeredCount} of {partCount} parts scored
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="scorer-prompt scorer-bonus-prompt" aria-label="Bonus">
      <div className="scorer-prompt-content">
        <p className="scorer-prompt-title">
          <span className="scorer-prompt-team">{controllingTeamName}</span> bonus
          <span className="scorer-prompt-context">Q{questionNumber}</span>
          {/* The same switch in the same place, so the two ways in are each other's opposite. */}
          {partCount !== null && (
            <button
              type="button"
              className="scorer-text-action scorer-prompt-switch"
              onClick={() => setByParts(true)}
            >
              Score by part
            </button>
          )}
        </p>
        {totals !== null ? (
          /*
            One stationary panel with both teams on it, rather than the controlling team's screen
            handing over to the opponent's. The handoff was a whole screen change for a second
            number, and it took the first number away exactly when somebody might want to correct it.
          */
          <div className="scorer-bonus-totals">
            <div className="scorer-bonus-total-row">
              <span className="scorer-bonus-total-label" aria-hidden="true">
                {controllingTeamName}
              </span>
              {/* The group is the buttons, not the row: a row whose only other content is a typed
                  field would give the field and its container the same name. */}
              <fieldset className="scorer-choices">
                <legend className="visually-hidden">{controllingTeamName} bonus points</legend>
                {totals.map((points) => (
                  <button
                    key={points}
                    type="button"
                    aria-pressed={bouncesBack ? controlled === points : undefined}
                    /*
                     * Named only where a second row of identical numbers is on screen. Without
                     * bouncebacks the panel has one team on it and the group above already says
                     * whose it is, so the button is a total and reads as one.
                     */
                    aria-label={bouncesBack ? `${controllingTeamName}, ${points} points` : undefined}
                    className={
                      bouncesBack && controlled === points ? 'scorer-choice is-selected' : 'scorer-choice'
                    }
                    onClick={() => chooseControlledTotal(points)}
                  >
                    {points}
                  </button>
                ))}
              </fieldset>
            </div>
            {opponentOptions !== null && (
              <div className="scorer-bonus-total-row">
                <span className="scorer-bonus-total-label" aria-hidden="true">
                  {opponentName}
                </span>
                <fieldset className="scorer-choices">
                  <legend className="visually-hidden">{opponentName} points from missed parts</legend>
                  {opponentOptions.map((points) => (
                    <button
                      key={points}
                      type="button"
                      // Bounded by what the controlling team left; until it has been chosen there is
                      // no bound to apply, which is what these being unavailable says.
                      disabled={controlled === null}
                      aria-label={`${opponentName}, ${points} points`}
                      className="scorer-choice"
                      onClick={() => controlled !== null && onRecord(controlled, points)}
                    >
                      {points}
                    </button>
                  ))}
                </fieldset>
                {controlled === null && (
                  <p className="scorer-hint">Choose {controllingTeamName}&rsquo;s total first.</p>
                )}
              </div>
            )}
          </div>
        ) : (
          /*
            An irregular bonus: no fixed part value and no fixed count, so there is nothing to
            enumerate for either team. Both fields and one Record, because a room reading out two
            numbers should not have to record them one at a time.
          */
          <form
            className="scorer-bonus-typed"
            onSubmit={(submitEvent) => {
              submitEvent.preventDefault();
              if (controlledNumber === null || typedProblem) return;
              onRecord(controlledNumber, bouncesBack ? bouncebackNumber : undefined);
            }}
          >
            <div className="scorer-bonus-typed-team">
              <span className="scorer-bonus-total-label" aria-hidden="true">
                {controllingTeamName}
              </span>
              <label htmlFor="scorer-bonus-points">
                Bonus points
                <input
                  id="scorer-bonus-points"
                  type="number"
                  inputMode="numeric"
                  step={format.bonus.divisor || 1}
                  min={0}
                  max={format.bonus.maximumScore}
                  value={typedControlled}
                  aria-label={`${controllingTeamName} bonus points`}
                  aria-invalid={typedProblem !== null}
                  aria-describedby={typedProblem ? 'scorer-bonus-points-error' : undefined}
                  onChange={(changeEvent) => setTypedControlled(changeEvent.target.value)}
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                />
              </label>
            </div>
            {bouncesBack && (
              <div className="scorer-bonus-typed-team">
                <span className="scorer-bonus-total-label" aria-hidden="true">
                  {opponentName}
                </span>
                <label htmlFor="scorer-bounceback-points">
                  Points from missed parts
                  <input
                    id="scorer-bounceback-points"
                    type="number"
                    inputMode="numeric"
                    step={format.bonus.divisor || 1}
                    min={0}
                    max={format.bonus.maximumScore}
                    value={typedBounceback}
                    aria-label={`${opponentName} points from missed parts`}
                    aria-invalid={typedProblem !== null}
                    aria-describedby={typedProblem ? 'scorer-bonus-points-error' : undefined}
                    onChange={(changeEvent) => setTypedBounceback(changeEvent.target.value)}
                  />
                </label>
              </div>
            )}
            <button
              type="submit"
              className="scorer-choice"
              disabled={controlledNumber === null || typedProblem !== null}
            >
              Record bonus
            </button>
            {typedProblem && (
              <p id="scorer-bonus-points-error" className="scorer-problem" role="alert" aria-live="polite">
                {typedProblem}
              </p>
            )}
          </form>
        )}
      </div>
    </section>
  );
}
