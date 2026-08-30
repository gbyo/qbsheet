/**
 * The exceptional wrong-assignment report from the established room.
 *
 * The assigned room itself is the human verification step. This dialog is deliberately secondary:
 * it lets a scorekeeper report the specific disagreement without opening a session, creating a
 * local record, or blocking the room from starting if staff says to play the assignment as shown.
 */
import { useEffect, useRef, useState } from 'react';
import { IGamePackage, gamePackageMatchup } from '../game/GamePackage';
import { HelpRequestCategory, HelpRequestResult } from './HelpRequests';
import NativeDialog from './NativeDialog';

export type AssignmentProblem = 'wrong-teams' | 'wrong-packet' | 'wrong-round';

interface IProblemDefinition {
  label: string;
  prompt: string;
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

/** What the room and tournament control already know, stated in every help request. */
export function assignmentLine(packageValue: IGamePackage): string {
  const room = packageValue.room?.name;
  return room && room.trim() !== '' ? `${packageValue.round.name} · ${room}` : packageValue.round.name;
}

/** Build the existing wire category/message pair without inventing a new protocol category. */
export function problemMessage(problem: AssignmentProblem, packageValue: IGamePackage, note: string): string {
  const parts = [`${assignmentProblems[problem].label} reported before the game started.`];
  parts.push(`This device has: ${assignmentLine(packageValue)}, ${gamePackageMatchup(packageValue)}.`);
  const packet = packageValue.round.packetName;
  parts.push(packet ? `Packet: ${packet}.` : 'No packet was named for this round.');
  const trimmed = note.trim();
  if (trimmed !== '') parts.push(`Room says: ${trimmed}`);
  return parts.join(' ');
}

type ReportState =
  | { kind: 'choose' }
  | { kind: 'compose'; problem: AssignmentProblem; note: string; busy: boolean; error: string };

export default function AssignmentProblemDialog(props: {
  packageValue: IGamePackage;
  onReportProblem?: (category: HelpRequestCategory, message: string) => Promise<HelpRequestResult>;
  onSent?: (result: Extract<HelpRequestResult, { kind: 'accepted' | 'already-outstanding' }>) => void;
  onClose: () => void;
}) {
  const { packageValue, onReportProblem, onSent, onClose } = props;
  const [report, setReport] = useState<ReportState>({ kind: 'choose' });
  const noteField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (report.kind === 'compose') noteField.current?.focus();
  }, [report.kind]);

  const send = async () => {
    if (report.kind !== 'compose' || !onReportProblem) return;
    const { problem, note } = report;
    setReport((current) => (current.kind === 'compose' ? { ...current, busy: true, error: '' } : current));
    let result: HelpRequestResult;
    try {
      result = await onReportProblem(
        assignmentProblems[problem].category,
        problemMessage(problem, packageValue, note),
      );
    } catch {
      result = { kind: 'unreachable', error: 'Tournament control was not reached.' };
    }
    if (result.kind !== 'accepted' && result.kind !== 'already-outstanding') {
      const error =
        result.kind === 'unsupported'
          ? 'This tournament connection does not support remote control requests.'
          : result.error;
      setReport((current) => (current.kind === 'compose' ? { ...current, busy: false, error } : current));
      return;
    }
    onSent?.(result);
    onClose();
  };

  return (
    <NativeDialog title="Something wrong with this game?" onClose={onClose} className="assignment-problem-dialog">
      {report.kind === 'choose' && (
        <>
          <p className="shell-hint">
            Choose the one fact that does not match. QBSheet will include the assignment shown in the room
            so tournament control can compare it.
          </p>
          <div className="shell-modal-actions assignment-problem-choices">
            {(Object.keys(assignmentProblems) as AssignmentProblem[]).map((problem) => (
              <button
                key={problem}
                type="button"
                className="shell-button"
                onClick={() => setReport({ kind: 'compose', problem, note: '', busy: false, error: '' })}
              >
                {assignmentProblems[problem].label}
              </button>
            ))}
          </div>
        </>
      )}

      {report.kind === 'compose' && (
        <form
          className="assignment-problem-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <h3 className="shell-heading">{assignmentProblems[report.problem].label}</h3>
          <label className="shell-label" htmlFor="assignment-problem-note">
            {assignmentProblems[report.problem].prompt}
          </label>
          <textarea
            id="assignment-problem-note"
            className="shell-input pregame-note"
            rows={3}
            ref={noteField}
            disabled={report.busy}
            value={report.note}
            onChange={(event) =>
              setReport((current) =>
                current.kind === 'compose' ? { ...current, note: event.target.value } : current,
              )
            }
          />
          <p className="shell-hint">
            The round, room, teams and packet are sent automatically. Add only what tournament control
            cannot already see.
          </p>
          {!onReportProblem && (
            <p className="shell-warning" role="alert">
              This connected server cannot receive a remote request. Contact tournament staff directly.
            </p>
          )}
          {report.error !== '' && (
            <p className="shell-warning" role="alert">
              {report.error} The request was not delivered. You can close this dialog and start scoring.
            </p>
          )}
          <div className="shell-modal-actions">
            {onReportProblem && (
              <button type="submit" className="shell-button is-primary" disabled={report.busy}>
                {report.busy ? 'Sending…' : 'Tell tournament control'}
              </button>
            )}
            <button
              type="button"
              className="shell-button"
              disabled={report.busy}
              onClick={() => (report.error === '' ? setReport({ kind: 'choose' }) : onClose())}
            >
              {report.error === '' ? 'Back' : 'Close'}
            </button>
          </div>
        </form>
      )}
    </NativeDialog>
  );
}
