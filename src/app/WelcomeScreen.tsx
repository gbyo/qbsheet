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
 * # And a third way in, for when there is no tournament at all
 *
 * A practice, a scrimmage, a tryout, a pickup game: real scoring, with nobody to hand out an
 * assignment. Create a game asks for the two teams and the rules and then produces an ordinary game,
 * so it belongs under the same heading as the other two rather than in a feature of its own. It is
 * the third row of that block and is styled like one — a rule and a button, not a promoted card,
 * because it is the least likely of the three at a tournament and the most likely everywhere else.
 *
 * # Device preferences are settings, not steps
 *
 * It used to sit in a labelled block between the warnings and the game in progress, which put a
 * question nobody has to answer above the two things everybody came here for. It is a device
 * preference — set once, then never again on this Chromebook — so it lives in the compact Settings
 * panel behind the header cog, alongside the other device-level choices. The homepage goes straight
 * from "what is wrong" to "what are you scoring".
 *
 * Set once still has to happen once, so a device that has never been asked is asked, in a dialog,
 * on the first load. Once. A blank answer is an answer and is remembered as one.
 *
 * # Connect and scan are separate actions
 *
 * Connect always means "use the address in this field", and Scan QR always means "read the pairing
 * link from the camera". Keeping both controls present avoids a morphing button that changes under a
 * scorekeeper's hand when they start typing, and makes either route predictable at narrow widths.
 *
 * Once it is set it is said back, under the logo, as a greeting with a "Not you?" underneath. This
 * is the one part of it that is not a preference: a shared Chromebook that has been handed to the
 * next room still carries the last person's name into every result it sends, and the only way to
 * catch that is for the name to be on screen where somebody sitting down would read it. "Not you?"
 * opens that same editor directly through Settings, phrased as the question the person reading it is
 * already asking.
 *
 * Guided practice is a tutorial with a script in it, it invents its own teams, and its result is not
 * a game anybody keeps. It remains a quiet homepage action even after real game history exists, so a
 * scorekeeper does not have to hunt through Settings to rehearse the workflow.
 * "Create a game" is scoring; "Practice scoring" is learning where the buttons are.
 *
 * # An unfinished game comes before either
 *
 * A room that reloads mid-round is the case this whole application is built around, and it is also
 * the case where the scorekeeper is under the most time pressure. So the game in progress is stated
 * plainly — round, room, teams, and how far in it got — with one button. Nothing about that path
 * involves the network, and it is offered whether or not anything is reachable.
 *
 * # And a paired room is still the normal home
 *
 * Once this device is Room 204, typing an address is not a routine scoring choice. The room is
 * stated at the top with one deliberate way back into it; changing tournament control happens from
 * Room Settings, and file/manual scoring remains available here as an exceptional route.
 */
import { FormEvent, useState } from 'react';
import BrandLogo from '../BrandLogo';
import { IStoredGameRecord, isActive } from '../game/GameStore';
import { IGamePackage, gamePackageIdentity, gamePackageLabel, gamePackageMatchup } from '../game/GamePackage';
import deriveGame from '../scoring/deriveGame';
import { IUnreadableRecord } from '../game/GameRecordUpgrade';
import { IPairedRoom } from './ConnectedSession';
import { ControlOpenResult } from './ControlPairing';
import UpdateNotice from '../pwa/UpdateNotice';
import ControlIcon from '../scorer/ControlIcon';
import GameFileOpen from './GameFileOpen';
import RecentGames from './RecentGames';
import NativeDialog from './NativeDialog';
import QrScannerDialog from './QrScannerDialog';
import { IPairingLaunchIntent, readScannedPairingCode } from './PairingLaunch';
import { readOperatorNameAsked, writeOperatorNameAsked } from './OperatorIdentity';
import SettingsDialog, { ISettingsConnection } from './SettingsDialog';
import { downloadStoredGameQbj } from './FinishedGameDownload';

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

/**
 * What to call the scorekeeper in the greeting.
 *
 * The first word of whatever they typed. A scoresheet that says "Hello, Gibson Bell." is reading a
 * roster entry out loud; the greeting is there to confirm which person this device thinks it is,
 * and a first name does that in less space. The full name is still what goes out with the result.
 */
export function greetingName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

