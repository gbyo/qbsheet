/**
 * Projects a scored game onto the QBJ Match that YellowFruit imports.
 *
 * # Which layer actually counts
 *
 * QBJ describes a match twice over. There are aggregates — a team's `points`, each player's
 * `tossups_heard` and `answer_counts`, the lightning and bounceback totals — and there is
 * `match_questions`, a question-by-question record of every buzz and bonus part.
 *
 * Only the aggregates are read. `FileParser.parseMatch` gates `match_questions` behind
 * `Tournament.useQuestionLevelData`, which is a `readonly false` with a comment saying it stays that
 * way until there are features that use it. So YellowFruit writes the per-question layer and never
 * parses it back, and a game imported today is exactly its aggregates.
 *
 * That decides the contract here: the aggregates are what has to be right. `match_questions` is
 * emitted anyway, because it is valid QBJ that other tools do read, it is what a future YellowFruit
 * would switch on, and it costs nothing to be honest about what happened. But nothing depends on it,
 * and no correctness claim rests on it.
 *
 * # Why snake_case
 *
 * `MatchImportService` runs `snakeCaseToCamelCase` over the parsed JSON, which maps each known snake
 * key onto its camel equivalent and then deletes the snake one. A payload that arrives already in
 * camelCase gets overwritten with `undefined` — which is exactly the bug `fixLightningPointsConversion`
 * exists to repair for old files that wrote `lightningPoints`. Emitting snake_case is not a style
 * choice.
 *
 * # Overtime
 *
 * Standard QBJ carries overtime only as `correct_tossups_without_bonuses`, which YellowFruit
 * computes on the way out and does not read on the way in. The detail lives in `YfData.overTimeBuzzes`,
 * YellowFruit's own documented extension, which `parseMatchTeam` does read. Emitting it is what makes
 * an overtime game survive the trip; MODAQ's export loses it.
 */
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { protestNoteLine, unresolvedProtestMarker } from '../../renderer/Services/ProtestNotes';
import { IDerivedGame, IDerivedTeam } from './deriveGame';
import { ProtestSubject } from './ScoreEvents';

/** Everything about the game that isn't scoring. */
export interface IQbjMatchMeta {
  /** Round number, carried the way MODAQ's exports carry it. */
  round?: number;
  /** Room name. Becomes `Match.location`. */
  location?: string;
  moderator?: string;
  scorekeeper?: string;
  /** Free-text notes. The scorer's flagged questions are appended to whatever is passed. */
  notes?: string;
}

/** A QBJ object keyed however the schema keys it. Deliberately loose: this is wire format. */
type QbjObject = Record<string, unknown>;

/**
 * Answer counts for one player, as `[{number, answer_type: {value}}]`.
 *
 * Answer types are referenced by value rather than by id. `resolveAnswerTypeIdentity` tries an id
 * lookup first and falls back to matching on value, and value is the identity that actually travels:
 * `AnswerType.id` is derived from a label that a room and a desktop need not agree on.
 *
 * Zero counts are dropped. They carry no information, and `dropZero` discards them on the way in.
 */
function answerCounts(format: IScorekeeperFormat, counts: Map<number, number>): QbjObject[] {
  const entries: QbjObject[] = [];
  // Emit in the format's own order — powers first, negs last — rather than in insertion order.
  for (const answerType of format.answerTypes) {
    const number = counts.get(answerType.index) ?? 0;
    if (number === 0) continue;
    entries.push({ number, answer_type: { value: answerType.value } });
  }
  return entries;
}

function matchTeam(format: IScorekeeperFormat, team: IDerivedTeam): QbjObject {
  const overtimeBuzzes = answerCounts(format, team.overtimeBuzzes);

  const qbjTeam: QbjObject = {
    team: { name: team.name },
    forfeit_loss: team.forfeited,
    points: team.points,
    bonus_bounceback_points: team.bonusBouncebackPoints,
    lightning_points: team.lightningPoints,
    // Tossups converted with no bonus after them, which in YellowFruit means overtime.
    correct_tossups_without_bonuses: countCorrectOvertimeBuzzes(format, team),
    match_players: team.players
      // A player who never came off the bench is not part of this game's record.
      .filter((player) => player.tossupsHeard > 0 || player.answerCounts.size > 0)
      .map((player) => ({
        player: { name: player.name },
        tossups_heard: player.tossupsHeard,
        answer_counts: answerCounts(format, player.answerCounts),
      })),
  };

  // YellowFruit's own extension, and the only route by which overtime detail survives an import.
  if (overtimeBuzzes.length > 0) {
    qbjTeam.YfData = { overTimeBuzzes: overtimeBuzzes };
  }

  return qbjTeam;
}

/** Overtime tossups this team converted, per `MatchTeam.getCorrectTossupsWithoutBonuses`. */
function countCorrectOvertimeBuzzes(format: IScorekeeperFormat, team: IDerivedTeam): number {
  let total = 0;
  for (const [index, count] of team.overtimeBuzzes) {
    const answerType = format.answerTypes[index];
    if (answerType && answerType.value > 0) total += count;
  }
  return total;
}

/**
 * The per-question record.
 *
 * Shaped to `MatchQuestion`: buzzes carrying team, player and answer type, and a bonus carrying
 * either parts or flat totals.
 *
 * A zero-point wrong answer is emitted as a buzz worth nothing, which is what it is. That is honest
 * QBJ — the schema's `result` is a value, and zero is a value a real rule set uses — and it is safe
 * here in a way it would not be in the aggregates: `answer_counts` never sees it, so no player gains
 * a phantom tossup in any statistic YellowFruit reads.
 */
