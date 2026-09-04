import { useId, useState } from 'react';
import ScorerDialog from '../ScorerDialog';
import { matchSecretCommand, secretCommands, SecretCommand } from './secretState';

const descriptions: Record<SecretCommand, string> = {
  qbbird: 'A flight between rounds',
  snake: 'One more tossup card',
  dvd: 'Let the wordmark wander',
  stats: 'A few things worth counting',
};

export default function CommandLauncher({
  onCommand,
  onClose,
}: {
  onCommand: (command: SecretCommand) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const id = useId();
  const matches = secretCommands.filter((command) => command.startsWith(query.trim().toLowerCase()));
  return (
    <ScorerDialog title="A little detour" onClose={onClose}>
      <label className="visually-hidden" htmlFor={id}>
        Command
      </label>
      <input
        id={id}
        className="secret-command-input"
        data-dialog-autofocus
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={`${id}-options`}
        aria-activedescendant={matches[selected] ? `${id}-${matches[selected]}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="Type a command…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setSelected((index) =>
              matches.length
                ? (index + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length
                : 0,
            );
          }
          if (event.key === 'Enter' && !event.repeat) {
            event.preventDefault();
            const command = matchSecretCommand(query) ?? matches[selected];
            if (command) onCommand(command);
          }
        }}
      />
      <div role="listbox" id={`${id}-options`} aria-label="Commands" className="secret-command-list">
        {matches.map((command, index) => (
          <button
            type="button"
            tabIndex={-1}
            key={command}
            id={`${id}-${command}`}
            role="option"
            aria-selected={index === selected}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCommand(command)}
          >
            <strong>{command}</strong>
            <span>{descriptions[command]}</span>
          </button>
        ))}
      </div>
      {matches.length === 0 && <p className="scorer-dialog-note">No matching commands.</p>}
      <p className="scorer-dialog-note">↑ ↓ to choose · Enter to open · Escape to return</p>
    </ScorerDialog>
  );
}
