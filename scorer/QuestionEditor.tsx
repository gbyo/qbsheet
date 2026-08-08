import { useMemo, useState } from 'react';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IDerivedGame } from '../scoring/deriveGame';
import {
  IEditableAttempt,
  IEditableBonus,
  IEditableQuestion,
  conversion,
  validateEditableQuestion,
} from '../scoring/questionCorrection';

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
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

interface IBonusDrafts {
  controlled?: string;
  bounceback?: string;
  parts: Record<string, string>;
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
  const [bonusDrafts, setBonusDrafts] = useState<IBonusDrafts>({ parts: {} });
  const question = game.questions.find((candidate) => candidate.questionNumber === model.questionNumber);
  const before = question?.scoreAfter ?? { left: game.left.points, right: game.right.points };
  const previous = game.questions.find((candidate) => candidate.questionNumber === model.questionNumber - 1);
  const scoreBefore = previous?.scoreAfter ?? { left: 0, right: 0 };
  const active = question?.activePlayers ?? { left: [], right: [] };
  const questionProtests = game.protests.filter((protest) => protest.questionNumber === model.questionNumber);
  const questionFlags = game.notes.filter((note) => note.questionNumber === model.questionNumber && note.flagged);

  const teamPlayers = useMemo(() => ({ left: active.left, right: active.right }), [active.left, active.right]);

  const updateAttempt = (index: number, next: Partial<IEditableAttempt>) => {
    setModel((current) => ({
      ...current,
      attempts: current.attempts.map((attempt, attemptIndex) => {
        if (attemptIndex !== index) return attempt;
        const updated = { ...attempt, ...next };
        if (next.team !== undefined && !teamPlayers[next.team].includes(updated.playerName ?? '')) {
          updated.playerName = teamPlayers[next.team][0] ?? '';
        }
        if (next.kind === 'no-penalty') updated.answerTypeIndex = undefined;
        if (next.kind === 'buzz' && updated.answerTypeIndex === undefined)
          updated.answerTypeIndex = defaultAnswerType(format);
        return updated;
      }),
    }));
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
    setBonusDrafts({ parts: {} });
    setModel((current) => {
      const existing = current.bonus ?? {
        team: 'left' as const,
        controlledPoints: 0,
        bouncebackPoints: 0,
      };
      return { ...current, bonus: { ...existing, ...next } };
    });
  };

  const updateBonusTotal = (field: 'controlledPoints' | 'bouncebackPoints', raw: string) => {
    setBonusDrafts((current) => ({ ...current, [field === 'controlledPoints' ? 'controlled' : 'bounceback']: raw }));
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    setBonus({ [field]: parsed, parts: undefined });
  };

