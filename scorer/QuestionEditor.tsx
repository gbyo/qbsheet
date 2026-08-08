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
 * # Nothing here knows any format
 *
 * The rulings are `format.answerTypes`. The bonus buttons are `regularBonusTotals`. The number of
 * attempts a cycle may hold is the engine's, checked by `validateEditableQuestion`. There is no
 * +15, no −5, no 0/10/20/30 and no notion of which rule set this is.
 */
import { useMemo, useState } from 'react';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IDerivedGame } from '../scoring/deriveGame';
import {
  IEditableAttempt,
  IEditableBonus,
  IEditableQuestion,
  validateEditableQuestion,
} from '../scoring/questionCorrection';
import { bouncebackOptions, regularBonusTotals } from './bonusOptions';

/** "+15" / "−5". The sign is the fastest thing to read, so it is always shown. */
function rulingLabel(format: IScorekeeperFormat, index: number): string {
  const answerType = format.answerTypes[index];
  if (!answerType) return 'Choose…';
  if (answerType.shortLabel !== String(answerType.value)) return answerType.shortLabel;
  return answerType.value > 0 ? `+${answerType.value}` : String(answerType.value);
}

/**
 * The one control that says what the buzz was.
 *
 * A format's answer types, plus the wrong answer that costs nothing — which is a *ruling*, not a
 * kind of event, however it happens to be stored. Encoded as strings because a select's value is a
 * string and the alternative is two controls that have to agree with each other.
 */
const noPenaltyValue = 'no-penalty';

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

function syncBonus(bonus: IEditableBonus, parts: IEditableBonus['parts']): IEditableBonus {
  if (!parts) return { ...bonus, parts: undefined };
  return {
    ...bonus,
    parts: parts.map((part) => ({ ...part })),
    controlledPoints: parts.reduce((sum, part) => sum + part.controlledPoints, 0),
    bouncebackPoints: parts.reduce((sum, part) => sum + (part.bouncebackPoints ?? 0), 0),
  };
}

/** Which team, if any, this proposed cycle says converted the tossup. */
function conversionTeam(model: IEditableQuestion, format: IScorekeeperFormat): 'left' | 'right' | undefined {
  return model.attempts.find(
    (attempt) =>
      attempt.kind === 'buzz' &&
      attempt.answerTypeIndex !== undefined &&
      (format.answerTypes[attempt.answerTypeIndex]?.value ?? 0) > 0,
  )?.team;
}

