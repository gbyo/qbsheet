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
import { IDerivedGame, IDerivedTeam } from './deriveGame';

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
 * either parts or flat totals. Bonuses are emitted as totals here because that is what the derived
 * game holds — a bonus entered part by part has already been summed, and re-splitting it into parts
 * would be inventing detail the scorer did not record.
 */
function matchQuestions(game: IDerivedGame, teamNames: Record<LeftOrRight, string>): QbjObject[] {
  return game.questions.map((question) => {
    const qbjQuestion: QbjObject = {
      question_number: question.questionNumber,
      buzzes: question.buzzes.map((buzz) => ({
        team: { name: teamNames[buzz.team] },
        player: { name: buzz.playerName },
        result: { value: buzz.answerType.value },
      })),
    };
    if (question.bonus) {
      qbjQuestion.bonus_points = question.bonus.controlledPoints;
      if (question.bonus.bouncebackPoints > 0) {
        qbjQuestion.bonus_bounceback_points = question.bonus.bouncebackPoints;
      }
    }
    return qbjQuestion;
  });
}

/** Notes plus anything the scorekeeper flagged, as one block of text. */
function combineNotes(game: IDerivedGame, meta: IQbjMatchMeta): string | undefined {
  const lines: string[] = [];
  if (meta.notes) lines.push(meta.notes);
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
