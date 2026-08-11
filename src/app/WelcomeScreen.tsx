/**
 * The screen the site opens on.
 *
 * # Not a mode picker
 *
 * There is no "server mode or file mode" question, because that is a question about how the
 * software is arranged rather than about what the room is doing. A room at a connected tournament
 * has an address on the projector and types it in; a room at any other tournament has a file. Both
 * are offered, one after the other, in the order they are likely, and neither requires understanding
 * that the other exists. Practice is separate from both: it is a self-contained training game that
 * never needs tournament data.
 *
 * # An unfinished game comes before either
 *
 * A room that reloads mid-round is the case this whole application is built around, and it is also
 * the case where the scorekeeper is under the most time pressure. So the game in progress is stated
 * plainly — round, room, teams, and how far in it got — with one button. Nothing about that path
 * involves the network, and it is offered whether or not anything is reachable.
 *
 * # And a paired room comes before the address box
 *
 * Once this device is Room 204, typing an address is not a thing anybody should have to do again.
 * The room is stated at the top with one button back into it; the address box stays underneath for
 * the case it is actually for, which is a device being pointed at a different tournament.
 */
import { FormEvent, useState } from 'react';
import BrandLogo from '../BrandLogo';
import { IStoredGameRecord, isActive } from '../game/GameStore';
import { IGamePackage, gamePackageIdentity, gamePackageLabel, gamePackageMatchup } from '../game/GamePackage';
import deriveGame from '../scoring/deriveGame';
import { IUnreadableRecord } from '../game/GameRecordUpgrade';
import { IPairedRoom } from './ConnectedSession';
import UpdateNotice from '../pwa/UpdateNotice';
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

/**
 * What to say about a saved game this build will not open.
 *
 * Said out loud, and specifically, because the alternative is a scorekeeper who reloaded mid-round and
 * is looking at a screen with no unfinished game on it. That is the same picture as data loss and it
 * would send somebody hunting for a paper scoresheet. The game is still in storage and the fix is
 * ordinary — get this device onto the build the rest of the venue is running — so the message names the
 * cause and stops there rather than offering a repair that would risk the record.
 */
export function unreadableNotice(unreadable: IUnreadableRecord[]): string | null {
  if (unreadable.length === 0) return null;
  const count = unreadable.length;
  const games = count === 1 ? 'A game' : `${count} games`;
  const tooNew = unreadable.filter((record) => record.readability === 'too-new').length;
  if (tooNew === count) {
    return `${games} on this device ${count === 1 ? 'was' : 'were'} saved by a newer version of QBSheet than the one running now. Nothing has been deleted. Update this device, or open it on the device that saved it.`;
  }
  if (tooNew === 0) {
    return `${games} on this device ${count === 1 ? 'is' : 'are'} in a format this version of QBSheet cannot read. Nothing has been deleted. Ask tournament control before scoring on this device.`;
  }
  return `${games} on this device cannot be opened by this version of QBSheet. Nothing has been deleted. Update this device or ask tournament control before scoring on it.`;
}

export default function WelcomeScreen(props: {
  records: IStoredGameRecord[];
  /** Games found in storage that this build declined to open. Never empty silently. */
  unreadable: IUnreadableRecord[];
  notice: string;
  durable: boolean;
  /** The room this device is paired with, when a pairing is held. */
  pairedRoom: IPairedRoom | null;
  practiceInProgress: boolean;
  onReadiness: () => void;
  onPractice: () => void;
  /** Back into the room this device is already paired with. No address, no code. */
  onOpenRoom: () => void;
  onConnect: (baseUrl: string) => void;
  onOpenPackage: (packageValue: IGamePackage, attempt?: number) => void | Promise<void>;
  onOpenRecord: (record: IStoredGameRecord) => void | Promise<void>;
  onRetryResult: (recordId: string) => void | Promise<void>;
  canRetryResult: (record: IStoredGameRecord) => boolean;
  onFindExisting: (identity: string) => Promise<IStoredGameRecord[]>;
}) {
  const {
    records,
    unreadable,
    notice,
    durable,
    pairedRoom,
    practiceInProgress,
    onReadiness,
    onPractice,
    onOpenRoom,
    onConnect,
    onOpenPackage,
    onOpenRecord,
    onRetryResult,
    canRetryResult,
    onFindExisting,
  } = props;
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
    <main className="shell welcome-shell">
      <header className="shell-header shell-header-row">
        <div>
          <h1 className="shell-title shell-brand-title">
            <BrandLogo className="shell-brand-logo" />
          </h1>
        </div>
        <button type="button" className="shell-button shell-button-quiet" onClick={onReadiness}>
          Check this device
        </button>
      </header>

      {!durable && (
        <p className="shell-warning" role="alert">
          This browser will not let the scoresheet save anything. A game scored here will be lost if the tab
          closes. Download a QBJ backup as soon as the game starts and again when it ends.
        </p>
      )}
      {unreadableNotice(unreadable) !== null && (
        <p className="shell-warning" role="alert">
          {unreadableNotice(unreadable)}
        </p>
      )}
      {notice !== '' && <p className="shell-notice">{notice}</p>}

      <UpdateNotice />

      {pairedRoom && (
        <section className="shell-section resume-card welcome-room">
          <div>
            <p className="resume-context">{pairedRoom.roomName} · Connected</p>
            <p className="welcome-option-copy">
              This device is paired for the tournament. Its next game comes from tournament control.
            </p>
          </div>
          <button type="button" className="shell-button is-primary" onClick={onOpenRoom}>
            Go to this room
          </button>
        </section>
      )}

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

      <section className="shell-section welcome-start">
        <h2 className="shell-heading">Start scoring</h2>
        <div className="welcome-start-options">
          <section className="welcome-start-option" aria-labelledby="welcome-control-heading">
            <h3 id="welcome-control-heading" className="welcome-option-heading">
              {pairedRoom ? 'Connect to a different tournament' : 'Connect to tournament control'}
            </h3>
            <p className="welcome-option-copy">
              {pairedRoom
                ? 'Pair this device somewhere else. The room above stays paired until this replaces it.'
                : 'Connect this room to receive its game and send back the result.'}
            </p>
            <form className="connect-form welcome-connect-form" onSubmit={submitAddress}>
              <label className="shell-label" htmlFor="control-address">
                Tournament control address
              </label>
              <div className="welcome-connect-fields">
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
              </div>
            </form>
          </section>

          <section className="welcome-start-option" aria-labelledby="welcome-file-heading">
            <h3 id="welcome-file-heading" className="welcome-option-heading">
              Open a game file
            </h3>
            <p className="welcome-option-copy">Open a QBJ or QBG file provided by tournament staff.</p>
            <GameFileOpen onOpen={openPackage} />
          </section>
        </div>
      </section>

      <section className="shell-section welcome-practice">
        <div>
          <h2 className="shell-heading">{practiceInProgress ? 'Practice game in progress' : 'New to QBSheet?'}</h2>
          <p className="welcome-practice-copy">
            {practiceInProgress
              ? 'Continue where you left off. Your practice scoresheet and guide position are saved on this device.'
              : 'Learn the workflow with a guided game using the real scoresheet. No setup needed.'}
          </p>
        </div>
        <button type="button" className="shell-button" onClick={onPractice}>
          {practiceInProgress ? 'Resume practice' : 'Practice scoring'}
        </button>
      </section>

      <RecentGames
        records={completed}
        onOpen={(record) => void onOpenRecord(record)}
        onRetry={(record) => onRetryResult(record.id)}
        canRetry={canRetryResult}
      />

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
