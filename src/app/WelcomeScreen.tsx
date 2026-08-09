/**
 * The screen the site opens on.
 *
 * # Not a mode picker
 *
 * There is no "server mode or file mode" question, because that is a question about how the
 * software is arranged rather than about what the room is doing. A room at a connected tournament
 * has an address on the projector and types it in; a room at any other tournament has a file. Both
 * are offered, one after the other, in the order they are likely, and neither requires understanding
 * that the other exists.
 *
 * # An unfinished game comes before either
 *
 * A room that reloads mid-round is the case this whole application is built around, and it is also
 * the case where the scorekeeper is under the most time pressure. So the game in progress is stated
 * plainly — round, room, teams, and how far in it got — with one button. Nothing about that path
 * involves the network, and it is offered whether or not anything is reachable.
 */
import { FormEvent, useState } from 'react';
import { IStoredGameRecord, isActive } from '../game/GameStore';
import { IGamePackage, gamePackageIdentity, gamePackageLabel, gamePackageMatchup } from '../game/GamePackage';
import deriveGame from '../scoring/deriveGame';
import GameFileOpen from './GameFileOpen';
import RecentGames from './RecentGames';

/** How far a saved game got, for the resume card. */
export function progressLabel(record: IStoredGameRecord): string {
  try {
    const game = deriveGame(record.package.scorekeeperFormat, record.setup, record.events);
    if (game.tossupsRead === 0) return 'Not started';
    return `Q${game.tossupsRead}`;
  } catch {
    // A record the engine cannot read still deserves a resume button; the scorer will say more.
    return 'In progress';
  }
}

export default function WelcomeScreen(props: {
  records: IStoredGameRecord[];
  notice: string;
  durable: boolean;
  rememberedRoom?: string;
  onConnect: (baseUrl: string) => void;
  onOpenPackage: (packageValue: IGamePackage, attempt?: number) => void | Promise<void>;
  onOpenRecord: (record: IStoredGameRecord) => void | Promise<void>;
  onFindExisting: (identity: string) => Promise<IStoredGameRecord[]>;
}) {
  const { records, notice, durable, rememberedRoom, onConnect, onOpenPackage, onOpenRecord, onFindExisting } =
    props;
  const [address, setAddress] = useState('');
  const [alreadyPlayed, setAlreadyPlayed] = useState<{ record: IStoredGameRecord; opened: IGamePackage } | null>(
    null,
  );

  const unfinished = records.filter(isActive);
  const completed = records.filter((record) => !isActive(record));

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    onConnect(address);
  };

  /**
   * Opening a file for a game this device has already completed.
   *
   * Not refused, because there are legitimate reasons — a game genuinely replayed, a result thrown
   * out. But not silent either: starting a second scoresheet for a game that already has a result
   * is how two different answers reach tournament control, so it takes a deliberate second press
   * and the previous result is offered first.
   */
  const openPackage = async (packageValue: IGamePackage) => {
    const existing = await onFindExisting(gamePackageIdentity(packageValue));
    const finished = existing.find((record) => !isActive(record));
    if (finished && !existing.some(isActive)) {
      setAlreadyPlayed({ record: finished, opened: packageValue });
      return;
    }
    await onOpenPackage(packageValue);
  };

  return (
    <main className="shell">
      <header className="shell-header">
        <h1 className="shell-title">Electronic Scoresheet</h1>
      </header>

      {!durable && (
        <p className="shell-warning" role="alert">
          This browser will not let the scoresheet save anything. A game scored here will be lost if the tab
          closes. Download a QBJ backup as soon as the game starts and again when it ends.
        </p>
      )}
      {notice !== '' && <p className="shell-notice">{notice}</p>}

      {unfinished.length > 0 && (
        <section className="shell-section">
          <h2 className="shell-heading">Unfinished game</h2>
          {unfinished.map((record) => (
            <div key={record.id} className="resume-card">
              <div>
                <p className="resume-context">{gamePackageLabel(record.package)}</p>
                <p className="resume-matchup">{gamePackageMatchup(record.package)}</p>
                <p className="resume-progress">{progressLabel(record)}</p>
              </div>
              <button type="button" className="shell-button is-primary" onClick={() => void onOpenRecord(record)}>
                Resume
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="shell-section">
        <h2 className="shell-heading">Connect to tournament control</h2>
        <form className="connect-form" onSubmit={submitAddress}>
          <label className="shell-label" htmlFor="control-address">
            Tournament control address
          </label>
          <input
            id="control-address"
            className="shell-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button type="submit" className="shell-button is-primary">
            Connect
          </button>
        </form>
        {rememberedRoom && <p className="shell-hint">This device last paired as {rememberedRoom}.</p>}
      </section>

      <section className="shell-section">
        <h2 className="shell-heading">Have a game file instead?</h2>
        <GameFileOpen onOpen={openPackage} />
      </section>

      <RecentGames records={completed} onOpen={(record) => void onOpenRecord(record)} />

      {alreadyPlayed && (
        <div className="shell-modal" role="dialog" aria-modal="true" aria-label="Game already completed">
          <div className="shell-modal-body">
            <h2>This game has already been completed on this device.</h2>
            <p>
              {gamePackageLabel(alreadyPlayed.record.package)} · {gamePackageMatchup(alreadyPlayed.record.package)}
            </p>
            <div className="shell-modal-actions">
              <button
                type="button"
                className="shell-button is-primary"
                onClick={() => {
                  const record = alreadyPlayed.record;
                  setAlreadyPlayed(null);
                  void onOpenRecord(record);
                }}
              >
                Download previous QBJ
              </button>
              <button
                type="button"
                className="shell-button is-destructive"
                onClick={() => {
                  const opened = alreadyPlayed.opened;
                  const attempt = alreadyPlayed.record.attempt + 1;
                  setAlreadyPlayed(null);
                  void onOpenPackage(opened, attempt);
                }}
              >
                Open as new attempt…
              </button>
              <button type="button" className="shell-button" onClick={() => setAlreadyPlayed(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
