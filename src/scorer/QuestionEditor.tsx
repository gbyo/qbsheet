/**
 * Correcting one question.
 *
 * # What a scorekeeper is actually doing here
 *
 * They are answering one question — "what happened on Q7?" — usually because a moderator has just
 * overturned a ruling or because they pressed the wrong player's button four tossups ago. The
 * correction machinery underneath is exactly right: the complete cycle is edited as a unit,
 * validated as a unit, and every later score, bonus and tossups-heard is derived again from the
 * replacement.
 *
 * The screen over it was not. It led with a paragraph about atomic replacement and derived state,
 * showed the active lineup and the protest log before anything editable, and then asked for a buzz
 * in four controls: team, "Buzz / ruling", player, and separately the point value — with Up and
 * Down buttons on every row of a list that can hold two.
 *
 * So this is a scoresheet line for one question. Team, player, ruling. The ruling control carries
 * the point value, because "+10" *is* the ruling and splitting them was asking the same question
 * twice. Everything a scoresheet has in the margin — who was on the floor, protests, flags, the
 * replacement-question workflow — is behind More, where margins go.
 *
 * # A rule means one thing
 *
 * This application is ruled rather than boxed, which only works while a rule is scarce enough to
 * mean something. This dialog had drifted to twelve of them in six hundred pixels — under the table
 * header, under each team's row, above every attempt, below the last one, around the disclosure —
 * all drawn in the same 1px, so a row boundary looked exactly like the boundary between Tossup and
 * Bonus and none of them said anything.
 *
 * There are two rules left. A full-width one opens a region: Tossup, Bonus, Correction details, the
 * footer. One under a column heading says the words above name the columns below, and the score
 * table is the only thing that needs it, because it is the only part of the dialog made of bare
 * text rather than bordered controls. Everything else is grouped by space and by column alignment.
 * The attempt list is not ruled at all: it holds two rows at the most, and two rows do not need
 * three lines to be told apart.
 *
 * # Nothing here knows any format
 *
 * The rulings are `format.answerTypes`. The bonus buttons are `regularBonusTotals`. The number of
 * attempts a cycle may hold is the engine's, checked by `validateEditableQuestion`. There is no
 * +15, no −5, no 0/10/20/30 and no notion of which rule set this is.
 */
import { useEffect, useMemo, useState } from 'react';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IDerivedGame } from '../scoring/deriveGame';
import { IBonusPartResult } from '../scoring/ScoreEvents';
import {
  IEditableAttempt,
  IEditableBonus,
  IEditableQuestion,
  conversion,
  expectsBonus,
  settleBonus,
  validateEditableQuestion,
} from '../scoring/questionCorrection';
import { bouncebackNeedsTypedEntry, bouncebackOptions, regularBonusTotals } from './bonusOptions';
import { powerCorrect } from './tossupRulings';

const noPenaltyValue = 'no-penalty';
const unchosenValue = '';

/** The format's own ruling label plus its value. */
function rulingLabel(format: IScorekeeperFormat, index: number): string {
  const answerType = format.answerTypes[index];
  if (!answerType) return 'Choose…';
  const points = answerType.value > 0 ? `+${answerType.value}` : String(answerType.value);
  const hasExplicitLabel = answerType.label.trim() !== '' && answerType.label !== String(answerType.value);
  const name = hasExplicitLabel
    ? answerType.label
    : answerType.value < 0
      ? 'Neg'
      : powerCorrect(format)?.index === answerType.index
        ? 'Power'
        : answerType.value > 0
          ? 'Correct'
          : // A tournament-defined answer type worth nothing is not the no-penalty wrong answer below:
            // it is a ruling the format lists, it records a buzz of that type, and it counts in the
            // stats as one. Naming both of them "Wrong" put two options in this list that read
            // identically and behaved differently.
            'No points';
  return `${name} (${points})`;
}

/**
 * The wrong answer that costs nothing, named so it cannot be mistaken for an answer type.
 *
 * It is a ruling rather than a member of `format.answerTypes` — it records `tossup-no-penalty`, not a
 * buzz — and a format is allowed to define a real zero-point answer type alongside it. The collision
 * check is not decoration: a tournament may label its own zero answer with these very words, and two
 * identical options in one dropdown is the defect this is here to prevent.
 */
function noPenaltyLabel(format: IScorekeeperFormat): string {
  const preferred = 'Wrong, no penalty (0)';
  const taken = format.answerTypes.some((answerType) => rulingLabel(format, answerType.index) === preferred);
  return taken ? 'Wrong, no penalty — not a scored answer (0)' : preferred;
}