export default function WelcomeScreen(props: {
  records: IStoredGameRecord[];
  /** Games found in storage that this build declined to open. Never empty silently. */
  unreadable: IUnreadableRecord[];
  notice: string;
  durable: boolean;
  storageDegraded?: boolean;
  storageError?: string;
  /** Optional device identity carried into results and connected presence. */
  operatorName?: string;
  onOperatorNameChange?: (value: string) => void;
  /** The room this device is paired with, when a pairing is held. */
  pairedRoom: IPairedRoom | null;
  /** Display-safe connection facts for Settings. Contains no ids, tokens, codes, or credentials. */
  settingsConnection: ISettingsConnection | null;
  pairingProtection?: string;
  onForgetPairing: () => void;
  onResetDevicePreferences: () => void;
  practiceInProgress: boolean;
  onReadiness: () => void;
  onPractice: () => void;
  /** Into the hand-entered setup form. Creates nothing until that form is submitted. */
  onCreateGame: () => void;
  /** Back into the room this device is already paired with. No address, no code. */
  onOpenRoom: () => void;
  onConnect: (baseUrl: string) => Promise<ControlOpenResult>;
  /**
   * A pairing link this device just read off a QR code.
   *
   * Carries a short bootstrap code, so it goes straight out of this component to the connection flow
   * and is never held in state here, never rendered, and never written anywhere. See `PairingLaunch`.
   */
  onPairingLaunch: (intent: IPairingLaunchIntent) => void;
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
    storageDegraded = false,
    storageError,
    operatorName = '',
    onOperatorNameChange,
    pairedRoom,
    settingsConnection,
    pairingProtection,
    onForgetPairing,
    onResetDevicePreferences,
    practiceInProgress,
    onReadiness,
    onPractice,
    onCreateGame,
    onOpenRoom,
    onConnect,
    onPairingLaunch,
    onOpenPackage,
    onOpenRecord,
    onRetryResult,
    canRetryResult,
    onFindExisting,
  } = props;
  const [address, setAddress] = useState('');
  const [addressError, setAddressError] = useState('');
  const [addressUnreachable, setAddressUnreachable] = useState(false);
  const [addressBusy, setAddressBusy] = useState(false);
  const [alreadyPlayed, setAlreadyPlayed] = useState<{
    record: IStoredGameRecord;
    opened: IGamePackage;
  } | null>(null);
  const [settingsView, setSettingsView] = useState<'settings' | 'scorekeeper' | null>(null);
  const [scanning, setScanning] = useState(false);
  /**
   * The first-load ask, decided once at mount.
   *
   * Not asked if there is an unfinished game on this device: that device is a room that reloaded
   * mid-round, and the first thing on its screen has to be the Resume button, not a modal about a
   * name. It will be asked the next time it opens the site with nothing in progress.
   */
  const [firstRun, setFirstRun] = useState(
    () =>
      props.onOperatorNameChange !== undefined &&
      (props.operatorName ?? '').trim() === '' &&
      !props.records.some(isActive) &&
      !readOperatorNameAsked(),
  );

  const unfinished = records.filter(isActive);
  const completed = records.filter((record) => !isActive(record));
  const hasGameHistory = records.length > 0 || unreadable.length > 0;

  const closeSettings = () => {
    setSettingsView(null);
    if (firstRun) {
      setFirstRun(false);
      writeOperatorNameAsked();
    }
  };

  const submitAddress = async (event: FormEvent) => {
    event.preventDefault();
    if (addressBusy) return;
    const trimmed = address.trim();
    if (trimmed === '') {
      setAddressError('Enter the address tournament control gave you.');
      return;
    }
    setAddressError('');
    setAddressUnreachable(false);
    setAddressBusy(true);
    try {
      const result = await onConnect(trimmed);
      if (!result.ok) {
        setAddressError(result.error);
        setAddressUnreachable(result.unreachable);
      }
    } catch {
      setAddressError('Tournament control could not be reached. Check the connection and try again.');
      setAddressUnreachable(true);
    } finally {
      setAddressBusy(false);
    }
  };

  /** Keep the primary action disabled until there is an address worth connecting to. */
  const addressEmpty = address.trim() === '';

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
          {onOperatorNameChange && operatorName.trim() !== '' && (
            <div className="welcome-greeting">
              <p className="welcome-greeting-line">Hello, {greetingName(operatorName)}.</p>
              <button
                type="button"
                className="welcome-greeting-link"
                onClick={() => setSettingsView('scorekeeper')}
              >
                Not you?
              </button>
            </div>
          )}
        </div>
        <div className="shell-header-actions">
          {onOperatorNameChange && (
            <button
              type="button"
              className="shell-button shell-button-quiet shell-button-icon"
              onClick={() => setSettingsView('settings')}
              title="Settings"
              aria-label="Settings"
            >
              <ControlIcon name="settings" />
              <span className="shell-button-label">Settings</span>
            </button>
          )}
        </div>
      </header>

      {(!durable || storageDegraded) && (
        <p className="shell-warning" role="alert">
          {!durable
            ? 'This browser will not let the scoresheet save anything. A game scored here will be lost if the tab closes.'
            : 'The local game database is temporarily unavailable. Do not close an active game; download a QBJ backup now.'}{' '}
          {storageError}
        </p>
      )}
      {unreadableNotice(unreadable) !== null && (
        <p className="shell-warning" role="alert">
          {unreadableNotice(unreadable)}
        </p>
      )}
      {notice !== '' && (
        <p className="shell-notice" role="status">
          {notice}
        </p>
      )}

      <UpdateNotice />

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
              <button
                type="button"
                className="shell-button is-primary"
                onClick={() => void onOpenRecord(record)}
              >
                Resume
              </button>
            </div>
          ))}
        </section>
      )}

      {pairedRoom && (
        <section className="shell-section resume-card welcome-room">
          <div>
            <p className="resume-context">{pairedRoom.roomName} · Paired</p>
            <p className="welcome-option-copy">
              This device is paired for the tournament. Its next game comes from tournament control.
            </p>
          </div>
          <button type="button" className="shell-button is-primary" onClick={onOpenRoom}>
            Return to {pairedRoom.roomName}
          </button>
        </section>
      )}

      {!pairedRoom ? (
        <section className="shell-section welcome-start">
          <h2 className="shell-heading">Start scoring</h2>
          <div className="welcome-start-options">
            <section className="welcome-start-option" aria-labelledby="welcome-control-heading">
              <h3 id="welcome-control-heading" className="welcome-option-heading">
                Connect to tournament control
              </h3>
              <p className="welcome-option-copy">
                Connect this room to receive its game and send back the result.
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
                    placeholder="192.168.1.50:8080"
                    value={address}
                    required
                    onChange={(event) => {
                      setAddress(event.target.value);
                      if (event.target.value.trim() !== '') setAddressError('');
                      setAddressUnreachable(false);
                    }}
                  />
                  <button
                    type="submit"
                    className="shell-button is-primary"
                    disabled={addressBusy || addressEmpty}
                  >
                    {addressBusy ? 'Connecting…' : 'Connect'}
                  </button>
                  <button
                    type="button"
                    className="shell-button welcome-scan-button"
                    onClick={() => setScanning(true)}
                    disabled={addressBusy}
                  >
                    <ControlIcon name="qr" />
                    Scan QR
                  </button>
                </div>
                {addressError !== '' && (
                  <div className="shell-errors" role="alert">
                    <p>{addressError}</p>
                    {addressUnreachable && <p>You can still score with a game file.</p>}
                  </div>
                )}
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

          <div className="welcome-create">
            <div className="welcome-create-copy">
              <h3 className="welcome-option-heading">Create a game</h3>
              <p className="welcome-option-copy">Enter teams, players, and scoring rules yourself.</p>
            </div>
            <button type="button" className="shell-button" onClick={onCreateGame}>
              Create game
            </button>
          </div>
        </section>
      ) : (
        <section className="shell-section welcome-start welcome-other-scoring">
          <h2 className="shell-heading">Other scoring options</h2>
          <p className="welcome-option-copy">
            Use a game file or enter a local game when this room is not using its assigned game.
          </p>
          <div className="welcome-other-scoring-actions">
            <GameFileOpen onOpen={openPackage} />
            <button type="button" className="shell-button" onClick={onCreateGame}>
              Create a game
            </button>
            <button type="button" className="shell-button shell-button-quiet" onClick={onPractice}>
              {practiceInProgress ? 'Resume practice' : 'Practice scoring'}
            </button>
          </div>
        </section>
      )}

      <section className="shell-section welcome-practice">
        <div>
          <h2 className="shell-heading">
            {practiceInProgress
              ? 'Practice game in progress'
              : hasGameHistory
                ? 'Practice scoring'
                : 'New to QBSheet?'}
          </h2>
          <p className="welcome-practice-copy">
            {practiceInProgress
              ? 'Continue where you left off. Your practice scoresheet and guide position are saved on this device.'
              : hasGameHistory
                ? 'Rehearse the workflow with a guided game using the real scoresheet. No setup needed.'
                : 'Learn the workflow with a guided game using the real scoresheet. No setup needed.'}
          </p>
        </div>
        <button type="button" className="shell-button" onClick={onPractice}>
          {practiceInProgress ? 'Resume practice' : 'Practice scoring'}
        </button>
      </section>

      <RecentGames
        records={completed}
        onDownload={(record) => downloadStoredGameQbj(record)}
        onRetry={(record) => onRetryResult(record.id)}
        canRetry={canRetryResult}
      />

      <footer className="welcome-footer">
        <a href="about/">About QBSheet</a>
      </footer>

      {onOperatorNameChange && (settingsView !== null || firstRun) && (
        <SettingsDialog
          initialView={settingsView ?? 'scorekeeper'}
          firstRun={firstRun && settingsView === null}
          operatorName={operatorName}
          onOperatorNameChange={onOperatorNameChange}
          connection={settingsConnection}
          pairingProtection={pairingProtection}
          onForgetPairing={onForgetPairing}
          onResetDevicePreferences={onResetDevicePreferences}
          onReadiness={onReadiness}
          onClose={closeSettings}
        />
      )}

      {scanning && (
        <QrScannerDialog
          onClose={() => setScanning(false)}
          onDecoded={(text) => readScannedPairingCode(text, setScanning, onPairingLaunch)}
        />
      )}

      {alreadyPlayed && (
        <NativeDialog
          title="Game already completed"
          onClose={() => setAlreadyPlayed(null)}
          className="welcome-dialog"
          bodyClassName="shell-modal-body"
        >
          <p>This game has already been completed on this device.</p>
          <p>
            {gamePackageLabel(alreadyPlayed.record.package)} ·{' '}
            {gamePackageMatchup(alreadyPlayed.record.package)}
          </p>
          <div className="shell-modal-actions">
            <button
              type="button"
              className="shell-button is-primary"
              onClick={() => {
                const record = alreadyPlayed.record;
                setAlreadyPlayed(null);
                downloadStoredGameQbj(record);
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
        </NativeDialog>
      )}
    </main>
  );
}
