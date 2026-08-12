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
 * There are two rules left. A full-width one opens a region: Tossup, Bonus, More context, the
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
import {
  IEditableAttempt,
  IEditableBonus,
  IEditableQuestion,
  conversion,
  validateEditableQuestion,
} from '../scoring/questionCorrection';
import { bouncebackOptions, regularBonusTotals } from './bonusOptions';
import { powerCorrect } from './tossupRulings';

const noPenaltyValue = 'no-penalty';

/** "Power (+15)" / "Correct (+10)" / "Neg (-5)". The editor should say what the ruling means. */
function rulingLabel(format: IScorekeeperFormat, index: number): string {
  const answerType = format.answerTypes[index];
  if (!answerType) return 'Choose…';
  const name =
    answerType.value < 0
      ? 'Neg'
      : powerCorrect(format)?.index === answerType.index
        ? 'Power'
        : answerType.value > 0
          ? 'Correct'
          : 'Wrong';
  const points = answerType.value > 0 ? `+${answerType.value}` : String(answerType.value);
  return `${name} (${points})`;
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

function defaultAnswerType(format: IScorekeeperFormat): number {
  return format.answerTypes.find((answerType) => answerType.value > 0)?.index ?? format.answerTypes[0]?.index ?? -1;
}

function defaultParts(format: IScorekeeperFormat): { controlledPoints: number; bouncebackPoints: number }[] {
  const count = Math.max(1, format.bonus.minimumParts);
  return Array.from({ length: count }, () => ({ controlledPoints: 0, bouncebackPoints: 0 }));
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
  parts: Record<string, string>;
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
  const [model, setModel] = useState<IEditableQuestion>(() => ({
    ...initial,
    attempts: initial.attempts.map((attempt) => ({ ...attempt })),
    bonus: initial.bonus ? { ...initial.bonus, parts: initial.bonus.parts?.map((part) => ({ ...part })) } : undefined,
  }));
  const [errors, setErrors] = useState<string[]>([]);
  const [bonusDrafts, setBonusDrafts] = useState<IBonusDrafts>({ parts: {} });
  const [showMore, setShowMore] = useState(false);
  const [showParts, setShowParts] = useState(() => initial.bonus?.parts !== undefined);
  const [showIntro, setShowIntro] = useState(() => !readIntroSeen());

  // A correction makes an old validation message stale. Clear it as soon as the scorekeeper edits.
  useEffect(() => setErrors([]), [model]);

  const question = game.questions.find((candidate) => candidate.questionNumber === model.questionNumber);
  const scoreAfter = question?.scoreAfter ?? { left: game.left.points, right: game.right.points };
  const previous = game.questions.find((candidate) => candidate.questionNumber === model.questionNumber - 1);
  const scoreBefore = previous?.scoreAfter ?? { left: 0, right: 0 };
  const active = question?.activePlayers ?? { left: [], right: [] };
  const questionProtests = game.protests.filter((protest) => protest.questionNumber === model.questionNumber);
  const questionFlags = game.notes.filter((note) => note.questionNumber === model.questionNumber && note.flagged);

  const teamPlayers = useMemo(() => ({ left: active.left, right: active.right }), [active.left, active.right]);
  const teamName = (team: 'left' | 'right') => (team === 'left' ? game.left.name : game.right.name);
  const quickTotals = regularBonusTotals(format.bonus);
  const rulingOptions = [
    ...format.answerTypes.map((answerType) => ({
      value: String(answerType.index),
      label: rulingLabel(format, answerType.index),
    })),
    { value: noPenaltyValue, label: 'Wrong (0)' },
  ];
  const useRulingSegments = rulingOptions.length <= 4;
  const initialPoints = useMemo(() => questionPoints(initial, format), [format, initial]);
  const proposedPoints = useMemo(() => questionPoints(model, format), [format, model]);
  const proposedScoreAfter = {
    left: scoreAfter.left - initialPoints.left + proposedPoints.left,
    right: scoreAfter.right - initialPoints.right + proposedPoints.right,
  };

  const updateAttempt = (index: number, next: Partial<IEditableAttempt>) => {
    setModel((current) => ({
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
    const answerTypeIndex = Number(value);
    const converts = (format.answerTypes[answerTypeIndex]?.value ?? 0) > 0;
    setModel((current) => ({
      ...current,
      dead: converts ? false : current.dead,
      attempts: current.attempts.map((attempt, attemptIndex) =>
        attemptIndex === index ? { ...attempt, kind: 'buzz', answerTypeIndex } : attempt,
      ),
    }));
  };

  const addAttempt = () => {
    const team = model.attempts.some((attempt) => attempt.team === 'left') ? 'right' : 'left';
    setModel((current) => ({
      ...current,
      dead: false,
      attempts: current.attempts.concat({
        kind: 'buzz',
        team,
        playerName: teamPlayers[team][0] ?? firstActive(game, team),
        answerTypeIndex: defaultAnswerType(format),
      }),
    }));
  };

  const setBonus = (next: Partial<IEditableBonus>) => {
    setBonusDrafts({ parts: {} });
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

  const updateBonusPart = (index: number, field: 'controlledPoints' | 'bouncebackPoints', raw: string) => {
    setBonusDrafts((current) => ({ ...current, parts: { ...current.parts, [`${index}-${field}`]: raw } }));
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    setModel((current) => {
      if (!current.bonus?.parts) return current;
      const parts = current.bonus.parts.map((part, partIndex) =>
        partIndex === index ? { ...part, [field]: parsed } : part,
      );
      return { ...current, bonus: syncBonus(current.bonus, parts) };
    });
  };

  const save = () => {
    // A field somebody emptied and never refilled is not a zero. Say so rather than saving one.
    const draftErrors = Object.entries({
      controlled: bonusDrafts.controlled,
      bounceback: bonusDrafts.bounceback,
      ...Object.fromEntries(Object.entries(bonusDrafts.parts).map(([key, value]) => [`part-${key}`, value])),
    })
      .filter(([, value]) => value !== undefined && (value.trim() === '' || !Number.isFinite(Number(value))))
      .map(([field]) => `Enter a valid number for ${field.replace(/-/g, ' ')}.`);
    const nextErrors = [...draftErrors, ...validateEditableQuestion(format, game, model)];
    setErrors(nextErrors);
    if (nextErrors.length === 0 && onSave(model)) onCancel();
  };

  const converted = conversionTeam(model, format);
  const bonusTeam = model.bonus?.team ?? converted;

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
              To leave it exactly as it is, use <strong>Cancel</strong> below or <strong>Close</strong> at the top right.
              Escape works too.
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
      <table className="scorer-question-score" aria-label={`Question ${model.questionNumber} score change`}>
        <caption>Score impact</caption>
        <tbody>
          <tr className={scoreBefore.left === proposedScoreAfter.left ? 'is-unchanged' : undefined}>
            <th scope="row">{game.left.name}</th>
            <td>
              {scoreBefore.left === proposedScoreAfter.left ? (
                <span className="scorer-question-score-unchanged">unchanged at {proposedScoreAfter.left}</span>
              ) : (
                <span className="scorer-question-score-change">
                  <span className="scorer-question-score-before">{scoreBefore.left}</span>
                  <span className="scorer-question-score-arrow" aria-hidden="true">
                    →
                  </span>
                  <strong className="scorer-question-score-after">{proposedScoreAfter.left}</strong>
                </span>
              )}
            </td>
          </tr>
          <tr className={scoreBefore.right === proposedScoreAfter.right ? 'is-unchanged' : undefined}>
            <th scope="row">{game.right.name}</th>
            <td>
              {scoreBefore.right === proposedScoreAfter.right ? (
                <span className="scorer-question-score-unchanged">unchanged at {proposedScoreAfter.right}</span>
              ) : (
                <span className="scorer-question-score-change">
                  <span className="scorer-question-score-before">{scoreBefore.right}</span>
                  <span className="scorer-question-score-arrow" aria-hidden="true">
                    →
                  </span>
                  <strong className="scorer-question-score-after">{proposedScoreAfter.right}</strong>
                </span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <section className="scorer-question-section" aria-label="Tossup attempts">
        <div className="scorer-question-section-head">
          <h4 className="scorer-question-heading">Tossup</h4>
          <span className="scorer-question-status">
            {model.dead
              ? model.attempts.length === 0
                ? 'No buzz'
                : 'No conversion'
              : `${model.attempts.length} ${model.attempts.length === 1 ? 'attempt' : 'attempts'}`}
          </span>
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
              {useRulingSegments ? (
                <div className="scorer-question-field scorer-question-field-ruling">
                  <span>Ruling</span>
                  <div
                    className="scorer-question-ruling"
                    role="group"
                    aria-label={
                      model.attempts.length === 1
                        ? 'Ruling'
                        : `Question ${model.questionNumber} attempt ${index + 1} ruling`
                    }
                  >
                    {rulingOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={
                          rulingValue(attempt) === option.value
                            ? 'scorer-choice scorer-question-ruling-choice is-selected'
                            : 'scorer-choice scorer-question-ruling-choice'
                        }
                        aria-pressed={rulingValue(attempt) === option.value}
                        onClick={() => setRuling(index, option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <label className="scorer-question-field">
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
              )}
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
        {model.dead && (
          <p className="scorer-question-empty">
            {model.attempts.length === 0
              ? 'This tossup was recorded with no buzz.'
              : 'No team converted this tossup.'}
          </p>
        )}
        <div className="scorer-question-actions">
          {model.attempts.length < 2 && converted === undefined && (
            <button type="button" className="scorer-action" onClick={addAttempt}>
              + Add attempt
            </button>
          )}
          {/*
            One control instead of an Up and a Down on every row. Order matters — it decides which
            team negged and which one answered afterwards — but with two attempts there is exactly
            one other order.
          */}
          {model.attempts.length === 2 && (
            <button
              type="button"
              className="scorer-text-action"
              onClick={() =>
                setModel((current) => ({ ...current, attempts: [current.attempts[1], current.attempts[0]] }))
              }
            >
              Swap order
            </button>
          )}
        </div>
      </section>

      <section className="scorer-question-section" aria-label="Bonus correction">
        <div className="scorer-question-section-head scorer-question-bonus-head">
          <div className="scorer-question-heading-line">
            <h4 className="scorer-question-heading">
              Bonus{bonusTeam ? ` — ${teamName(bonusTeam).toLocaleUpperCase()}` : ''}
            </h4>
            {model.bonus && (
              <button
                type="button"
                className="scorer-text-action is-destructive"
                onClick={() => setModel((current) => ({ ...current, bonus: undefined }))}
              >
                Remove bonus
              </button>
            )}
          </div>
          {!model.bonus && (
            <div className="scorer-question-bonus-head-actions">
              <label className="scorer-checkbox" htmlFor={`question-${model.questionNumber}-dead`}>
                <input
                  id={`question-${model.questionNumber}-dead`}
                  type="checkbox"
                  checked={model.dead}
                  onChange={(event) =>
                    setModel((current) => ({
                      ...current,
                      dead: event.target.checked,
                      attempts: event.target.checked && conversion(current, format) ? [] : current.attempts,
                      bonus: event.target.checked ? undefined : current.bonus,
                    }))
                  }
                />
                {model.attempts.length === 0 ? 'No buzz' : 'End question without a bonus'}
              </label>
              {/* Offered rather than drawn: a blank bonus form should not fill every correction. */}
              {!model.dead && (
                <button
                  type="button"
                  className="scorer-action"
                  onClick={() => {
                    setShowParts(false);
                    setBonus({ team: converted ?? 'left', controlledPoints: 0, bouncebackPoints: 0 });
                  }}
                >
                  Add bonus
                </button>
              )}
            </div>
          )}
        </div>
        {model.bonus && (
          <div className="scorer-question-bonus">
            {converted === undefined && (
              <label htmlFor={`question-${model.questionNumber}-bonus-team`}>
                Controlled by
                <select
                  id={`question-${model.questionNumber}-bonus-team`}
                  aria-label="Bonus controlling team"
                  value={model.bonus.team}
                  onChange={(event) => setBonus({ team: event.target.value as 'left' | 'right' })}
                >
                  <option value="left">{game.left.name}</option>
                  <option value="right">{game.right.name}</option>
                </select>
              </label>
            )}
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
            )}
            {format.bonus.regular && (
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
                    current.bonus ? { ...current, bonus: syncBonus(current.bonus, defaultParts(format)) } : current,
                  );
                }}
              >
                {showParts ? 'Use total' : 'Edit parts…'}
              </button>
            )}
            {showParts && model.bonus.parts && (
              <div className="scorer-question-parts">
                {model.bonus.parts.map((part, index) => (
                  // Parts have no persisted identity in QBJ; their position is their identity.

                  <div key={`part-${index}`} className="scorer-question-part">
                    <span>Part {index + 1}</span>
                    <input
                      aria-label={`Bonus part ${index + 1} controlled points`}
                      type="number"
                      value={bonusDrafts.parts[`${index}-controlledPoints`] ?? String(part.controlledPoints)}
                      onChange={(event) => updateBonusPart(index, 'controlledPoints', event.target.value)}
                    />
                    {format.bonus.bounceBack && (
                      <input
                        aria-label={`Bonus part ${index + 1} bounceback points`}
                        type="number"
                        value={bonusDrafts.parts[`${index}-bouncebackPoints`] ?? String(part.bouncebackPoints ?? 0)}
                        onChange={(event) => updateBonusPart(index, 'bouncebackPoints', event.target.value)}
                      />
                    )}
                  </div>
                ))}
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
        aria-controls={`question-${model.questionNumber}-context`}
        onClick={() => setShowMore((current) => !current)}
      >
        <span>More context</span>
        <span aria-hidden="true">{showMore ? '−' : '+'}</span>
      </button>
      {showMore && (
        <section
          id={`question-${model.questionNumber}-context`}
          className="scorer-question-more"
          aria-label="Additional context"
        >
          <p className="scorer-dialog-note">
            On the floor — {game.left.name}: {active.left.length > 0 ? active.left.join(', ') : 'none'};{' '}
            {game.right.name}: {active.right.length > 0 ? active.right.join(', ') : 'none'}.
          </p>
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
