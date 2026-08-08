import { useState } from 'react';
import {
  helpRequestCategoryLabels,
  HelpRequestCategory,
  IHelpRequest,
  IRoomPresence,
} from '../main/server/ServerTypes';

interface IRoomOperatorControlsProps {
  operatorName: string;
  ready: boolean;
  readyAllowed: boolean;
  presence: IRoomPresence | null;
  helpRequest: IHelpRequest | null;
  helpBusy: boolean;
  // eslint-disable-next-line react/require-default-props
  compact?: boolean;
  onOperatorNameChange: (name: string) => void;
  onReadyChange: (ready: boolean) => void;
  onRequestHelp: (category: HelpRequestCategory, message: string) => Promise<void>;
  onCancelHelp: () => Promise<void>;
  onChangeRoom: () => void;
}

const categories: Array<[HelpRequestCategory, string]> = [
  ['wrong-matchup', helpRequestCategoryLabels['wrong-matchup']],
  ['team-missing', helpRequestCategoryLabels['team-missing']],
  ['rules-question', helpRequestCategoryLabels['rules-question']],
  ['scoring-problem', helpRequestCategoryLabels['scoring-problem']],
  ['device-network', helpRequestCategoryLabels['device-network']],
  ['wrong-room', helpRequestCategoryLabels['wrong-room']],
  ['other', helpRequestCategoryLabels.other],
];

/**
 * Small, keyboard-friendly operational controls shared by the waiting and scoring screens.
 *
 * `compact` is for the scoring screen, where this sits between the status bar and the scoresheet and
 * every row it takes is a row of MODAQ pushed off a Chromebook's screen. It collapses to a single
 * line: the name field, Ready, and the two text actions on the same row, with the "Operator" caption
 * left in the accessibility tree but out of the layout. The waiting screen has room to spare and
 * keeps the full-size version.
 */
export default function RoomOperatorControls(props: IRoomOperatorControlsProps) {
  const {
    operatorName,
    ready,
    readyAllowed,
    presence,
    helpRequest,
    helpBusy,
    compact = false,
    onOperatorNameChange,
    onReadyChange,
    onRequestHelp,
    onCancelHelp,
    onChangeRoom,
  } = props;
  const [helpOpen, setHelpOpen] = useState(false);
  const [category, setCategory] = useState<HelpRequestCategory>('scoring-problem');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const submitHelp = async () => {
    setError('');
    try {
      await onRequestHelp(category, message);
      setMessage('');
      setHelpOpen(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not send the help request.');
    }
  };

  const cancelHelp = () => {
    onCancelHelp().catch((requestError: unknown) => {
      setError(requestError instanceof Error ? requestError.message : 'Could not cancel the help request.');
    });
  };

  return (
    <section className={`room-operator-controls${compact ? ' is-compact' : ''}`} aria-label="Room controls">
      <div className="room-operator-row">
        <label className="room-operator-name" htmlFor="room-operator-name">
          <span className="room-operator-caption">Operator</span>
          <input
            id="room-operator-name"
            value={operatorName}
            onChange={(event) => onOperatorNameChange(event.target.value)}
            // The caption is hidden when compact, so the placeholder has to carry the meaning.
            placeholder={compact ? 'Operator name (optional)' : 'Optional name'}
            maxLength={80}
          />
        </label>
        <button
          type="button"
          className={ready ? 'room-button room-button-ready' : 'room-button room-button-secondary'}
          onClick={() => onReadyChange(!ready)}
          disabled={!ready && !readyAllowed}
          aria-pressed={ready}
          title={
            readyAllowed
              ? undefined
              : 'Ready becomes available after this browser connects and loads usable scoring rules.'
          }
        >
          {ready ? 'Ready' : 'Mark ready'}
        </button>
        <span className="room-presence-note">
          {presence?.connected
            ? `${presence.readyDeviceCount ?? 0} device${presence.readyDeviceCount === 1 ? '' : 's'} ready`
            : 'Not connected'}
        </span>
      </div>

      <div className="room-operator-actions">
        {helpRequest ? (
          <div className="room-help-active" role="status">
            <strong>Help requested</strong>
            <span>{helpRequestCategoryLabels[helpRequest.category]}</span>
            <button type="button" className="room-text-button" onClick={cancelHelp} disabled={helpBusy}>
              Cancel request
            </button>
          </div>
        ) : (
          <button type="button" className="room-text-button" onClick={() => setHelpOpen((open) => !open)}>
            Need help
          </button>
        )}
        <button type="button" className="room-text-button" onClick={onChangeRoom}>
          Change room
        </button>
      </div>

      {helpOpen && !helpRequest && (
        <div className="room-help-form">
          <label htmlFor="room-help-category">
            Help category
            <select
              id="room-help-category"
              value={category}
              onChange={(event) => setCategory(event.target.value as HelpRequestCategory)}
            >
              {categories.map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="room-help-message">
            Note <span className="room-muted">(optional)</span>
            <textarea
              id="room-help-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={500}
              rows={2}
            />
          </label>
          {error !== '' && <div className="room-banner room-banner-error">{error}</div>}
          <div className="room-help-form-actions">
            <button type="button" className="room-button room-button-secondary" onClick={() => setHelpOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="room-button"
              onClick={() => {
                submitHelp().catch((requestError: unknown) => {
                  setError(requestError instanceof Error ? requestError.message : 'Could not send the help request.');
                });
              }}
              disabled={helpBusy}
            >
              {helpBusy ? 'Sending…' : 'Send help request'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