function orderedRulingTypes(format: IScorekeeperFormat) {
  const powerIndex = powerCorrect(format)?.index;
  const rank = (value: number, index: number) =>
    value > 0 ? (index === powerIndex ? 0 : 1) : value === 0 ? 2 : 3;
  return [...format.answerTypes].sort(
    (first, second) => rank(first.value, first.index) - rank(second.value, second.index),
  );
}

function pointsLabel(points: number): string {
  return points > 0 ? `+${points}` : String(points);
}

function pointChangeLabel(before: number, after: number): string {
  const difference = Math.abs(after - before);
  return `${difference}-point change`;
}

/**
 * The one control that says what the buzz was.
 *
 * A format's answer types, plus the wrong answer that costs nothing — which is a *ruling*, not a
 * kind of event, however it happens to be stored. Encoded as strings because a select's value is a
 * string and the segmented buttons need the same stable values.
 */
function rulingValue(attempt: IEditableAttempt): string {
  if (attempt.kind === 'no-penalty') return noPenaltyValue;
  return attempt.answerTypeIndex === undefined ? '' : String(attempt.answerTypeIndex);
}

function firstActive(game: IDerivedGame, team: 'left' | 'right'): string {
  return game.questions.find((question) => question.activePlayers[team].length > 0)?.activePlayers[team][0] ?? '';
}

/**
 * Parts that add up to the bonus already recorded.
 *
 * Opening the parts view used to fill it with zeros, so pressing `Edit parts…` on a recorded 20 quietly
 * rewrote the bonus to 0 — and with the parts drawn as three chosen outcomes rather than three empty
 * boxes, that also put a wrong answer on screen: three Misses on a bonus that scored 20.
 *
 * A regular bonus's parts are interchangeable, all worth the same, so which of them were taken is
 * precisely what a total does not record. Filling them in order is the only decomposition available,
 * and it keeps the figures — the scorekeeper opened this to say which parts they belong to.
 */
function partsFromTotal(format: IScorekeeperFormat, bonus: IEditableBonus): IBonusPartResult[] {
  const count = Math.max(1, format.bonus.minimumParts);
  const perPart = format.bonus.pointsPerPart ?? 0;
  if (perPart <= 0) return Array.from({ length: count }, () => ({ controlledPoints: 0, bouncebackPoints: 0 }));
  let controlled = Math.max(0, Math.floor(bonus.controlledPoints / perPart));
  let bounced = Math.max(0, Math.floor(bonus.bouncebackPoints / perPart));
  return Array.from({ length: count }, () => {
    if (controlled > 0) {
      controlled -= 1;
      return { controlledPoints: perPart, bouncebackPoints: 0 };
    }
    if (bounced > 0) {
      bounced -= 1;
      return { controlledPoints: 0, bouncebackPoints: perPart };
    }
    return { controlledPoints: 0, bouncebackPoints: 0 };
  });
}

/**
 * What is in the number fields while somebody is still typing in them.
 *
 * A controlled number input coerced straight to `Number` turns an empty field into 0 and a
 * half-typed "-" into NaN, so clearing a box to retype it silently rewrites the bonus. The raw text
 * is kept here until it parses, and a field left unparseable is refused at save rather than saved
 * as a number nobody entered.
 */
interface IBonusDrafts {
  controlled?: string;
  bounceback?: string;
}

/** Who took a bonus part, as the live prompt asks it. */
type PartOutcome = 'controlled' | 'bounceback' | 'missed';

/** Which of the three a stored part result is. */
function partOutcome(part: IBonusPartResult): PartOutcome {
  if (part.controlledPoints > 0) return 'controlled';
  if ((part.bouncebackPoints ?? 0) > 0) return 'bounceback';
  return 'missed';
}

function syncBonus(bonus: IEditableBonus, parts: IEditableBonus['parts']): IEditableBonus {
  if (!parts) return { ...bonus, parts: undefined };
  return {
    ...bonus,
    parts: parts.map((part) => ({ ...part })),
    controlledPoints: parts.reduce((sum, part) => sum + part.controlledPoints, 0),
    bouncebackPoints: parts.reduce((sum, part) => sum + (part.bouncebackPoints ?? 0), 0),
  };
}

/**
 * Whether this browser has ever had the editor explained to it.
 *
 * Somebody opening a question for the first time has no way to know that this screen is the whole
 * cycle rather than the one buzz they clicked, that the score column is a preview and not a change
 * already made, or that leaving costs them nothing. Everybody after the first time knows, and a
 * permanent paragraph at the top of a correction is a paragraph a scorekeeper reads past. So: said
 * once, dismissible, remembered.
 */
const editorIntroSeenKey = 'qbsheet.questionEditor.introSeen.v1';