function matchQuestions(game: IDerivedGame, teamNames: Record<LeftOrRight, string>): QbjObject[] {
  return game.questions.map((question) => {
    const buzzes: QbjObject[] = question.buzzes.map((buzz) => ({
      team: { name: teamNames[buzz.team] },
      player: { name: buzz.playerName },
      result: { value: buzz.answerType.value },
    }));
    for (const missed of question.noPenalty) {
      buzzes.push({
        team: { name: teamNames[missed.team] },
        ...(missed.playerName ? { player: { name: missed.playerName } } : {}),
        result: { value: 0 },
      });
    }

    const qbjQuestion: QbjObject = { question_number: question.questionNumber, buzzes };
    if (question.replaced) {
      /*
       * QBJ carries the question's role on the `Question` a `MatchQuestion` points at, not as a flag
       * on the cycle, and `replacement` is one of the roles it enumerates. Emitting it that way is
       * valid QBJ rather than an invented key; the human-readable version of the same fact is in
       * `notes`, which is the layer YellowFruit actually reads.
       */
      qbjQuestion.tossup_question = { type: 'replacement' };
    }
    if (question.bonus) {
      qbjQuestion.bonus_points = question.bonus.controlledPoints;
      if (question.bonus.bouncebackPoints > 0) {
        qbjQuestion.bonus_bounceback_points = question.bonus.bouncebackPoints;
      }
      // Parts are emitted only when the scorekeeper actually collected them. A bonus entered as a
      // total has no parts, and splitting 20 into two tens would be inventing which parts were got.
      if (question.bonus.parts) {
        qbjQuestion.bonus = {
          parts: question.bonus.parts.map((part) => ({
            controlled_points: part.controlledPoints,
            ...(part.bouncebackPoints ? { bounceback_points: part.bouncebackPoints } : {}),
          })),
        };
      }
    }
    return qbjQuestion;
  });
}

const protestSubjectText: Record<ProtestSubject, string> = {
  'tossup-answer': 'Tossup answer',
  'bonus-answer': 'Bonus answer',
  question: 'The question',
  procedure: 'Procedure',
  other: 'Other',
};

/** How a protest reads on a result somebody has to act on. See `ProtestNotes`. */
function protestLine(protest: IDerivedGame['protests'][number]): string {
  return protestNoteLine({
    questionNumber: protest.questionNumber,
    teamName: protest.teamName,
    status: protest.status === 'open' ? unresolvedProtestMarker : protest.status,
    subject: protestSubjectText[protest.subject],
    description: protest.description,
    resolution: protest.resolution,
  });
}

/**
 * Notes plus everything a result's reader has to be told about, as one block of text.
 *
 * `Match.notes` is the only free-text channel the aggregates layer has, so an unresolved protest, a
 * replaced question and a game that was deliberately cut short all have to arrive through it. Open
 * protests come first: they are the one thing here that can stop a result being accepted.
 */
function combineNotes(game: IDerivedGame, meta: IQbjMatchMeta): string | undefined {
  const lines: string[] = [];
  if (meta.notes) lines.push(meta.notes);

  for (const protest of game.protests.filter((entry) => entry.status === 'open')) lines.push(protestLine(protest));
  for (const protest of game.protests.filter((entry) => entry.status !== 'open')) lines.push(protestLine(protest));

  if (game.endedEarly) {
    lines.push(`Game ended early after ${game.endedEarly.tossupsRead} tossups: ${game.endedEarly.reason}`);
  }
  for (const voided of game.voids) {
    const what = voided.scope === 'bonus' ? 'bonus' : 'tossup';
    lines.push(`Q${voided.questionNumber} ${what} replaced: ${voided.reason}`);
  }
  for (const note of game.notes) {
    const prefix = note.flagged ? `Q${note.questionNumber} flagged` : `Q${note.questionNumber}`;
    lines.push(`${prefix}: ${note.text}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Build the QBJ Match for a scored game.
 *
 * Safe to call on a game in progress: the aggregates describe whatever has been recorded so far, so
 * a partial export is a valid description of a partial game rather than a broken one.
 */
export default function toQbjMatch(
  format: IScorekeeperFormat,
  game: IDerivedGame,
  meta: IQbjMatchMeta = {},
): QbjObject {
  const teamNames: Record<LeftOrRight, string> = { left: game.left.name, right: game.right.name };
  const forfeit = game.left.forfeited || game.right.forfeited;

  const qbjMatch: QbjObject = {
    // A forfeit has no questions. FileParser clears tossupsRead for one anyway; not emitting it
    // keeps the payload from claiming something the game did not do.
    tossups_read: forfeit ? undefined : game.tossupsRead,
    overtime_tossups_read: forfeit || game.overtimeTossupsRead === 0 ? undefined : game.overtimeTossupsRead,
    location: meta.location,
    moderator: meta.moderator,
    scorekeeper: meta.scorekeeper,
    notes: combineNotes(game, meta),
    match_teams: [matchTeam(format, game.left), matchTeam(format, game.right)],
    match_questions: forfeit ? undefined : matchQuestions(game, teamNames),
  };

  // MODAQ's exports carry the round in a non-standard `_round`, and YellowFruit reads it. Matching
  // that keeps a room's payload interchangeable with a MODAQ one.
  if (meta.round !== undefined) qbjMatch._round = meta.round;

  // Drop undefined keys so the payload says only what it means. JSON.stringify would do this, but
  // callers inspect the object directly too.
  for (const key of Object.keys(qbjMatch)) {
    if (qbjMatch[key] === undefined) delete qbjMatch[key];
  }
  return qbjMatch;
}
