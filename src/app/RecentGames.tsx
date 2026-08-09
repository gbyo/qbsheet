/**
 * Games this device has finished, and what became of each copy of them.
 *
 * # Three claims, kept separate
 *
 * A finished game has up to three independent copies: the one this device is holding, the one
 * tournament control received, and the file somebody handed over. The list says which of the three
 * are true, individually, because they fail independently and a summary that collapsed them would
 * hide exactly the case that matters — a result the server accepted whose file never reached the
 * folder it was supposed to.
 *
 * Nothing here deletes a game. `Download QBJ again` stays available for as long as the record does,
 * because the second most common thing that goes wrong with a downloads folder is that somebody
 * cleared it.
 */
import { IStoredGameRecord } from '../game/GameStore';
import { gamePackageLabel, gamePackageMatchup } from '../game/GamePackage';

function timeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function deliveryText(record: IStoredGameRecord): string {
  if (record.serverDelivery === 'none') return 'Not applicable';
  if (record.serverDelivery === 'sent') return 'Sent';
  if (record.serverDelivery === 'rejected') return record.serverDeliveryDetail ?? 'Refused';
  return 'Waiting';
}

export function ScoreLine(props: { record: IStoredGameRecord }) {
  const { record } = props;
  const { finalScore, package: gamePackage } = record;
  if (!finalScore) return <span className="recent-matchup">{gamePackageMatchup(gamePackage)}</span>;
  return (
    <span className="recent-matchup">
      {gamePackage.left.name} {finalScore.left}–{finalScore.right} {gamePackage.right.name}
    </span>
  );
}

export default function RecentGames(props: {
  records: IStoredGameRecord[];
  onOpen: (record: IStoredGameRecord) => void;
}) {
  const { records, onOpen } = props;
  if (records.length === 0) return null;

  return (
    <section className="shell-section">
      <h2 className="shell-heading">Recent</h2>
      <ul className="recent-list">
        {records.map((record) => (
          <li key={record.id} className="recent-item">
            <div className="recent-main">
              <p className="recent-context">{gamePackageLabel(record.package)}</p>
              <p className="recent-score">
                <ScoreLine record={record} />
              </p>
              <p className="recent-when">Completed {timeOfDay(record.completedAt)}</p>
            </div>
            <dl className="recent-status">
              <div>
                <dt>Server sent</dt>
                <dd>{deliveryText(record)}</dd>
              </div>
              <div>
                <dt>QBJ downloaded</dt>
                <dd>{record.qbjDownloadedAt ? timeOfDay(record.qbjDownloadedAt) : 'Not yet'}</dd>
              </div>
              <div>
                <dt>Handoff</dt>
                <dd>{record.handoffAcknowledgedAt ? 'Confirmed' : 'Not confirmed'}</dd>
              </div>
            </dl>
            <button type="button" className="shell-button" onClick={() => onOpen(record)}>
              Download QBJ again
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
