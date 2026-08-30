import { FormEvent, useEffect, useRef, useState } from 'react';
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

export interface ISettingsConnection {
  /** Human-facing room label only. Never a room id. */
  roomName: string;
  /** Already passed through `safeAddress` by App. */
  address?: string;
}

type SettingsView = 'settings' | 'scorekeeper' | 'shortcuts' | 'forget' | 'reset';

function dialogTitle(view: SettingsView, firstRun: boolean): string {
  if (view === 'scorekeeper') return firstRun ? 'Who is scoring?' : 'Scorekeeper';
  if (view === 'shortcuts') return 'Keyboard shortcuts';
  if (view === 'forget') return 'Forget tournament pairing?';
  if (view === 'reset') return 'Reset device preferences?';
  return 'Settings';
}

/** Fixed display order, lightest-touch first, so the list reads as an escalation rather than a set. */
const appearanceOrder: Appearance[] = ['system', 'light', 'dark'];
const textSizeOrder: TextSize[] = ['standard', 'comfortable', 'large'];

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
    onChangeTournament,
    onClose,
    initialView = 'settings',
    firstRun = false,
  } = props;
  const [view, setView] = useState<SettingsView>(initialView);
  const [draft, setDraft] = useState(operatorName);
  const [scorekeeperReturnsToSettings, setScorekeeperReturnsToSettings] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const keyboardEnabled = useKeyboardEnabled();
  const { appearance, textSize } = useDisplayPreferences();

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

            <section className="settings-section" aria-labelledby="settings-scorekeeper-heading">
              <h3 id="settings-scorekeeper-heading" className="settings-section-title">
                Scorekeeper
              </h3>
              <div className="settings-row">
                <div>
                  <span className="settings-row-label">Scorekeeper</span>
                  <span className="settings-row-detail">
                    {operatorName.trim() === '' ? 'Not set' : operatorName}
                  </span>
                </div>
                <button
                  type="button"
                  className="settings-action"
                  data-dialog-autofocus
                  data-settings-view-autofocus
                  onClick={openScorekeeper}
                >
                  {operatorName.trim() === '' ? 'Set name' : 'Edit'}
                </button>
              </div>
            </section>

            <section className="settings-section" aria-labelledby="settings-display-heading">
              <h3 id="settings-display-heading" className="settings-section-title">
                Display
              </h3>
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
            </section>

            <section className="settings-section" aria-labelledby="settings-scoring-heading">
              <h3 id="settings-scoring-heading" className="settings-section-title">
                Scoring
              </h3>
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
              <div className="settings-row">
                <span className="settings-row-label">Keyboard shortcuts</span>
                <button type="button" className="settings-action" onClick={() => setView('shortcuts')}>
                  View
                </button>
              </div>
            </section>

            {connection && (
              <section className="settings-section" aria-labelledby="settings-connection-heading">
                <h3 id="settings-connection-heading" className="settings-section-title">
                  Tournament connection
                </h3>
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
                      aria-describedby={
                        pairingProtection ? 'settings-change-tournament-protection' : undefined
                      }
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
              </section>
            )}

            <section className="settings-section" aria-labelledby="settings-device-heading">
              <h3 id="settings-device-heading" className="settings-section-title">
                Device
              </h3>
              <button
                type="button"
                className="settings-navigation-row"
                onClick={() => {
                  onClose();
                  onReadiness();
                }}
              >
                <span>Check this device</span>
                <span aria-hidden="true">›</span>
              </button>
            </section>

            <section className="settings-section" aria-labelledby="settings-advanced-heading">
              <h3 id="settings-advanced-heading" className="settings-section-title">
                Advanced
              </h3>
              <button type="button" className="settings-inline-action" onClick={() => setView('reset')}>
                Reset device preferences…
              </button>
            </section>

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
            <button
              type="button"
              className="shell-button"
              data-settings-view-autofocus
              onClick={() => setView('settings')}
            >
              Back to Settings
            </button>
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
                onClick={() => setView('settings')}
              >
                Cancel
              </button>
            </div>
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
                onClick={() => setView('settings')}
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
