/**
 * The paper copy.
 *
 * # What this is for
 *
 * Everything else about QBSheet assumes the device keeps working. It survives losing the network, it
 * survives losing the server, it survives the tab being closed and the browser being reloaded — and
 * none of that helps a room whose Chromebook has run out of battery in a gym with no free outlet.
 * That room needs the morning on paper, and until now the application had no `@media print` rule at
 * all: printing produced the scoresheet interface, buttons and menus included, across several pages.
 *
 * So this is a second rendering of the same derived game, present in the DOM but shown only to a
 * printer. It is deliberately not a dialog and not a screen: a scorekeeper who needs this needs it
 * in one action, and any flow that involves navigating somewhere first is a flow that ends with
 * somebody hunting through a menu while a moderator waits.
 *
 * # Why it prints the whole game rather than the current screen
 *
 * Two different rooms want two different things from a print, and they are the same document:
 *
 *   - The room whose device just died wants what has been scored so far, so the rest can be kept by
 *     hand. That needs the question-by-question history and the blank continuation rows below it.
 *   - The room settling an argument at half wants the box score. That needs the per-player table.
 *
 * Both are here, in that order, because the first one is the emergency.
 *
 * # Derived, never stored
 *
 * Everything below comes from `IDerivedGame`. Nothing here reads storage, and nothing here can
 * disagree with the screen, because it is the same object the scoresheet is drawn from.
 *
 * # Why it is a portal
 *
 * `print.css` hides the application with a single rule on `#root`, rather than by listing every
 * control that must not reach paper — a list nobody would remember to add to, whose failure mode is
 * a stray button printed across a scoresheet in a hallway six months from now.
 *
 * That rule only works if this document is not inside `#root`, because `display: none` on an
 * ancestor cannot be undone by a descendant. So it renders into `document.body` as a sibling of the
 * application. It stays a child of the scorer in the React tree, which is what keeps it fed by the
 * same `IDerivedGame` the screen is drawn from.
 */
import { createPortal } from 'react-dom';
import { procedureExceptionLine } from '../scoring/ProcedureExceptions';
import { IDerivedGame, IDerivedQuestion } from '../scoring/deriveGame';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { LeftOrRight } from '../scoring/types';
import { DisplaySideMapping, identityDisplaySideMapping } from './DisplaySideMapping';

/**
 * How many blank rows follow the last recorded question.
 *
 * Enough to finish an ordinary game by hand from about the halfway point, which is when a battery
 * tends to go. Cheap: they cost part of one sheet, and a room that runs out of rows has a pen.
 */
export const continuationRows = 12;

/** One team's answer on a question, as a scoresheet cell: `Alex 15`. */
function cell(question: IDerivedQuestion, team: LeftOrRight): string {
  const buzz = question.buzzes.find((candidate) => candidate.team === team);
  if (buzz) return `${buzz.playerName} ${buzz.answerType.value > 0 ? '+' : ''}${buzz.answerType.value}`;
  const passed = question.noPenalty.find((candidate) => candidate.team === team);
  if (passed) return passed.playerName ? `${passed.playerName} 0` : '0';
  return '';
}

/** The bonus cell: what the controlling team earned, and what bounced back. */
function bonusCell(question: IDerivedQuestion, team: LeftOrRight): string {
  if (!question.bonus) return '';
  if (question.bonus.team === team) return String(question.bonus.controlledPoints);
  return question.bonus.bouncebackPoints > 0 ? `${question.bonus.bouncebackPoints} (BB)` : '';
}

