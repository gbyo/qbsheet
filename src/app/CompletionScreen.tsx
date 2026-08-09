/**
 * What happens after the last question.
 *
 * # Two copies, and the server one does not excuse the other
 *
 * A connected game has two independent result paths: the submission tournament control received,
 * and the file somebody carries. They fail independently — a server can accept a result and then be
 * restored from a backup, a laptop can be reimaged, a submission can be filed against the wrong
 * game — and the entire value of asking for both is that neither is trusted to cover for the other.
 *
 * So "Result sent ✓" does not end the screen. The backup step is still there, still required, and
 * the game stays in this device's list with the backup marked outstanding until somebody says they
 * have handed it over.
 *
 * # And the acknowledgement is not proof
 *
 * The button records that the room says it uploaded the file. This application has no way to check
 * a shared drive, a folder or an email, and it does not pretend otherwise: the wording is about what
 * the scorekeeper did, not about what arrived. Claiming verification we do not have is worse than
 * claiming nothing, because it is the claim a director would rely on.
 *
 * # Nothing is deleted here
 *
 * Not on send, not on download, not on acknowledgement. `Download QBJ again` stays for as long as
 * the record does, because the second most common thing that goes wrong with a downloads folder is
 * that somebody cleared it.
 */
import { useState } from 'react';
import { IStoredGameRecord } from '../game/GameStore';
import { gamePackageLabel } from '../game/GamePackage';
import { downloadFile, qbjFileContents, qbjFileName } from '../integrations/file/QbjDownload';

function timeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function CompletionScreen(props: {
  record: IStoredGameRecord;
  onUpdate: (recordId: string, change: Partial<IStoredGameRecord>) => void | Promise<void>;
  onHome: () => void | Promise<void>;
}) {
  const { record, onUpdate, onHome } = props;
  const [writeFailed, setWriteFailed] = useState(false);
  const score = record.finalScore;
  const connected = record.serverDelivery !== 'none';
  const requiresHandoffAcknowledgement = connected || Boolean(record.package.handoffInstruction);

  const download = () => {
    if (!record.finalQbj) return;
    const written = downloadFile(qbjFileContents(record.finalQbj), qbjFileName(record.package));
    setWriteFailed(!written);
    if (written) void onUpdate(record.id, { qbjDownloadedAt: new Date().toISOString() });
  };

  return (
    <main className="shell">
      <header className="shell-header">
        <h1 className="shell-title">Final</h1>
        <p className="shell-subtitle">{gamePackageLabel(record.package)}</p>
      </header>

      <section className="shell-section final-score">
        <div className="final-row">
          <span className="final-team">{record.package.left.name}</span>
          <span className="final-points">{score ? score.left : '—'}</span>
        </div>
        <div className="final-row">
          <span className="final-team">{record.package.right.name}</span>
          <span className="final-points">{score ? score.right : '—'}</span>
        </div>
      </section>

      {connected && (
        <section className="shell-section">
          <h2 className="shell-heading">Tournament control</h2>
          {record.serverDelivery === 'sent' && <p className="final-ok">Result sent ✓</p>}
          {record.serverDelivery === 'pending' && (
            <p className="final-pending">
              Tournament control is unavailable. The result is saved on this device and will keep trying to
              send on its own.
            </p>
          )}
          {record.serverDelivery === 'rejected' && (
            <p className="shell-warning">
              Tournament control did not accept the result. {record.serverDeliveryDetail ?? ''} The result is
              saved on this device — hand the file over and speak to tournament control.
            </p>
          )}
        </section>
      )}

      <section className="shell-section">
        <h2 className="shell-heading">{connected ? 'Back up this result' : 'Hand this result over'}</h2>
        {connected && (
          <ol className="final-steps">
            <li>Download the QBJ.</li>
            <li>Upload it using the instructions provided for this room.</li>
          </ol>
        )}
        {record.package.handoffInstruction && (
          <p className="final-instruction">{record.package.handoffInstruction}</p>
        )}

        <div className="shell-actions">
          <button type="button" className="shell-button is-primary" onClick={download}>
            {record.qbjDownloadedAt ? 'Download QBJ again' : 'Download QBJ'}
          </button>
        </div>

        {writeFailed && (
          <p className="shell-warning" role="alert">
            This browser would not save the file. Try again, or use the browser&apos;s own download settings.
          </p>
        )}

        {record.qbjDownloadedAt && (
          <div className="final-handoff">
            <p className="shell-hint">Downloaded at {timeOfDay(record.qbjDownloadedAt)}</p>
            {!requiresHandoffAcknowledgement ? (
              <p className="final-ok">The QBJ is ready to hand over.</p>
            ) : record.handoffAcknowledgedAt ? (
              <p className="final-ok">Handoff confirmed at {timeOfDay(record.handoffAcknowledgedAt)}</p>
            ) : (
              <>
                <p>After you upload the file:</p>
                <button
                  type="button"
                  className="shell-button"
                  onClick={() => void onUpdate(record.id, { handoffAcknowledgedAt: new Date().toISOString() })}
                >
                  I uploaded the result
                </button>
              </>
            )}
          </div>
        )}
      </section>

      <div className="shell-actions">
        <button type="button" className="shell-button" onClick={() => void onHome()}>
          Done
        </button>
      </div>
    </main>
  );
}