export default function QuestionEditor(props: {
  game: IDerivedGame;
  format: IScorekeeperFormat;
  initial: IEditableQuestion;
  onSave: (question: IEditableQuestion) => boolean;
  onCancel: () => void;
  // eslint-disable-next-line react/require-default-props
  onOpenReplacement?: () => void;
}) {
  const { game, format, initial, onSave, onCancel, onOpenReplacement } = props;
  const [model, setModel] = useState<IEditableQuestion>(() => ({
    ...initial,
    attempts: initial.attempts.map((attempt) => ({ ...attempt })),
    bonus: initial.bonus ? { ...initial.bonus, parts: initial.bonus.parts?.map((part) => ({ ...part })) } : undefined,
  }));
  const [errors, setErrors] = useState<string[]>([]);
  const [showMore, setShowMore] = useState(false);
  const [showParts, setShowParts] = useState(() => initial.bonus?.parts !== undefined);

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
    updateAttempt(index, { kind: 'buzz', answerTypeIndex: Number(value) });
  };

  const addAttempt = () => {
    const team = model.attempts.some((attempt) => attempt.team === 'left') ? 'right' : 'left';
    setModel((current) => ({
      ...current,
      attempts: current.attempts.concat({
        kind: 'buzz',
        team,
        playerName: teamPlayers[team][0] ?? firstActive(game, team),
        answerTypeIndex: defaultAnswerType(format),
      }),
    }));
  };

  const setBonus = (next: Partial<IEditableBonus>) => {
    setModel((current) => {
      const existing = current.bonus ?? { team: 'left' as const, controlledPoints: 0, bouncebackPoints: 0 };
      return { ...current, bonus: { ...existing, ...next } };
    });
  };

  const save = () => {
    const nextErrors = validateEditableQuestion(format, game, model);
    setErrors(nextErrors);
    if (nextErrors.length === 0 && onSave(model)) onCancel();
  };

  const converted = conversionTeam(model, format);
  const bonusTeam = model.bonus?.team ?? converted;

  return (
    <div className="scorer-question-editor">
      <h3 className="scorer-question-title">Question {model.questionNumber}</h3>
      <div className="scorer-detail-rows">
        <div className="scorer-detail-row">
          <span className="scorer-detail-label">Score before</span>
          <span className="scorer-detail-value">
            {game.left.name} {scoreBefore.left} · {game.right.name} {scoreBefore.right}
          </span>
        </div>
        <div className="scorer-detail-row">
          <span className="scorer-detail-label">Score after</span>
          <span className="scorer-detail-value">
            {game.left.name} {scoreAfter.left} · {game.right.name} {scoreAfter.right}
          </span>
        </div>
      </div>

      <section className="scorer-question-section" aria-label="Tossup attempts">
        <h4 className="scorer-question-heading">Tossup</h4>
        <ol className="scorer-question-attempts">
          {model.attempts.map((attempt, index) => (
            // Attempts have no persisted identity until they are written; position is identity.
            // eslint-disable-next-line react/no-array-index-key
            <li key={attempt.id ?? `attempt-${index}`} className="scorer-question-attempt">
              <span className="scorer-question-attempt-number">{index + 1}</span>
              <select
                aria-label={`Question ${model.questionNumber} attempt ${index + 1} team`}
                value={attempt.team}
                onChange={(event) => updateAttempt(index, { team: event.target.value as 'left' | 'right' })}
              >
                <option value="left">{game.left.name}</option>
                <option value="right">{game.right.name}</option>
              </select>
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
              <select
                aria-label={
                  model.attempts.length === 1
                    ? 'Ruling'
                    : `Question ${model.questionNumber} attempt ${index + 1} ruling`
                }
                value={rulingValue(attempt)}
                onChange={(event) => setRuling(index, event.target.value)}
              >
                {format.answerTypes.map((answerType) => (
                  <option key={answerType.index} value={answerType.index}>
                    {rulingLabel(format, answerType.index)}
                  </option>
                ))}
                {/* An answer that was simply wrong: it spends the team's chance and scores nothing. */}
                <option value={noPenaltyValue}>Wrong · 0</option>
              </select>
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
        <div className="scorer-question-actions">
          <button type="button" className="scorer-action" onClick={addAttempt} disabled={model.attempts.length >= 2}>
            + Add attempt
          </button>
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
          <label className="scorer-checkbox" htmlFor={`question-${model.questionNumber}-dead`}>
            <input
              id={`question-${model.questionNumber}-dead`}
              type="checkbox"
              checked={model.dead}
              onChange={(event) => setModel((current) => ({ ...current, dead: event.target.checked }))}
            />
            No buzz
          </label>
        </div>
      </section>

      <section className="scorer-question-section" aria-label="Bonus correction">
        <div className="scorer-question-section-head">
          <h4 className="scorer-question-heading">
            Bonus{bonusTeam ? ` — ${teamName(bonusTeam).toLocaleUpperCase()}` : ''}
          </h4>
          {model.bonus ? (
            <button
              type="button"
              className="scorer-text-action is-destructive"
              onClick={() => setModel((current) => ({ ...current, bonus: undefined }))}
            >
              Remove bonus
            </button>
          ) : (
            /*
             * Offered rather than drawn. A question with no bonus is most of them, and a blank
             * bonus form filling the dialog for every one of those is what buried the tossup line.
             * A correction that turns a neg into a conversion needs the bonus, and this is it.
             */
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
                  value={model.bonus.controlledPoints}
                  disabled={showParts}
                  onChange={(event) => setBonus({ controlledPoints: Number(event.target.value), parts: undefined })}
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
                {showParts ? 'Use total' : 'Enter parts…'}
              </button>
            )}
            {showParts && model.bonus.parts && (
              <div className="scorer-question-parts">
                {model.bonus.parts.map((part, index) => (
                  // Parts have no persisted identity in QBJ; their position is their identity.
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={`part-${index}`} className="scorer-question-part">
                    <span>Part {index + 1}</span>
                    <input
                      aria-label={`Bonus part ${index + 1} controlled points`}
                      type="number"
                      value={part.controlledPoints}
                      onChange={(event) => {
                        const parts = model.bonus?.parts?.map((current, partIndex) =>
                          partIndex === index ? { ...current, controlledPoints: Number(event.target.value) } : current,
                        );
                        if (model.bonus && parts) {
                          const { bonus } = model;
                          setModel((current) => ({ ...current, bonus: syncBonus(bonus, parts) }));
                        }
                      }}
                    />
                    {format.bonus.bounceBack && (
                      <input
                        aria-label={`Bonus part ${index + 1} bounceback points`}
                        type="number"
                        value={part.bouncebackPoints ?? 0}
                        onChange={(event) => {
                          const parts = model.bonus?.parts?.map((current, partIndex) =>
                            partIndex === index
                              ? { ...current, bouncebackPoints: Number(event.target.value) }
                              : current,
                          );
                          if (model.bonus && parts) {
                            const { bonus } = model;
                            setModel((current) => ({ ...current, bonus: syncBonus(bonus, parts) }));
                          }
                        }}
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
      <button type="button" className="scorer-text-action" onClick={() => setShowMore((current) => !current)}>
        {showMore ? 'Less…' : 'More…'}
      </button>
      {showMore && (
        <section className="scorer-question-more" aria-label="Question detail">
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
              Replace question…
            </button>
          )}
        </section>
      )}

      {errors.map((error) => (
        <p key={error} className="scorer-problem">
          {error}
        </p>
      ))}
      <div className="scorer-complete-actions">
        <button type="button" className="scorer-action" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="scorer-submit" onClick={save}>
          Save correction
        </button>
      </div>
    </div>
  );
}