export default function PrintableScoresheet(props: {
  game: IDerivedGame;
  format: IScorekeeperFormat;
  tournamentName: string;
  roundName: string;
  roomName?: string;
  packetName?: string;
  operatorName?: string;
  /** Optional screen order; QBJ and result data remain canonical. */
  displaySides?: DisplaySideMapping;
  /** Injected by tests so the printed date is stable. */
  now?: Date;
}) {
  const {
    game,
    format,
    tournamentName,
    roundName,
    roomName,
    packetName,
    operatorName,
    displaySides = identityDisplaySideMapping,
    now = new Date(),
  } = props;

  /*
   * Running totals, accumulated down the page the way somebody keeping it by hand would, so a room
   * taking over on paper knows the score at the row it takes over on.
   *
   * Tossups and bonuses only. Lightning rounds and score adjustments belong to the game rather than
   * to any question, so there is no row they could honestly be added on -- which is why this column
   * is headed `TU+B` and the true score is stated once, above the table, from `game.*.points`.
   */
  const questionPoints = (question: IDerivedQuestion, team: LeftOrRight): number => {
    const buzz = question.buzzes.find((candidate) => candidate.team === team)?.answerType.value ?? 0;
    if (!question.bonus) return buzz;
    return (
      buzz +
      (question.bonus.team === team ? question.bonus.controlledPoints : question.bonus.bouncebackPoints)
    );
  };
  const rows = game.questions.reduce<{ question: IDerivedQuestion; left: number; right: number }[]>(
    (accumulated, question) => {
      const previous = accumulated[accumulated.length - 1];
      accumulated.push({
        question,
        left: (previous?.left ?? 0) + questionPoints(question, 'left'),
        right: (previous?.right ?? 0) + questionPoints(question, 'right'),
      });
      return accumulated;
    },
    [],
  );

  const answerTypeLegend = format.answerTypes.map((type) => `${type.shortLabel} = ${type.value}`).join(' · ');

  /*
   * The cycle the device's copy stops at, which is not the same as how many rows are above.
   *
   * A voided question leaves a gap, so `questions.length` and the last question number diverge, and
   * a continuation numbered from the count would hand somebody a sheet whose row 15 is the game's
   * question 16. The last entry's own number is the only honest place to carry on from.
   */
  const lastQuestionNumber = game.questions[game.questions.length - 1]?.questionNumber ?? 0;

  // No document to portal into. Only reachable from a non-browser renderer; the scoresheet itself
  // still works, and there is nothing to print in that context anyway.
  if (typeof document === 'undefined') return null;

  return createPortal(
    /*
     * `aria-hidden` and not in the tab order. On screen this is `display: none`, but a screen reader
     * does not read the stylesheet -- without this it would announce the entire game a second time,
     * immediately after the scoresheet it is a copy of.
     */
    <div className="printable-scoresheet" aria-hidden="true">
      <header className="printable-header">
        <h1 className="printable-title">
          {game[displaySides.left].name} vs {game[displaySides.right].name}
        </h1>
        <p className="printable-meta">
          {[tournamentName, roundName, roomName, packetName ? `Packet ${packetName}` : undefined]
            .filter((part) => part !== undefined && part !== '')
            .join(' · ')}
        </p>
        <p className="printable-meta">
          {operatorName ? `Scorekeeper: ${operatorName} · ` : ''}
          Printed {now.toLocaleString()}
        </p>
      </header>

      <p className="printable-score">
        {game[displaySides.left].name} <strong>{game[displaySides.left].points}</strong> ·{' '}
        {game[displaySides.right].name} <strong>{game[displaySides.right].points}</strong>
        {game.tossupsRead > 0 ? ` · after ${game.tossupsRead} tossups` : ''}
      </p>

      <table className="printable-table">
        <caption>Question by question</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{game[displaySides.left].name}</th>
            <th scope="col">Bonus</th>
            <th scope="col">{game[displaySides.right].name}</th>
            <th scope="col">Bonus</th>
            <th scope="col">TU+B</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ question, left, right }) => {
            const displayedLeft = displaySides.left === 'left' ? left : right;
            const displayedRight = displaySides.right === 'left' ? left : right;
            return (
              <tr key={question.questionNumber}>
                <th scope="row">
                  {question.questionNumber}
                  {question.period === 'overtime' ? ' OT' : ''}
                </th>
                <td>{cell(question, displaySides.left)}</td>
                <td>{bonusCell(question, displaySides.left)}</td>
                <td>{cell(question, displaySides.right)}</td>
                <td>{bonusCell(question, displaySides.right)}</td>
                {/* Slash-separated rather than the en dash a score line would normally take: a running
                  total can legitimately be negative, and `45–-5` is not a score anybody can read. */}
                <td>
                  {displayedLeft} / {displayedRight}
                </td>
              </tr>
            );
          })}
          {/* Ruled, empty, and the reason this document is worth printing before anything goes wrong. */}
          {Array.from({ length: continuationRows }, (_unused, offset) => (
            <tr key={`blank-${offset}`} className="printable-blank">
              <th scope="row">{lastQuestionNumber + offset + 1}</th>
              <td />
              <td />
              <td />
              <td />
              <td />
            </tr>
          ))}
        </tbody>
      </table>

      <p className="printable-legend">{answerTypeLegend}</p>

      {/* Keyed by side, not by name. Two teams can arrive with the same name -- a scrimmage between
          two squads from one school, a placeholder typed twice -- and duplicate React keys silently
          drop one of the two box scores. */}
      {(
        [
          { side: 'left', team: game[displaySides.left] },
          { side: 'right', team: game[displaySides.right] },
        ] as const
      ).map(({ side, team }) => (
        <table className="printable-table" key={side}>
          <caption>{team.name}</caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">TUH</th>
              {format.answerTypes.map((type) => (
                <th scope="col" key={type.index}>
                  {type.shortLabel}
                </th>
              ))}
              <th scope="col">Pts</th>
            </tr>
          </thead>
          <tbody>
            {team.players.map((player) => (
              <tr key={player.name}>
                <th scope="row">{player.name}</th>
                <td>{player.tossupsHeard}</td>
                {format.answerTypes.map((type) => (
                  <td key={type.index}>{player.answerCounts.get(type.index) ?? 0}</td>
                ))}
                <td>{player.points}</td>
              </tr>
            ))}
            <tr className="printable-total">
              <th scope="row">Total</th>
              <td />
              {format.answerTypes.map((type) => (
                <td key={type.index} />
              ))}
              <td>{team.points}</td>
            </tr>
          </tbody>
        </table>
      ))}

      {(game.notes.length > 0 || game.procedureExceptions.length > 0) && (
        <section className="printable-notes">
          <h2>Notes</h2>
          <ul>
            {/*
              A ruling that let the room do something its procedure does not is exactly the thing a
              director asks about afterwards, so it belongs on the sheet that gets handed over rather
              than only in the file. Same sentence as everywhere else; see `ProcedureExceptions`.
            */}
            {game.procedureExceptions.map((exception) => (
              <li key={exception.eventId}>{procedureExceptionLine(exception)}</li>
            ))}
            {game.notes.map((note, index) => (
              <li key={`${note.questionNumber}-${note.text}-${index}`}>
                Q{note.questionNumber}: {note.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="printable-footer">
        Scored in QBSheet. If this game is finished on paper, give this sheet to the tournament director — the
        device’s copy stops at question {lastQuestionNumber}.
      </p>
    </div>,
    document.body,
  );
}
