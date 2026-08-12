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
 * # The scorekeeper name is a setting, not a step
 *
 * It used to sit in a labelled block between the warnings and the game in progress, which put a
 * question nobody has to answer above the two things everybody came here for. It is a device
 * preference — set once, then never again on this Chromebook — so it lives behind a cog in the
 * header next to the other device-level thing, and the homepage goes straight from "what is wrong"
 * to "what are you scoring".
 *
 * Set once still has to happen once, so a device that has never been asked is asked, in a dialog,
 * on the first load. Once. A blank answer is an answer and is remembered as one.
 *
 * Once it is set it is said back, under the logo, as a greeting with a "Not you?" underneath. This
 * is the one part of it that is not a preference: a shared Chromebook that has been handed to the
 * next room still carries the last person's name into every result it sends, and the only way to
 * catch that is for the name to be on screen where somebody sitting down would read it. "Not you?"
 * is the same dialog as the cog, phrased as the question the person reading it is already asking.
 *
 * Guided practice is a different thing again and stays below: it is a tutorial with a script in it,
 * it invents its own teams, and its result is not a game anybody keeps. "Create a game" is scoring;
 * "Practice scoring" is learning where the buttons are.
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
import ControlIcon from '../scorer/ControlIcon';
import GameFileOpen from './GameFileOpen';
import RecentGames from './RecentGames';
import NativeDialog from './NativeDialog';
import { readOperatorNameAsked, writeOperatorNameAsked } from './OperatorIdentity';

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

/**
 * The scorekeeper name, in a dialog.
 *
 * Edited as a draft and committed on save, because a dialog with a Cancel in it has to mean it: a
 * field that wrote through on every keystroke would leave a half-typed name behind on a device the
 * scorekeeper thought they had backed out of.
 */
function ScorekeeperDialog(props: {
  /** First load on this device. Changes the framing from "a setting" to "a question". */
  firstRun: boolean;
  name: string;
  onSave: (value: string) => void;
  onDismiss: () => void;
}) {
  const { firstRun, name, onSave, onDismiss } = props;
  const [draft, setDraft] = useState(name);

  return (
    <NativeDialog
      title={firstRun ? 'Who is scoring?' : 'Scorekeeper'}
      onClose={onDismiss}
      className="scorekeeper-dialog"
    >
      <form
        className="operator-identity-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
        }}
      >
        <p className="welcome-option-copy">
          {firstRun
            ? 'Put your name on this device once and it goes out with every result it sends. You can skip this and set it later from the cog in the header.'
            : 'This name is stored on this device only.'}
        </p>
        <label className="shell-label" htmlFor="operator-name">
          Name (optional)
        </label>
        <input
          id="operator-name"
          className="shell-input"
          type="text"
          autoComplete="name"
          data-dialog-autofocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="shell-hint">Included in saved results and connected tournament presence.</p>
        <div className="shell-modal-actions">
          <button type="submit" className="shell-button is-primary">
            Save
          </button>
          <button type="button" className="shell-button" onClick={onDismiss}>
            {firstRun ? 'Not now' : 'Cancel'}
          </button>
        </div>
      </form>
    </NativeDialog>
  );
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
  practiceInProgress: boolean;
  onReadiness: () => void;
  onPractice: () => void;
  /** Into the hand-entered setup form. Creates nothing until that form is submitted. */
  onCreateGame: () => void;
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
    storageDegraded = false,
    storageError,
    operatorName = '',
    onOperatorNameChange,
    pairedRoom,
    practiceInProgress,
    onReadiness,
    onPractice,
    onCreateGame,
    onOpenRoom,
    onConnect,
    onOpenPackage,
    onOpenRecord,
    onRetryResult,
    canRetryResult,
    onFindExisting,
  } = props;
  const [address, setAddress] = useState('');
  const [addressError, setAddressError] = useState('');
  const [alreadyPlayed, setAlreadyPlayed] = useState<{ record: IStoredGameRecord; opened: IGamePackage } | null>(
    null,
  );
  const [scorekeeperOpen, setScorekeeperOpen] = useState(false);
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

  const closeScorekeeper = () => {
    setScorekeeperOpen(false);
    if (firstRun) {
      setFirstRun(false);
      writeOperatorNameAsked();
    }
  };

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = address.trim();
    if (trimmed === '') {
      setAddressError('Enter the address tournament control gave you.');
      return;
    }
    setAddressError('');
    onConnect(trimmed);
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
          {onOperatorNameChange && operatorName.trim() !== '' && (
            <div className="welcome-greeting">
              <p className="welcome-greeting-line">Hello, {greetingName(operatorName)}.</p>
              <button
                type="button"
                className="welcome-greeting-link"
                onClick={() => setScorekeeperOpen(true)}
              >
                Not you?
              </button>
            </div>
          )}
        </div>
        <div className="shell-header-actions">
          <button type="button" className="shell-button shell-button-quiet" onClick={onReadiness}>
            Check this device
          </button>
          {onOperatorNameChange && (
            <button
              type="button"
              className="shell-button shell-button-quiet shell-button-icon"
              onClick={() => setScorekeeperOpen(true)}
              title={operatorName === '' ? 'Scorekeeper' : `Scorekeeper: ${operatorName}`}
              aria-label={operatorName === '' ? 'Scorekeeper settings' : `Scorekeeper settings (${operatorName})`}
            >
              <ControlIcon name="settings" />
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
                  required
                  onChange={(event) => {
                    setAddress(event.target.value);
                    if (event.target.value.trim() !== '') setAddressError('');
                  }}
                />
                <button type="submit" className="shell-button is-primary" disabled={address.trim() === ''}>
                  Connect
                </button>
              </div>
              {addressError !== '' && <p className="shell-errors" role="alert">{addressError}</p>}
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

      {onOperatorNameChange && (scorekeeperOpen || firstRun) && (
        <ScorekeeperDialog
          firstRun={firstRun && !scorekeeperOpen}
          name={operatorName}
          onSave={(value) => {
            onOperatorNameChange(value);
            closeScorekeeper();
          }}
          onDismiss={closeScorekeeper}
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
        </NativeDialog>
      )}
    </main>
  );
}