  const updateBonusPart = (index: number, field: 'controlledPoints' | 'bouncebackPoints', raw: string) => {
    const key = `${index}-${field}`;
    setBonusDrafts((current) => ({ ...current, parts: { ...current.parts, [key]: raw } }));
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

  return (
    <div className="scorer-question-editor">
      <p className="scorer-dialog-note">
        Edit the complete Question {model.questionNumber}. The correction is checked as one unit and later scores are
        derived again.
      </p>
      <p className="scorer-question-scoreline">
        Before {scoreBefore.left}&ndash;{scoreBefore.right} · After {before.left}&ndash;{before.right}
      </p>
      <p className="scorer-dialog-note">
        Active players:{' '}
        {active.left.length > 0 ? `${game.left.name}: ${active.left.join(', ')}` : `${game.left.name}: none`};{' '}
        {active.right.length > 0 ? `${game.right.name}: ${active.right.join(', ')}` : `${game.right.name}: none`}.
      </p>
      {(questionProtests.length > 0 || questionFlags.length > 0) && (
        <section className="scorer-question-flags" aria-label="Question flags and protests">
          <strong>Question flags and protests</strong>
          {questionProtests.map((protest) => (
            <p key={protest.eventId}>
              Protest ({protest.status}) — {protest.description}
              {protest.resolution ? ` · ${protest.resolution}` : ''}
            </p>
          ))}
          {questionFlags.map((note) => (
            <p key={`${note.questionNumber}-${note.text}`}>Flagged note — {note.text}</p>
          ))}
        </section>
      )}
      {onOpenReplacement && (
        <button type="button" className="scorer-action" onClick={onOpenReplacement}>
          Replace question…
        </button>
      )}

      <section className="scorer-question-section" aria-label="Tossup attempts">
        <h3>Tossup attempts</h3>
        <ol className="scorer-question-attempts">
          {model.attempts.map((attempt, index) => {
            const players = teamPlayers[attempt.team];
            return (
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
                  aria-label={`Question ${model.questionNumber} attempt ${index + 1} ruling`}
                  value={attempt.kind}
                  onChange={(event) => updateAttempt(index, { kind: event.target.value as IEditableAttempt['kind'] })}
                >
                  <option value="buzz">Buzz / ruling</option>
                  <option value="no-penalty">Wrong answer · 0</option>
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
                  {players.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                {attempt.kind === 'buzz' && (
                  <select
                    aria-label={
                      model.attempts.length === 1
                        ? 'Ruling'
                        : `Question ${model.questionNumber} attempt ${index + 1} answer type`
                    }
                    value={String(attempt.answerTypeIndex ?? defaultAnswerType(format))}
                    onChange={(event) => updateAttempt(index, { answerTypeIndex: Number(event.target.value) })}
                  >
                    {format.answerTypes.map((answerType) => (
                      <option key={answerType.index} value={answerType.index}>
                        {signed(answerType.value)}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="scorer-text-action"
                  disabled={index === 0}
                  onClick={() =>
                    setModel((current) => {
                      const attempts = current.attempts.slice();
                      [attempts[index - 1], attempts[index]] = [attempts[index], attempts[index - 1]];
                      return { ...current, attempts };
                    })
                  }
                  aria-label={`Move attempt ${index + 1} earlier`}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="scorer-text-action"
                  disabled={index === model.attempts.length - 1}
                  onClick={() =>
                    setModel((current) => {
                      const attempts = current.attempts.slice();
                      [attempts[index], attempts[index + 1]] = [attempts[index + 1], attempts[index]];
                      return { ...current, attempts };
                    })
                  }
                  aria-label={`Move attempt ${index + 1} later`}
                >
                  Down
                </button>
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
            );
          })}
        </ol>
        <div className="scorer-question-actions">
          <button type="button" className="scorer-action" onClick={addAttempt} disabled={model.attempts.length >= 2}>
            Add attempt
          </button>
          <label className="scorer-checkbox" htmlFor={`question-${model.questionNumber}-dead`}>
            <input
              id={`question-${model.questionNumber}-dead`}
              type="checkbox"
              checked={model.dead}
              onChange={(event) => setModel((current) => ({ ...current, dead: event.target.checked }))}
            />
            No buzz / tossup dead
          </label>
        </div>
      </section>

      <section className="scorer-question-section" aria-label="Bonus correction">
        <div className="scorer-question-section-head">
          <h3>Bonus</h3>
          {model.bonus ? (
            <button
              type="button"
              className="scorer-text-action is-destructive"
              onClick={() => setModel((current) => ({ ...current, bonus: undefined }))}
            >
              Remove bonus
            </button>
          ) : (
            <button
              type="button"
              className="scorer-action"
              onClick={() => setBonus({ team: conversionTeam(model, format) ?? 'left' })}
            >
              Add bonus
            </button>
          )}
        </div>
        {model.bonus && (
          <div className="scorer-question-bonus">
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
            <label htmlFor={`question-${model.questionNumber}-bonus-controlled`}>
              Controlled points
              <input
                id={`question-${model.questionNumber}-bonus-controlled`}
                aria-label="Points"
                type="number"
                value={bonusDrafts.controlled ?? String(model.bonus.controlledPoints)}
                onChange={(event) => updateBonusTotal('controlledPoints', event.target.value)}
              />
            </label>
            <label htmlFor={`question-${model.questionNumber}-bonus-bounceback`}>
              Bounceback points
              <input
                id={`question-${model.questionNumber}-bonus-bounceback`}
                aria-label="Bonus bounceback points"
                type="number"
                value={bonusDrafts.bounceback ?? String(model.bonus.bouncebackPoints)}
                disabled={!format.bonus.bounceBack}
                onChange={(event) => updateBonusTotal('bouncebackPoints', event.target.value)}
              />
            </label>
            {format.bonus.regular && (
              <div className="scorer-question-parts">
                <div className="scorer-question-section-head">
                  <span>Parts</span>
                  {model.bonus.parts ? (
                    <button type="button" className="scorer-text-action" onClick={() => setBonus({ parts: undefined })}>
                      Use total
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="scorer-text-action"
                      onClick={() => setBonus({ parts: defaultParts(format) })}
                    >
                      Enter parts
                    </button>
                  )}
                </div>
                {model.bonus.parts?.map((part, index) => (
                  // Parts have no persisted identity in QBJ; their position is their identity.
                  // eslint-disable-next-line react/no-array-index-key
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

      {errors.map((error) => (
        <p key={error} className="scorer-problem">
          {error}
        </p>
      ))}
      <div className="scorer-complete-actions">
        <button type="button" className="scorer-submit" onClick={save}>
          Save correction
        </button>
        <button type="button" className="scorer-action" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function conversionTeam(model: IEditableQuestion, format: IScorekeeperFormat): 'left' | 'right' | undefined {
  return conversion(model, format)?.team;
}
