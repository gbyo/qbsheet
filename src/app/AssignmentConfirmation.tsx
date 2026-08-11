/**
 * The last thing between an assignment and a scoresheet.
 *
 * # Why there is a step here at all
 *
 * Because every mistake this card catches is one that cannot be caught later. A room that scores
 * twenty questions against the wrong pairing has produced a result that has to be thrown out; a room
 * that reads from packet 6 while the scoresheet says packet 5 has produced one that is *worse*,
 * because it looks fine. Both are cheap to notice now and expensive to notice at four o'clock.
 *
 * The old flow went from Start scoring straight into lineup selection, which meant the round, the
 * room, the packet and the two teams were all on screen — and all of them behind the scorekeeper's
 * attention, which was on picking four names. Nobody reads a header they were not asked to check.
 *
 * # Confirming is a press, and so is every problem
 *
 * "Everything matches" is one button. So is each of the three things that are actually wrong, and
 * they are wrong in different ways that need different people told, which is why they are three
 * buttons and not a text box: a scorekeeper under time pressure will not compose a sentence, and a
 * free-text field is how "wrong packet" arrives at tournament control as "somethings wrong".
 *
 * # It never blocks the room
 *
 * Reporting a problem does not lock the card. A director's answer to "we have the wrong packet" is
 * frequently "read it anyway, I will fix the record", and software that refuses to let a room start
 * until somebody clears a flag is software that gets worked around by reloading the page. So the
 * report is sent, the room is told it was sent, and the game can still begin.
 */
import { useState } from 'react';
import { IGamePackage, gamePackageMatchup } from '../game/GamePackage';
import { HelpRequestCategory, HelpRequestResult } from './HelpRequests';

/** The three things that are wrong often enough to deserve their own button. */
export type AssignmentProblem = 'wrong-teams' | 'wrong-packet' | 'wrong-round';

interface IProblemDefinition {
  label: string;
  /** What the scorekeeper is being asked for, in the words of the problem. */
  prompt: string;
  /**
   * The wire category.
   *
   * Chosen from the categories tournament control already triages on rather than invented, because a
   * category this client makes up arrives in somebody's queue as an unknown string. Two of the three
   * share `wrong-matchup`; the message below is what separates them.
   */
  category: HelpRequestCategory;
}

export const assignmentProblems: Record<AssignmentProblem, IProblemDefinition> = {
  'wrong-teams': {
    label: 'Wrong teams',
    prompt: 'Which teams are actually in this room?',
    category: 'wrong-matchup',
  },
  'wrong-packet': {
    label: 'Wrong packet',
    prompt: 'Which packet does the reader actually have?',
    category: 'question-packet',
  },
  'wrong-round': {
    label: 'Wrong round',
    prompt: 'Which round is this room actually playing?',
    category: 'wrong-matchup',
  },
};

/**
 * What tournament control is told.
 *
 * The assignment as this device understands it goes in every message, because the whole point of the
 * report is that control and the room disagree about it and control cannot see this screen. What the
 * scorekeeper typed is appended rather than relied on — a report that arrives with an empty note is
 * still completely actionable.
 */
export function problemMessage(
  problem: AssignmentProblem,
  packageValue: IGamePackage,
  note: string,
): string {
  const parts = [`${assignmentProblems[problem].label} reported before the game started.`];
  parts.push(`This device has: ${assignmentLine(packageValue)}, ${gamePackageMatchup(packageValue)}.`);
  const packet = packageValue.round.packetName;
  parts.push(packet ? `Packet: ${packet}.` : 'No packet was named for this round.');
  const trimmed = note.trim();
  if (trimmed !== '') parts.push(`Room says: ${trimmed}`);
  return parts.join(' ');
}

/** `Round 5 · Room 204`, or just the round when the tournament did not name a room. */
export function assignmentLine(packageValue: IGamePackage): string {
  const room = packageValue.room?.name;
  return room && room.trim() !== '' ? `${packageValue.round.name} · ${room}` : packageValue.round.name;
}

type ReportState =
  | { kind: 'none' }
  /** A problem is chosen and the note is being typed. */
  | { kind: 'composing'; problem: AssignmentProblem; note: string; busy: boolean; error: string }
  | { kind: 'sent'; problem: AssignmentProblem; alreadyOutstanding: boolean };