function readIntroSeen(): boolean {
  try {
    return window.localStorage.getItem(editorIntroSeenKey) === 'true';
  } catch {
    // Without storage the note simply shows again. That is the harmless direction to fail in.
    return false;
  }
}

function rememberIntroSeen(): void {
  try {
    window.localStorage.setItem(editorIntroSeenKey, 'true');
  } catch {
    // The note is a courtesy; failing to remember it must never stop a correction.
  }
}

/** Which team, if any, this proposed cycle says converted the tossup. */
function conversionTeam(model: IEditableQuestion, format: IScorekeeperFormat): 'left' | 'right' | undefined {
  return conversion(model, format)?.team;
}

/**
 * Why this cycle has no bonus to record.
 *
 * `expectsBonus` says whether one is owed; this says which of the four reasons it is not, because
 * "Bonus not applicable" on its own reads like a fault in the dialog. The clauses are in the same
 * order the engine tests them, and only reached when the engine has already said no — so this
 * explains the answer rather than deciding it, and cannot drift into being a second opinion.
 */
function noBonusReason(format: IScorekeeperFormat, model: IEditableQuestion, overtime: boolean): string {
  if (!format.bonus.enabled) return 'This format does not use bonuses.';
  if (overtime && !format.overtime.includesBonuses) return 'Overtime does not include bonuses in this format.';
  const converted = conversion(model, format);
  if (!converted) return 'A bonus follows a converted tossup. No team converted this one.';
  const index = converted.answerTypeIndex;
  return index === undefined
    ? 'A bonus follows a converted tossup.'
    : `${rulingLabel(format, index)} does not earn a bonus in this format.`;
}

/** The points this question contributes, independent of the running score around it. */
function questionPoints(model: IEditableQuestion, format: IScorekeeperFormat): { left: number; right: number } {
  const points = { left: 0, right: 0 };
  for (const attempt of model.attempts) {
    if (attempt.kind === 'buzz' && attempt.answerTypeIndex !== undefined) {
      points[attempt.team] += format.answerTypes[attempt.answerTypeIndex]?.value ?? 0;
    }
  }
  if (model.bonus) {
    const opponent = model.bonus.team === 'left' ? 'right' : 'left';
    points[model.bonus.team] += model.bonus.controlledPoints;
    points[opponent] += model.bonus.bouncebackPoints;
  }
  return points;
}

