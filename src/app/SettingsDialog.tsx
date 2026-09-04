import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import {
  keyboardActionLabels,
  keyboardActionNames,
  keyboardSeatNumbers,
  keyboardShortcutLabels,
} from '../scorer/KeyboardScoring';
import { setKeyboardEnabled } from '../scorer/keyboardPreference';
import useKeyboardEnabled from '../scorer/useKeyboardEnabled';
import {
  Appearance,
  TextSize,
  appearanceLabels,
  setAppearance,
  setTextSize,
  textSizeLabels,
} from './displayPreference';
import useDisplayPreferences from './useDisplayPreferences';
import { buildLabel } from '../pwa/BuildVersion';
import NativeDialog from './NativeDialog';
import {
  effectiveExternalBackupStatus,
  externalBackupStateLabel,
  localCheckpointStateLabel,
  recoverySavedAtLabel,
  safeRecoveryFolderName,
  supportsExternalBackup,
} from './DeviceReadiness';
import type {
  IExternalBackupStatus,
  ILocalCheckpointStatus,
  IRecoveryUi,
  RecoveryAction,
  RecoveryActionResult,
} from './DeviceReadiness';

export interface ISettingsConnection {
  /** Human-facing room label only. Never a room id. */
  roomName: string;
  /** Already passed through `safeAddress` by App. */
  address?: string;
}

/**
 * Root Settings is a summary and a set of doors; every subview is one room behind one of them.
 *
 * `settings` is the overview. Everything else is reached from it, holds the controls and the
 * explanation for one topic, and returns to it. `forget` and `reset` are the two destructive
 * confirmations, and each belongs to the subview that offers it rather than to the root.
 */
type SettingsView =
  | 'settings'
  | 'scorekeeper'
  | 'appearance'
  | 'shortcuts'
  | 'connection'
  | 'recovery'
  | 'forget'
  | 'advanced'
  | 'reset';

function dialogTitle(view: SettingsView, firstRun: boolean): string {
  if (view === 'scorekeeper') return firstRun ? 'Who is scoring?' : 'Scorekeeper';
  if (view === 'appearance') return 'Appearance';
  if (view === 'shortcuts') return 'Keyboard shortcuts';
  if (view === 'connection') return 'Tournament connection';
  if (view === 'recovery') return 'Recovery';
  if (view === 'forget') return 'Forget tournament pairing?';
  if (view === 'advanced') return 'Advanced';
  if (view === 'reset') return 'Reset device preferences?';
  return 'Settings';
}

/** Fixed display order, lightest-touch first, so the list reads as an escalation rather than a set. */
const appearanceOrder: Appearance[] = ['system', 'light', 'dark'];
const textSizeOrder: TextSize[] = ['standard', 'comfortable', 'large'];

/**
 * The one-line truth about recovery, for the root row.
 *
 * Composed from the same labels the Recovery view and Device Readiness use, so there is one place
 * that decides what a state is called and this is not a second opinion about it. The optional
 * external layer is left out entirely when the browser cannot do it: "Protected" is the whole story
 * on that device, and naming an unsupported feature on the overview would only invite a question the
 * subview already answers.
 */
function recoverySummary(
  localCheckpoints: ILocalCheckpointStatus,
  externalBackup: IExternalBackupStatus,
): string {
  const local = localCheckpointStateLabel(localCheckpoints.state);
  if (externalBackup.state === 'unsupported') return local;
  if (externalBackup.state === 'ready') {
    return `${local} · ${safeRecoveryFolderName(externalBackup.folderName)}`;
  }
  return `${local} · ${externalBackupStateLabel(externalBackup.state)}`;
}

/**
 * One row of the overview: what the setting is, what it currently says, and a way in.
 *
 * The whole row is the button. A small `Edit` or `View` beside a label is a second thing to aim at
 * on a Chromebook trackpad and reads as a separate control to a screen reader, when the row already
 * is the control; the accessible name comes out as "Appearance, Match device · Standard", which is
 * both the label and the answer without a live region or a title attribute.
 */