export default function AssignmentConfirmation(props: {
  packageValue: IGamePackage;
  /**
   * Send a problem to tournament control.
   *
   * Absent for a game with no control behind it, in which case the problem buttons say so rather than
   * disappearing — a scorekeeper who has spotted the wrong packet needs to be told to go and find
   * somebody, not left with a card that only offers agreement.
   */
  onReportProblem?: (category: HelpRequestCategory, message: string) => Promise<HelpRequestResult>;
  onConfirm: () => void;
  /** Back to the room without starting. The assignment is not consumed. */
  onBack: () => void;
}) {
  const { packageValue, onReportProblem, onConfirm, onBack } = props;
  const [report, setReport] = useState<ReportState>({ kind: 'none' });

  const packet = packageValue.round.packetName;
  const reported = report.kind === 'sent';

  const send = async () => {
    if (report.kind !== 'composing' || !onReportProblem) return;
    const { problem, note } = report;
    setReport({ ...report, busy: true, error: '' });
    const result = await onReportProblem(
      assignmentProblems[problem].category,
      problemMessage(problem, packageValue, note),
    );
    if (result.kind !== 'accepted' && result.kind !== 'already-outstanding') {
      const error =
        result.kind === 'unsupported'
          ? 'This tournament connection does not support remote control requests.'
          : result.kind === 'refused'
            ? 'Tournament control refused this request.'
            : 'Tournament control was not reached.';
      setReport({ ...report, busy: false, error });
      return;
    }
    setReport({ kind: 'sent', problem, alreadyOutstanding: result.kind === 'already-outstanding' });
  };

  return (
    <main className="shell shell-centered">
      <section className="shell-section pregame-card">
        {/* The assignment, in the order somebody checks it: where am I, who is playing, what are we
            reading from. Large enough to read from arm's length, because the reader is usually
            holding the packet on the other side of a table. */}
        <p className="pregame-context">{assignmentLine(packageValue)}</p>
        <h1 className="pregame-matchup">{gamePackageMatchup(packageValue)}</h1>
        <p className={packet ? 'pregame-packet' : 'pregame-packet is-missing'}>
          {packet ? `Packet ${packet}` : 'No packet named for this round'}
        </p>
        <p className="pregame-tournament">{packageValue.tournament.name}</p>

        {report.kind === 'none' && (
          <>
            <button type="button" className="shell-button is-primary pregame-confirm" onClick={onConfirm}>
              Everything matches
            </button>
            <p className="pregame-problem-heading">Something is wrong</p>
            <div className="pregame-problems">
              {(Object.keys(assignmentProblems) as AssignmentProblem[]).map((problem) => (
                <button
                  key={problem}
                  type="button"
                  className="shell-button"
                  onClick={() => setReport({ kind: 'composing', problem, note: '', busy: false, error: '' })}
                >
                  {assignmentProblems[problem].label}
                </button>
              ))}
            </div>
            {!onReportProblem && (
              <p className="shell-hint">
                This game was opened from a file, so QBSheet cannot notify tournament control. Sort it out
                with staff before scoring.
              </p>
            )}
          </>
        )}

        {report.kind === 'composing' && (
          <div className="pregame-report">
            <h2 className="shell-heading">{assignmentProblems[report.problem].label}</h2>
            <label className="shell-label" htmlFor="assignment-problem-note">
              {assignmentProblems[report.problem].prompt}
            </label>
            <textarea
              id="assignment-problem-note"
              className="shell-input pregame-note"
              rows={3}
              value={report.note}
              onChange={(event) => setReport({ ...report, note: event.target.value })}
            />
            <p className="shell-hint">
              {/* Said explicitly, because a scorekeeper who does not know what is already attached will
                  retype it, and the round and room are the two things they will spend the time on. */}
              The round, room, teams and packet on this screen are sent automatically. Add only what
              tournament control cannot already see.
            </p>
            {onReportProblem ? (
              <div className="shell-actions">
                <button
                  type="button"
                  className="shell-button is-primary"
                  disabled={report.busy}
                  onClick={() => void send()}
                >
                  {report.busy ? 'Sending…' : 'Tell tournament control'}
                </button>
                <button type="button" className="shell-button" onClick={() => setReport({ kind: 'none' })}>
                  Back
                </button>
              </div>
            ) : (
              <div className="shell-actions">
                <button type="button" className="shell-button" onClick={() => setReport({ kind: 'none' })}>
                  Back
                </button>
              </div>
            )}
            {report.error !== '' && (
              <p className="shell-errors" role="alert">
                {report.error} The game can still be scored — the result is saved on this device either way.
              </p>
            )}
          </div>
        )}

        {reported && (
          <div className="pregame-report">
            <p className="shell-notice" role="status">
              {report.alreadyOutstanding
                ? 'Tournament control had already been requested for this room.'
                : `Tournament control has been told: ${assignmentProblems[report.problem].label.toLowerCase()}.`}
            </p>
            <p className="shell-hint">
              Wait for staff if you need to. If they tell you to play it as it stands, start the game — the
              report stays on their queue either way.
            </p>
            <div className="shell-actions">
              <button type="button" className="shell-button is-primary" onClick={onConfirm}>
                Start anyway
              </button>
              <button type="button" className="shell-button" onClick={onBack}>
                Back to the room
              </button>
            </div>
          </div>
        )}

        {report.kind === 'none' && (
          <button type="button" className="shell-button pregame-back" onClick={onBack}>
            Back to the room
          </button>
        )}
      </section>
    </main>
  );
}