export default function QuestionEditor(props: {
  game: IDerivedGame;
  format: IScorekeeperFormat;
  initial: IEditableQuestion;
  onSave: (question: IEditableQuestion) => boolean;
  onCancel: () => void;
  onOpenReplacement?: () => void;
}) {
  const { game, format, initial, onSave, onCancel, onOpenReplacement } = props;
  /*
   * Part-by-part entry, and only where a part has a value to be worth.
   *
   * The same condition the live prompt's `regularPartCount` uses. A format that calls its bonuses
   * regular but names no part value has no three-way outcome to offer, so it keeps its total — and
   * must not open in a parts view it has no control for and no way out of.
   */
  const perPart = format.bonus.pointsPerPart ?? 0;
  const partOutcomesAvailable = format.bonus.regular && perPart > 0;
  const [model, setModel] = useState<IEditableQuestion>(() => ({
    ...initial,
    attempts: initial.attempts.map((attempt) => ({ ...attempt })),
    bonus: initial.bonus ? { ...initial.bonus, parts: initial.bonus.parts?.map((part) => ({ ...part })) } : undefined,
  }));
  const [errors, setErrors] = useState<string[]>([]);
  const [bonusDrafts, setBonusDrafts] = useState<IBonusDrafts>({});
  const [showMore, setShowMore] = useState(false);
  const [showParts, setShowParts] = useState(() => initial.bonus?.parts !== undefined && partOutcomesAvailable);
  const [showIntro, setShowIntro] = useState(() => !readIntroSeen());

  // A correction makes an old validation message stale. Clear it as soon as the scorekeeper edits.
  useEffect(() => setErrors([]), [model]);

  const question = game.questions.find((candidate) => candidate.questionNumber === model.questionNumber);
  const active = question?.activePlayers ?? { left: [], right: [] };
  const questionProtests = game.protests.filter((protest) => protest.questionNumber === model.questionNumber);
  const questionFlags = game.notes.filter((note) => note.questionNumber === model.questionNumber && note.flagged);

  const teamPlayers = useMemo(() => ({ left: active.left, right: active.right }), [active.left, active.right]);
  const teamName = (team: 'left' | 'right') => (team === 'left' ? game.left.name : game.right.name);
  const quickTotals = regularBonusTotals(format.bonus);
  const orderedTypes = orderedRulingTypes(format);
  const rulingOption = (answerType: (typeof format.answerTypes)[number]) => ({
    value: String(answerType.index),
    label: rulingLabel(format, answerType.index),
  });
  /*
   * A new attempt starts with no ruling chosen, so the blank option has to be selectable — but only
   * while something is actually on it. An existing cycle does not grow an empty choice in its
   * dropdown just because one could be added later.
   */
  const awaitingRuling = model.attempts.some(
    (attempt) => attempt.kind === 'buzz' && attempt.answerTypeIndex === undefined,
  );
  const rulingOptions = [
    ...(awaitingRuling ? [{ value: unchosenValue, label: 'Choose ruling…' }] : []),
    ...orderedTypes.map(rulingOption),
    { value: noPenaltyValue, label: noPenaltyLabel(format) },
  ];
  const initialPoints = useMemo(() => questionPoints(initial, format), [format, initial]);
  const proposedPoints = useMemo(() => questionPoints(model, format), [format, model]);

  const scoreImpactRow = (name: string, before: number, after: number) => {
    const changed = before !== after;
    return (
      <tr className={changed ? undefined : 'is-unchanged'} key={name}>
        <th scope="row">{name}:</th>
        <td>
          {changed ? (
            <span className="scorer-question-score-impact">
              <span className="scorer-question-score-change">
                <span className="scorer-question-score-before">{pointsLabel(before)}</span>
                <span className="scorer-question-score-arrow" aria-hidden="true">
                  →
                </span>
                <strong className="scorer-question-score-after">{pointsLabel(after)}</strong>
              </span>
              <span className="scorer-question-score-delta">{pointChangeLabel(before, after)}</span>
            </span>
          ) : (
            <span className="scorer-question-score-unchanged">unchanged at {pointsLabel(after)}</span>
          )}
        </td>
      </tr>
    );
  };

  /**
   * Every edit to the tossup, with everything that depends on it brought along.
   *
   * `settleBonus` is the whole point of routing them through one place: a bonus follows the team that
   * converted and stops existing when the conversion stops earning one, and both of those used to be
   * discovered by the validator at Save rather than by the screen at the moment of the edit.
   */
  const reviseTossup = (revise: (current: IEditableQuestion) => IEditableQuestion) => {
    setModel((current) => settleBonus(revise(current), format, game));
  };

  const updateAttempt = (index: number, next: Partial<IEditableAttempt>) => {
    reviseTossup((current) => ({
      ...current,
      attempts: current.attempts.map((attempt, attemptIndex) => {
        if (attemptIndex !== index) return attempt;
        const updated = { ...attempt, ...next };
        if (next.team !== undefined && !teamPlayers[next.team].includes(updated.playerName ?? '')) {
          updated.playerName = teamPlayers[next.team][0] ?? '';
        }
        return updated;
      }),
    }));
  };

  /** One control, so the two halves of a ruling can never disagree with each other. */
  const setRuling = (index: number, value: string) => {
    if (value === noPenaltyValue) {
      updateAttempt(index, { kind: 'no-penalty', answerTypeIndex: undefined });
      return;
    }
    // Back to no choice at all, which `Number('')` would otherwise read as answer type 0.
    if (value === unchosenValue) {
      updateAttempt(index, { kind: 'buzz', answerTypeIndex: undefined });
      return;
    }
    const answerTypeIndex = Number(value);
    const converts = (format.answerTypes[answerTypeIndex]?.value ?? 0) > 0;
    reviseTossup((current) => ({
      ...current,
      dead: converts ? false : current.dead,
      attempts: current.attempts.map((attempt, attemptIndex) =>
        attemptIndex === index ? { ...attempt, kind: 'buzz', answerTypeIndex } : attempt,
      ),
    }));
  };

  /*
   * A new attempt has no ruling, and is not given one.
   *
   * It used to open on `format.answerTypes.find(value > 0)`, and answer types are ordered
   * highest-value first — so adding an attempt under 15/10/−5 rules silently proposed a power, and
   * under a three-tier format the top tier. A default that is wrong more often than it is right is
   * worse than no default: the ruling is the one thing on this row nothing can infer.
   */
  const addAttempt = () => {
    const team = model.attempts.some((attempt) => attempt.team === 'left') ? 'right' : 'left';
    reviseTossup((current) => ({
      ...current,
      dead: false,
      attempts: current.attempts.concat({
        kind: 'buzz',
        team,
        playerName: teamPlayers[team][0] ?? firstActive(game, team),
        answerTypeIndex: undefined,
      }),
    }));
  };

  const setBonus = (next: Partial<IEditableBonus>) => {
    setBonusDrafts({});
    setModel((current) => {
      const existing = current.bonus ?? { team: 'left' as const, controlledPoints: 0, bouncebackPoints: 0 };
      return { ...current, bonus: { ...existing, ...next } };
    });
  };

  /** Hold what was typed; only commit it to the model once it is a number. */
  const updateBonusTotal = (field: 'controlledPoints' | 'bouncebackPoints', raw: string) => {
    setBonusDrafts((current) => ({ ...current, [field === 'controlledPoints' ? 'controlled' : 'bounceback']: raw }));
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    setBonus({ [field]: parsed, parts: undefined });
  };

  /**
   * Who took one part: the same three outcomes the live prompt offers, written to the same model.
   *
   * There is deliberately no typed part entry to go with this. A regular bonus part is worth exactly
   * `pointsPerPart` or nothing, so the three buttons cover every outcome the rules allow — and the
   * pair of number boxes they replace was the only way to enter a part value the format forbids.
   */
  const setBonusPartOutcome = (index: number, outcome: PartOutcome) => {
    setModel((current) => {
      if (!current.bonus?.parts) return current;
      const parts = current.bonus.parts.map((part, partIndex) =>
        partIndex === index
          ? {
              controlledPoints: outcome === 'controlled' ? perPart : 0,
              bouncebackPoints: outcome === 'bounceback' ? perPart : 0,
            }
          : part,
      );
      return { ...current, bonus: syncBonus(current.bonus, parts) };
    });
  };

  const save = () => {
    // A field somebody emptied and never refilled is not a zero. Say so rather than saving one.
    const draftErrors = Object.entries({
      controlled: bonusDrafts.controlled,
      bounceback: bonusDrafts.bounceback,
    })
      .filter(([, value]) => value !== undefined && (value.trim() === '' || !Number.isFinite(Number(value))))
      .map(([field]) => `Enter a valid number for ${field.replace(/-/g, ' ')}.`);
    const nextErrors = [...draftErrors, ...validateEditableQuestion(format, game, model)];
    setErrors(nextErrors);
    if (nextErrors.length === 0 && onSave(model)) onCancel();
  };

  const convertedAttempt = conversion(model, format);
  const converted = conversionTeam(model, format);
  const bonusTeam = model.bonus?.team ?? converted;
  const earnsBonus = expectsBonus(format, game, model);
  const overtime = question?.period === 'overtime';
  const opponentOf = (team: 'left' | 'right') => (team === 'left' ? 'right' : 'left');

  return (
    <form
      className="scorer-question-editor"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {showIntro && (
        <aside className="scorer-question-intro" aria-label="About editing this question">
          <p className="scorer-question-intro-title">First time here?</p>
          <ul>
            <li>
              This is the whole of Question {model.questionNumber} — every buzz on it and its bonus — not just the one
              action you selected.
            </li>
            <li>Nothing changes until you choose Save changes. Every later question is then worked out again.</li>
            <li>
              To leave it exactly as it is, use <strong>Cancel</strong> below or the <strong>×</strong> button at the top
              right. Escape works too.
            </li>
          </ul>
          <button
            type="button"
            className="scorer-text-action"
            onClick={() => {
              rememberIntroSeen();
              setShowIntro(false);
            }}
          >
            Got it — don’t show this again
          </button>
        </aside>
      )}
      <table className="scorer-question-score" aria-label={`Question ${model.questionNumber} score impact`}>
        <caption>Score impact</caption>
        <tbody>
          {scoreImpactRow(game.left.name, initialPoints.left, proposedPoints.left)}
          {scoreImpactRow(game.right.name, initialPoints.right, proposedPoints.right)}
        </tbody>
      </table>

      <section className="scorer-question-section" aria-label="Tossup attempts">
        <div className="scorer-question-section-head">
          <h4 className="scorer-question-heading">Tossup</h4>
          <div className="scorer-question-status-actions">
            <span className="scorer-question-status">
              {model.dead
                ? model.attempts.length === 0
                  ? 'No buzz'
                  : 'No conversion'
                : `${model.attempts.length} ${model.attempts.length === 1 ? 'attempt' : 'attempts'}`}
            </span>
            {model.attempts.length < 2 && converted === undefined && (
              <>
                <span aria-hidden="true">·</span>
                <button type="button" className="scorer-text-action" onClick={addAttempt}>
                  + Add attempt
                </button>
              </>
            )}
          </div>
        </div>
        {model.attempts.length > 0 && (
          <div className="scorer-question-attempt-head" aria-hidden="true">
            <span />
            <span>Team</span>
            <span>Player</span>
            <span>Ruling</span>
            <span />
          </div>
        )}
        <ol className="scorer-question-attempts">
          {model.attempts.map((attempt, index) => (
            // Attempts have no persisted identity until they are written; position is identity.

            <li key={attempt.id ?? `attempt-${index}`} className="scorer-question-attempt">
              <span className="scorer-question-attempt-number">{index + 1}</span>
              <label className="scorer-question-field">
                <span>Team</span>
                <select
                  aria-label={`Question ${model.questionNumber} attempt ${index + 1} team`}
                  value={attempt.team}
                  onChange={(event) => updateAttempt(index, { team: event.target.value as 'left' | 'right' })}
                >
                  <option value="left">{game.left.name}</option>
                  <option value="right">{game.right.name}</option>
                </select>
              </label>
              <label className="scorer-question-field">
                <span>Player</span>
                <select
                  aria-label={
                    model.attempts.length === 1
                      ? 'Player'
                      : `Question ${model.questionNumber} attempt ${index + 1} player`
                  }
                  value={attempt.playerName ?? ''}
                  onChange={(event) => updateAttempt(index, { playerName: event.target.value })}
                >
                  {attempt.kind === 'no-penalty' && <option value="">No player recorded</option>}
                  {teamPlayers[attempt.team].map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="scorer-question-field scorer-question-field-ruling">
                <span>Ruling</span>
                <select
                  aria-label={
                    model.attempts.length === 1
                      ? 'Ruling'
                      : `Question ${model.questionNumber} attempt ${index + 1} ruling`
                  }
                  value={rulingValue(attempt)}
                  onChange={(event) => setRuling(index, event.target.value)}
                >
                  {rulingOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="scorer-text-action is-destructive"
                onClick={() =>
                  setModel((current) => ({
                    ...current,
                    attempts: current.attempts.filter((_, attemptIndex) => attemptIndex !== index),
                  }))
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
        {model.attempts.length === 0 && !model.dead && (
          <p className="scorer-question-empty">No tossup ruling recorded.</p>
        )}
        {/*
          The tossup's own outcome, on the tossup.

          This control used to live in the Bonus section and rename itself to "End question without a
          bonus" as soon as an attempt existed — a label that described the smallest thing it could
          do. With a conversion on the question, ticking it deleted the correct answer and killed the
          tossup, which is not what "without a bonus" says and not a thing a checkbox should do
          silently. So it says what it does: with nothing on the question, No buzz; with attempts on
          it, No team converted. It is never the way to remove a correct answer — that is the ruling
          control's job, one row up, where the correct answer is.

          The third concept the old label conflated is not a control at all: whether a bonus applies
          is derived from the ruling and the format, and the Bonus section says so in words.
        */}
        <div className="scorer-question-actions">
          <label className="scorer-checkbox" htmlFor={`question-${model.questionNumber}-dead`}>
            <input
              id={`question-${model.questionNumber}-dead`}
              type="checkbox"
              checked={model.dead}
              disabled={converted !== undefined}
              onChange={(event) =>
                reviseTossup((current) => ({ ...current, dead: event.target.checked }))
              }
            />
            {model.attempts.length === 0 ? 'No buzz' : 'No team converted'}
          </label>
          {converted !== undefined && (
            <span className="scorer-question-status">
              {teamName(converted)} converted this tossup. Change that ruling to record one nobody converted.
            </span>
          )}
        </div>
        {model.attempts.length === 2 && (
          <div className="scorer-question-actions">
            {/*
              One control instead of an Up and a Down on every row. Order matters — it decides which
              team negged and which one answered afterwards — but with two attempts there is exactly
              one other order.
            */}
            <button
              type="button"
              className="scorer-text-action"
              onClick={() =>
                setModel((current) => ({ ...current, attempts: [current.attempts[1], current.attempts[0]] }))
              }
            >
              Swap order
            </button>
          </div>
        )}
      </section>

      <section className="scorer-question-section" aria-label="Bonus correction">
        <div className="scorer-question-section-head scorer-question-bonus-head">
          <div className="scorer-question-heading-line">
            <h4 className="scorer-question-heading">
              Bonus{bonusTeam ? ` — ${teamName(bonusTeam).toLocaleUpperCase()}` : ''}
            </h4>
          </div>
          {model.bonus ? (
            <button
              type="button"
              className="scorer-text-action is-destructive scorer-question-remove-bonus"
              onClick={() => setModel((current) => ({ ...current, bonus: undefined }))}
            >
              Remove bonus
            </button>
          ) : (
            /*
              Offered only when the rules say this conversion earns one.

              `expectsBonus` is the engine's rule, the same one the validator applies at Save, so the
              button cannot appear for an answer type with `awardsBonus: false` or for an overtime
              tossup in a format whose overtime excludes bonuses. It used to appear whenever the
              format used bonuses at all, which meant the dialog could invite an action its own
              validator would then refuse.
            */
            earnsBonus &&
            convertedAttempt !== undefined && (
              <div className="scorer-question-bonus-head-actions">
                <button
                  type="button"
                  className="scorer-action"
                  onClick={() => {
                    setShowParts(false);
                    // The converting team, taken from the conversion itself: there is no bonus without
                    // one, which is why this dialog has no controlling-team selector any more.
                    setBonus({ team: convertedAttempt.team, controlledPoints: 0, bouncebackPoints: 0 });
                  }}
                >
                  Add bonus
                </button>
              </div>
            )
          )}
        </div>
        {/*
          Why there is nothing to record, rather than a button that leads to a refusal.

          Also where a bonus that has just stopped being earned is accounted for: `settleBonus`
          removes it the moment the ruling changes, and this says so instead of letting the figure
          disappear out of the dialog unremarked.
        */}
        {!earnsBonus && !model.bonus && (
          <p className="scorer-question-empty">
            {noBonusReason(format, model, overtime)}
            {initial.bonus ? ' The bonus recorded here will be removed when you save.' : ''}
          </p>
        )}
        {model.bonus && !earnsBonus && (
          <p className="scorer-question-empty">
            {noBonusReason(format, model, overtime)} Remove this bonus, or change the tossup ruling that should have
            earned it.
          </p>
        )}
        {model.bonus && earnsBonus && (
          <div className="scorer-question-bonus">
            {quickTotals !== null && !showParts ? (
              <div className="scorer-question-totals" role="group" aria-label="Bonus points">
                {quickTotals.map((total) => (
                  <button
                    key={total}
                    type="button"
                    className={model.bonus?.controlledPoints === total ? 'scorer-choice is-selected' : 'scorer-choice'}
                    aria-pressed={model.bonus?.controlledPoints === total}
                    onClick={() => setBonus({ controlledPoints: total, parts: undefined })}
                  >
                    {total}
                  </button>
                ))}
              </div>
            ) : (
              /* Irregular bonuses have no enumerable totals: the only honest control is a number. */
              <label htmlFor={`question-${model.questionNumber}-bonus-controlled`}>
                Points
                <input
                  id={`question-${model.questionNumber}-bonus-controlled`}
                  aria-label="Points"
                  type="number"
                  value={bonusDrafts.controlled ?? String(model.bonus.controlledPoints)}
                  disabled={showParts}
                  onChange={(event) => updateBonusTotal('controlledPoints', event.target.value)}
                />
              </label>
            )}
            {/* Only where the format actually has bouncebacks; otherwise there is nothing to enter. */}
            {format.bonus.bounceBack && !showParts && (
              bouncebackNeedsTypedEntry(format.bonus, model.bonus.controlledPoints) ? (
                <label htmlFor={`question-${model.questionNumber}-bonus-bounceback`}>
                  Bounceback
                  <input
                    id={`question-${model.questionNumber}-bonus-bounceback`}
                    aria-label="Bonus bounceback points"
                    type="number"
                    min={0}
                    max={Math.max(0, format.bonus.maximumScore - model.bonus.controlledPoints)}
                    step={format.bonus.divisor || 1}
                    value={bonusDrafts.bounceback ?? String(model.bonus.bouncebackPoints)}
                    onChange={(event) => updateBonusTotal('bouncebackPoints', event.target.value)}
                  />
                </label>
              ) : (
                <label htmlFor={`question-${model.questionNumber}-bonus-bounceback`}>
                  Bounceback
                  <select
                    id={`question-${model.questionNumber}-bonus-bounceback`}
                    aria-label="Bonus bounceback points"
                    value={String(model.bonus.bouncebackPoints)}
                    onChange={(event) => setBonus({ bouncebackPoints: Number(event.target.value), parts: undefined })}
                  >
                    {bouncebackOptions(format.bonus, model.bonus.controlledPoints).map((points) => (
                      <option key={points} value={points}>
                        {points}
                      </option>
                    ))}
                  </select>
                </label>
              )
            )}
            {partOutcomesAvailable && (
              <button
                type="button"
                className="scorer-text-action"
                onClick={() => {
                  if (showParts) {
                    setShowParts(false);
                    setBonus({ parts: undefined });
                    return;
                  }
                  setShowParts(true);
                  setModel((current) =>
                    current.bonus
                      ? { ...current, bonus: syncBonus(current.bonus, partsFromTotal(format, current.bonus)) }
                      : current,
                  );
                }}
              >
                {showParts ? 'Use total' : 'Edit parts…'}
              </button>
            )}
            {/*
              The same question the live prompt asks, asked the same way.

              This was two unlabelled number boxes per part, so a bounceback format showed `Part 1
              [0] [10]` and left the scorekeeper to work out from the accessible names which column
              was which team. A part has three outcomes, not two numbers: the controlling team took
              it, it bounced, or nobody got it. The columns are named after the teams because in a
              correction — unlike in the live prompt, which has just come from that team's own
              buttons — there is nothing else on screen saying which side is which.
            */}
            {showParts && model.bonus.parts && bonusTeam !== undefined && (
              <div className="scorer-question-parts">
                <div
                  className={
                    format.bonus.bounceBack
                      ? 'scorer-question-part-head'
                      : 'scorer-question-part-head is-two-way'
                  }
                  aria-hidden="true"
                >
                  <span />
                  <span>{teamName(bonusTeam)}</span>
                  {format.bonus.bounceBack && <span>{teamName(opponentOf(bonusTeam))} bounceback</span>}
                  <span />
                </div>
                {model.bonus.parts.map((part, index) => {
                  // Parts have no persisted identity in QBJ; their position is their identity.
                  const outcome = partOutcome(part);
                  const choice = (
                    value: PartOutcome,
                    label: string,
                    accessibleName: string,
                  ) => (
                    <button
                      type="button"
                      aria-label={accessibleName}
                      aria-pressed={outcome === value}
                      className={outcome === value ? 'scorer-choice is-selected' : 'scorer-choice'}
                      onClick={() => setBonusPartOutcome(index, value)}
                    >
                      {label}
                    </button>
                  );
                  return (
                    <div
                      key={`part-${index}`}
                      className={format.bonus.bounceBack ? 'scorer-question-part' : 'scorer-question-part is-two-way'}
                    >
                      <span>Part {index + 1}</span>
                      {choice('controlled', `+${perPart}`, `Bonus part ${index + 1} to ${teamName(bonusTeam)}`)}
                      {format.bonus.bounceBack &&
                        choice(
                          'bounceback',
                          `+${perPart}`,
                          `Bonus part ${index + 1} bounced back to ${teamName(opponentOf(bonusTeam))}`,
                        )}
                      {choice('missed', 'Miss', `Bonus part ${index + 1} missed`)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/*
        The margin of the scoresheet. Real, kept, and not what a scorekeeper correcting a buzz is
        looking for — so it waits to be opened rather than taking the top half of the dialog.
      */}
      <button
        type="button"
        className="scorer-question-disclosure"
        aria-expanded={showMore}
        aria-controls={`question-${model.questionNumber}-correction-details`}
        onClick={() => setShowMore((current) => !current)}
      >
        <span>Correction details</span>
        <span aria-hidden="true">{showMore ? '−' : '+'}</span>
      </button>
      {showMore && (
        <section
          id={`question-${model.questionNumber}-correction-details`}
          className="scorer-question-more"
          aria-label="Correction details"
        >
          <p className="scorer-dialog-note">
            On the floor — {game.left.name}: {active.left.length > 0 ? active.left.join(', ') : 'none'};{' '}
            {game.right.name}: {active.right.length > 0 ? active.right.join(', ') : 'none'}.
          </p>
          <div className="scorer-question-reading-state">
            <label className="scorer-checkbox">
              <input
                type="checkbox"
                checked={model.readingResumed === true}
                disabled={model.attempts.length === 0}
                onChange={(event) => setModel((current) => ({ ...current, readingResumed: event.target.checked }))}
              />
              Reading resumed after the first answer
            </label>
            <label className="scorer-checkbox">
              <input
                type="checkbox"
                checked={model.readout === true}
                onChange={(event) =>
                  setModel((current) => ({
                    ...current,
                    readout: event.target.checked,
                    ...(event.target.checked ? {} : { readoutBeforeAttempt: undefined }),
                  }))
                }
              />
              Question was read out before the final ruling
            </label>
          </div>
          {questionProtests.map((protest) => (
            <p key={protest.eventId} className="scorer-dialog-note">
              Protest ({protest.status}) — {protest.description}
              {protest.resolution ? ` · ${protest.resolution}` : ''}
            </p>
          ))}
          {questionFlags.map((note) => (
            <p key={`${note.questionNumber}-${note.text}`} className="scorer-dialog-note">
              Flagged note — {note.text}
            </p>
          ))}
          <p className="scorer-dialog-note">
            The whole question is replaced as one unit and every later score is worked out again.
          </p>
          {onOpenReplacement && (
            <button type="button" className="scorer-action" onClick={onOpenReplacement}>
              Edit full question…
            </button>
          )}
        </section>
      )}

      {errors.length > 0 && (
        <div className="scorer-question-errors" role="alert">
          <strong>Check this question</strong>
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="scorer-question-footer">
        <button type="button" className="scorer-action" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="scorer-submit">
          Save changes
        </button>
      </div>
    </form>
  );
}