function SettingsNavigationRow(props: {
  label: string;
  value?: string;
  autofocus?: boolean;
  onClick: () => void;
}) {
  const { label, value, autofocus = false, onClick } = props;
  return (
    <button
      type="button"
      className="settings-navigation-row"
      {...(autofocus ? { 'data-dialog-autofocus': true, 'data-settings-view-autofocus': true } : {})}
      onClick={onClick}
    >
      <span className="settings-navigation-label">{label}</span>
      {value !== undefined && <span className="settings-navigation-value">{value}</span>}
      <span className="settings-navigation-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

/** A subview's way back, and the last thing in its tab order for the same reason Back is last. */
function BackToSettings(props: { onClick: () => void }) {
  return (
    <button type="button" className="shell-button" data-settings-view-autofocus onClick={props.onClick}>
      Back to Settings
    </button>
  );
}

function SettingsSection(props: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={props.id}>
      <h3 id={props.id} className="settings-section-title">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

/**
 * One labelled row of mutually exclusive choices.
 *
 * A real `radiogroup` of real radio inputs, styled as a segmented control. The inputs are visually
 * hidden rather than replaced, so arrow-key navigation, the accessibility tree and the grouping all
 * come from the browser instead of from an implementation of them here -- which matters more than
 * usual on a screen whose whole purpose is being usable by somebody the default was failing.
 */
function ChoiceRow<T extends string>(props: {
  name: string;
  label: string;
  detail: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const { name, label, detail, value, options, onChange } = props;
  const labelId = `${name}-label`;
  return (
    <div className="settings-row settings-row-stacked">
      <div>
        <span className="settings-row-label" id={labelId}>
          {label}
        </span>
        <span className="settings-row-detail">{detail}</span>
      </div>
      <div className="settings-choices" role="radiogroup" aria-labelledby={labelId}>
        {options.map((option) => (
          <label
            key={option.value}
            className={`settings-choice${option.value === value ? ' is-selected' : ''}`}
          >
            <input
              type="radio"
              className="visually-hidden"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export default function SettingsDialog(props: {
  operatorName: string;
  onOperatorNameChange: (value: string) => void;
  connection: ISettingsConnection | null;
  /** Why this pairing cannot be removed while the current unfinished game depends on it. */
  pairingProtection?: string;
  onForgetPairing: () => void;
  onResetDevicePreferences: () => void;
  onReadiness: () => void;
  /**
   * Retained as an optional compatibility prop for callers compiled against older builds. General
   * scoring navigation now lives on Welcome/ConnectedRoom, not in Settings.
   */
  onOtherScoring?: () => void;
  /** Retained for the same compatibility reason; practice has its own quiet home entry. */
  onPractice?: () => void;
  /** Whether practice has a saved in-progress game; navigation is no longer rendered here. */
  practiceInProgress?: boolean;
  /** Read-only recovery status plus explicit user-action callbacks from the recovery core. */
  recovery?: IRecoveryUi;
  /** Begin a fresh pairing flow without silently clearing the current room. */
  onChangeTournament?: () => void;
  onClose: () => void;
  initialView?: Extract<SettingsView, 'settings' | 'scorekeeper'>;
  firstRun?: boolean;
}) {
  const {
    operatorName,
    onOperatorNameChange,
    connection,
    pairingProtection,
    onForgetPairing,
    onResetDevicePreferences,
    onReadiness,
    recovery,
    onChangeTournament,
    onClose,
    initialView = 'settings',
    firstRun = false,
  } = props;
  const [view, setView] = useState<SettingsView>(initialView);
  const [draft, setDraft] = useState(operatorName);
  const [scorekeeperReturnsToSettings, setScorekeeperReturnsToSettings] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState('');
  const [recoveryAction, setRecoveryAction] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<{ kind: 'pass' | 'fail'; text: string } | null>(
    null,
  );
  const [confirmingExternalBackupRemoval, setConfirmingExternalBackupRemoval] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const keyboardEnabled = useKeyboardEnabled();
  const { appearance, textSize } = useDisplayPreferences();
  const externalBackup = effectiveExternalBackupStatus(supportsExternalBackup(), recovery?.externalBackup);
  const localCheckpoints = recovery?.localCheckpoints ?? {
    state: 'protected' as const,
    message:
      'QBSheet keeps the instant journal and durable game copy automatically. Rolling checkpoint details appear here when the recovery core reports them.',
  };

  useEffect(() => {
    body.current?.querySelector<HTMLElement>('[data-settings-view-autofocus]')?.focus();
  }, [view]);

  const openScorekeeper = () => {
    setDraft(operatorName);
    setScorekeeperReturnsToSettings(true);
    setView('scorekeeper');
  };

  const leaveScorekeeper = () => {
    if (firstRun || !scorekeeperReturnsToSettings) onClose();
    else setView('settings');
  };

  const saveScorekeeper = (event: FormEvent) => {
    event.preventDefault();
    onOperatorNameChange(draft);
    leaveScorekeeper();
  };

  const runRecoveryAction = async (
    name: string,
    action: RecoveryAction | undefined,
    successMessage: string,
    failureMessage: string,
  ) => {
    if (!action) return;
    setRecoveryAction(name);
    setRecoveryMessage(null);
    try {
      // The action is invoked synchronously from the button handler so a recovery core can use the
      // browser's user activation for showDirectoryPicker/requestPermission. Nothing here runs during
      // Settings mount or while Device Readiness performs passive feature detection.
      const result: RecoveryActionResult = await action();
      if (result && 'ok' in result && result.ok === false) {
        setRecoveryMessage({ kind: 'fail', text: result.message });
        return;
      }
      if (recovery?.onRefreshRecoveryStatus) await recovery.onRefreshRecoveryStatus();
      setRecoveryMessage({ kind: 'pass', text: result?.message ?? successMessage });
    } catch {
      setRecoveryMessage({ kind: 'fail', text: failureMessage });
    } finally {
      setRecoveryAction(null);
    }
  };

  /**
   * The Settings-owned recovery management view.
   *
   * Deliberately not the host's Recovery Mode: this is where the external-backup actions live, and a
   * device that also offers a full recovery screen must not lose them the moment that callback is
   * supplied. Opening the host screen is `openFullRecoveryStatus`, and only the button that says so
   * does it.
   */
  const openRecoveryView = () => {
    setRecoveryMessage(null);
    setConfirmingExternalBackupRemoval(false);
    setView('recovery');
  };

  /** The host's fuller Recovery Mode, which replaces this dialog rather than stacking on it. */
  const openFullRecoveryStatus = () => {
    if (!recovery?.onViewRecoveryStatus) return;
    onClose();
    recovery.onViewRecoveryStatus();
  };

  return (
    <NativeDialog title={dialogTitle(view, firstRun)} onClose={onClose} className="settings-dialog">
      <div ref={body}>
        {view === 'settings' && (
          <>
            {acknowledgement !== '' && (
              <p className="settings-acknowledgement" role="status">
                {acknowledgement}
              </p>
            )}

            <SettingsSection id="settings-general-heading" title="General">
              <SettingsNavigationRow
                label="Scorekeeper"
                value={operatorName.trim() === '' ? 'Not set' : operatorName}
                autofocus
                onClick={openScorekeeper}
              />
              <SettingsNavigationRow
                label="Appearance"
                value={`${appearanceLabels[appearance]} · ${textSizeLabels[textSize]}`}
                onClick={() => setView('appearance')}
              />
            </SettingsSection>

            <SettingsSection id="settings-scoring-heading" title="Scoring">
              {/* Not a navigation row: it holds a switch, and a button that contains a control is a
                  target that does two different things depending on where it was pressed. */}
              <div className="settings-row">
                <div>
                  <span className="settings-row-label">Keyboard scoring</span>
                  <span className="settings-row-detail">Optional advanced input method</span>
                </div>
                <label className="settings-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Keyboard scoring"
                    checked={keyboardEnabled}
                    onChange={(event) => setKeyboardEnabled(event.target.checked)}
                  />
                  <span className="settings-switch-track" aria-hidden="true" />
                </label>
              </div>
              {keyboardEnabled && (
                <SettingsNavigationRow label="Keyboard shortcuts" onClick={() => setView('shortcuts')} />
              )}
            </SettingsSection>

            {connection && (
              <SettingsSection id="settings-tournament-heading" title="Tournament">
                <SettingsNavigationRow
                  label="Tournament connection"
                  value={connection.roomName}
                  onClick={() => setView('connection')}
                />
              </SettingsSection>
            )}

            <SettingsSection id="settings-data-heading" title={'Data & device'}>
              <SettingsNavigationRow
                label="Recovery"
                value={recoverySummary(localCheckpoints, externalBackup)}
                onClick={openRecoveryView}
              />
              <SettingsNavigationRow
                label="Check this device"
                onClick={() => {
                  onClose();
                  onReadiness();
                }}
              />
            </SettingsSection>

            <SettingsSection id="settings-advanced-heading" title="Advanced">
              <SettingsNavigationRow label="Advanced" onClick={() => setView('advanced')} />
            </SettingsSection>

            <footer className="settings-build">QBSheet {buildLabel()}</footer>
          </>
        )}

        {view === 'scorekeeper' && (
          <form className="operator-identity-form" onSubmit={saveScorekeeper}>
            <p className="welcome-option-copy">
              {firstRun
                ? 'Put your name on this device once and it goes out with every result it sends. You can skip this and set it later in Settings.'
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
              data-settings-view-autofocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className="shell-hint">Included in saved results and connected tournament presence.</p>
            <div className="shell-modal-actions">
              <button type="submit" className="shell-button is-primary">
                Save
              </button>
              <button type="button" className="shell-button" onClick={leaveScorekeeper}>
                {firstRun ? 'Not now' : 'Cancel'}
              </button>
            </div>
          </form>
        )}

        {view === 'appearance' && (
          <div className="settings-detail-view">
            {/*
              Radio groups rather than switches or a select. Three named states each, all of them
              worth seeing at once, and a scorekeeper changing these is usually doing it because
              the screen is hard to read -- which is the worst moment to hide two of the three
              choices behind a dropdown they have to open to compare.
            */}
            <ChoiceRow
              name="settings-appearance"
              label="Appearance"
              detail="Match device follows this Chromebook's own setting"
              value={appearance}
              options={appearanceOrder.map((option) => ({
                value: option,
                label: appearanceLabels[option],
              }))}
              onChange={(next) => setAppearance(next)}
            />
            <ChoiceRow
              name="settings-text-size"
              label="Text size"
              detail="Scales on top of this browser's own font size"
              value={textSize}
              options={textSizeOrder.map((option) => ({ value: option, label: textSizeLabels[option] }))}
              onChange={(next) => setTextSize(next)}
            />
            <p className="settings-detail-note">
              Both are remembered on this device only, and take effect everywhere in QBSheet as soon as they
              are chosen.
            </p>
            <BackToSettings onClick={() => setView('settings')} />
          </div>
        )}

        {view === 'recovery' && (
          <div className="settings-detail-view">
            <p className="settings-detail-intro">
              QBSheet keeps local protection on automatically. An external backup is optional and stores a
              normal, credential-free <code>.qbsheet</code> file outside browser storage.
            </p>

            <dl className="settings-facts">
              <div>
                <dt>Automatic protection</dt>
                <dd>
                  {localCheckpointStateLabel(localCheckpoints.state)}
                  {localCheckpoints.message ? ` · ${localCheckpoints.message}` : ''}
                </dd>
              </div>
              <div>
                <dt>External backup</dt>
                <dd>
                  {externalBackup.state === 'ready'
                    ? `${safeRecoveryFolderName(externalBackup.folderName)} · ${recoverySavedAtLabel(externalBackup.lastSavedAt)}`
                    : externalBackupStateLabel(externalBackup.state)}
                </dd>
              </div>
            </dl>

            <p className="settings-detail-note">
              {externalBackup.message ??
                (externalBackup.state === 'unsupported'
                  ? 'This browser does not support external backup folders. Local QBSheet recovery still works.'
                  : externalBackup.state === 'not-configured'
                    ? 'Choose a folder once to keep a live backup for each game. This is optional.'
                    : externalBackup.state === 'ready'
                      ? 'The live file updates in the background after scoring changes. A write failure never blocks scoring.'
                      : externalBackup.state === 'needs-permission'
                        ? 'The folder is remembered, but access needs to be allowed again. QBSheet has not requested permission automatically.'
                        : externalBackup.state === 'folder-unavailable'
                          ? 'Reconnect the folder to continue. Removing this configuration never deletes existing .qbsheet files.'
                          : 'The last external write failed. Local protection remains active while it is repaired.')}
            </p>

            {recoveryMessage && (
              <p
                className={recoveryMessage.kind === 'fail' ? 'shell-warning' : 'settings-acknowledgement'}
                role={recoveryMessage.kind === 'fail' ? 'alert' : 'status'}
              >
                {recoveryMessage.text}
              </p>
            )}

            <div className="shell-modal-actions">
              {externalBackup.state === 'not-configured' && recovery?.onSetupExternalBackup && (
                <button
                  type="button"
                  className="shell-button is-primary"
                  disabled={recoveryAction !== null}
                  onClick={() =>
                    void runRecoveryAction(
                      'external-backup',
                      recovery.onSetupExternalBackup,
                      'External backup setup completed.',
                      'QBSheet could not set up external backup. Local protection is still active.',
                    )
                  }
                >
                  {recoveryAction === 'external-backup' ? 'Working…' : 'Set up external backup…'}
                </button>
              )}
              {externalBackup.state === 'ready' && recovery?.onSetupExternalBackup && (
                <button
                  type="button"
                  className="shell-button"
                  disabled={recoveryAction !== null}
                  onClick={() =>
                    void runRecoveryAction(
                      'external-backup',
                      recovery.onSetupExternalBackup,
                      'External backup folder changed.',
                      'QBSheet could not change the external backup folder.',
                    )
                  }
                >
                  {recoveryAction === 'external-backup' ? 'Working…' : 'Change folder…'}
                </button>
              )}
              {externalBackup.state === 'ready' && recovery?.onManageExternalBackup && (
                <button
                  type="button"
                  className="shell-button"
                  disabled={recoveryAction !== null}
                  onClick={() =>
                    void runRecoveryAction(
                      'external-backup',
                      recovery.onManageExternalBackup,
                      'External backup settings opened.',
                      'QBSheet could not open external backup settings.',
                    )
                  }
                >
                  {recoveryAction === 'external-backup' ? 'Working…' : 'Manage external backup…'}
                </button>
              )}
              {(externalBackup.state === 'needs-permission' ||
                externalBackup.state === 'folder-unavailable' ||
                externalBackup.state === 'failed') &&
                (recovery?.onReconnectExternalBackup || recovery?.onSetupExternalBackup) && (
                  <button
                    type="button"
                    className="shell-button is-primary"
                    disabled={recoveryAction !== null}
                    onClick={() =>
                      void runRecoveryAction(
                        'external-backup',
                        recovery.onReconnectExternalBackup ?? recovery.onSetupExternalBackup,
                        'External backup reconnected.',
                        'QBSheet could not reconnect external backup. Local protection is still active.',
                      )
                    }
                  >
                    {recoveryAction === 'external-backup'
                      ? 'Working…'
                      : externalBackup.state === 'needs-permission'
                        ? 'Allow access'
                        : 'Reconnect'}
                  </button>
                )}
              {externalBackup.state === 'ready' &&
                recovery?.onRemoveExternalBackup &&
                !confirmingExternalBackupRemoval && (
                  <button
                    type="button"
                    className="settings-inline-action"
                    onClick={() => setConfirmingExternalBackupRemoval(true)}
                  >
                    Stop external backup…
                  </button>
                )}
              {confirmingExternalBackupRemoval && (
                <div className="settings-recovery-confirmation">
                  <p className="shell-warning" role="alert">
                    Stop remembering this folder? QBSheet will not delete any existing <code>.qbsheet</code>{' '}
                    files.
                  </p>
                  <button
                    type="button"
                    className="shell-button is-destructive"
                    disabled={recoveryAction !== null}
                    onClick={() => {
                      setConfirmingExternalBackupRemoval(false);
                      void runRecoveryAction(
                        'external-backup-remove',
                        recovery?.onRemoveExternalBackup,
                        'External backup configuration removed. Existing files were not deleted.',
                        'QBSheet could not remove the external backup configuration.',
                      );
                    }}
                  >
                    {recoveryAction === 'external-backup-remove' ? 'Working…' : 'Stop external backup'}
                  </button>
                  <button
                    type="button"
                    className="shell-button"
                    onClick={() => setConfirmingExternalBackupRemoval(false)}
                  >
                    Keep external backup
                  </button>
                </div>
              )}
            </div>

            {recovery?.onViewRecoveryStatus && (
              <button type="button" className="settings-inline-action" onClick={openFullRecoveryStatus}>
                Open full recovery status
              </button>
            )}
            <BackToSettings
              onClick={() => {
                setRecoveryMessage(null);
                setConfirmingExternalBackupRemoval(false);
                setView('settings');
              }}
            />
          </div>
        )}

        {view === 'shortcuts' && (
          <div className="settings-detail-view">
            <p className="settings-detail-intro">
              Keyboard scoring is optional. Choose a seat, then the ruling when that ruling exists in the
              current format.
            </p>
            <dl className="settings-shortcuts">
              <div>
                <dt>Left seats</dt>
                <dd>{keyboardSeatNumbers.left.join(', ')}</dd>
              </div>
              <div>
                <dt>Right seats</dt>
                <dd>{keyboardSeatNumbers.right.join(', ')}</dd>
              </div>
              <div>
                <dt>Seat then {keyboardActionLabels.correct}</dt>
                <dd>Ordinary {keyboardActionNames.correct.toLowerCase()}, when the format provides one</dd>
              </div>
              <div>
                <dt>Seat then {keyboardActionLabels.power}</dt>
                <dd>{keyboardActionNames.power}, when the format provides one</dd>
              </div>
              <div>
                <dt>Seat then {keyboardActionLabels.neg}</dt>
                <dd>{keyboardActionNames.neg}, when available</dd>
              </div>
              <div>
                <dt>Seat then {keyboardActionLabels.wrong}</dt>
                <dd>Wrong answer with no penalty</dd>
              </div>
              <div>
                <dt>{keyboardShortcutLabels.noBuzz}</dt>
                <dd>No buzz</dd>
              </div>
              <div>
                <dt>{keyboardShortcutLabels.undo}</dt>
                <dd>Undo</dd>
              </div>
              <div>
                <dt>{keyboardShortcutLabels.redo}</dt>
                <dd>Redo</dd>
              </div>
            </dl>
            <p className="settings-detail-note">
              Exact rulings and point values depend on the tournament format. The live scorer’s contextual map
              is authoritative.
            </p>
            <BackToSettings onClick={() => setView('settings')} />
          </div>
        )}

        {view === 'connection' && connection && (
          <div className="settings-detail-view">
            <dl className="settings-facts">
              <div>
                <dt>Room</dt>
                <dd>{connection.roomName}</dd>
              </div>
              <div>
                <dt>Tournament control</dt>
                <dd className="settings-address">{connection.address ?? 'Address unavailable'}</dd>
              </div>
            </dl>
            {onChangeTournament && (
              <>
                <button
                  type="button"
                  className="settings-inline-action"
                  disabled={pairingProtection !== undefined}
                  aria-describedby={pairingProtection ? 'settings-change-tournament-protection' : undefined}
                  onClick={() => {
                    onClose();
                    onChangeTournament();
                  }}
                >
                  Change tournament…
                </button>
                {pairingProtection && (
                  <p id="settings-change-tournament-protection" className="shell-hint">
                    {pairingProtection}
                  </p>
                )}
              </>
            )}
            <button type="button" className="settings-inline-action" onClick={() => setView('forget')}>
              Forget pairing…
            </button>
            <BackToSettings onClick={() => setView('settings')} />
          </div>
        )}

        {view === 'forget' && connection && (
          <div className="settings-detail-view">
            <p>
              Forget <strong>{connection.roomName}</strong> on this device?
            </p>
            <p>
              This removes this device’s saved tournament-control pairing. Saved games are not deleted, and
              the device can be paired again later.
            </p>
            {pairingProtection && (
              <p className="shell-warning" role="alert">
                {pairingProtection}
              </p>
            )}
            <div className="shell-modal-actions">
              <button
                type="button"
                className="shell-button is-destructive"
                data-settings-view-autofocus={pairingProtection === undefined ? true : undefined}
                disabled={pairingProtection !== undefined}
                onClick={() => {
                  onForgetPairing();
                  // Root, not the connection view: the pairing this device had is gone, and the
                  // subview that described it has nothing left to describe.
                  setView('settings');
                  setAcknowledgement('Tournament pairing forgotten.');
                }}
              >
                Forget {connection.roomName}
              </button>
              <button
                type="button"
                className="shell-button"
                data-settings-view-autofocus={pairingProtection !== undefined ? true : undefined}
                onClick={() => setView('connection')}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {view === 'advanced' && (
          <div className="settings-detail-view">
            <p className="settings-detail-intro">
              Infrequent device-level actions. Nothing here deletes a saved game.
            </p>
            <button type="button" className="settings-inline-action" onClick={() => setView('reset')}>
              Reset device preferences…
            </button>
            <BackToSettings onClick={() => setView('settings')} />
          </div>
        )}

        {view === 'reset' && (
          <div className="settings-detail-view">
            <p>Reset this device’s QBSheet preferences?</p>
            <p>
              This clears the scorekeeper name, first-run answer, keyboard-scoring choice, appearance and text
              size, and tournament pairing. Saved games are not deleted.
            </p>
            {pairingProtection && (
              <p className="shell-warning" role="alert">
                {pairingProtection}
              </p>
            )}
            <div className="shell-modal-actions">
              <button
                type="button"
                className="shell-button is-destructive"
                data-settings-view-autofocus={pairingProtection === undefined ? true : undefined}
                disabled={pairingProtection !== undefined}
                onClick={() => {
                  onResetDevicePreferences();
                  setView('settings');
                  setAcknowledgement('Device preferences reset.');
                }}
              >
                Reset preferences
              </button>
              <button
                type="button"
                className="shell-button"
                data-settings-view-autofocus={pairingProtection !== undefined ? true : undefined}
                onClick={() => setView('advanced')}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </NativeDialog>
  );
}
