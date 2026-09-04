import { useState } from 'react';
import { IGameDefinition } from '../game/GameDefinition';
import { IManualGameInput } from '../game/ManualGame';
import ManualGameEditor from './ManualGameEditor';
import {
  clearManualGameDraft,
  hasManualInput,
  manualDraftStorageKey,
  readManualGamePresets,
  rememberManualGamePreset,
} from './ManualGameDraft';
import { useManualGameDraft } from './useManualGameDraft';
export {
  manualDraftStorageKey,
  manualPresetStorageKey,
  readManualGameDraft,
  clearManualGameDraft,
  readManualGamePresets,
  rememberManualGamePreset,
} from './ManualGameDraft';
export type { IManualGamePreset } from './ManualGameDraft';

/** Scorer-owned draft, navigation and handoff; the fields are shared with the standalone creator. */
export default function ManualGameSetup(props: {
  initialInput?: IManualGameInput;
  onStart: (definition: IGameDefinition) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { input, setInput, draftSaveState } = useManualGameDraft(manualDraftStorageKey, props.initialInput);
  const [presets, setPresets] = useState(readManualGamePresets);
  return (
    <main className="shell manual-shell">
      <header className="shell-header">
        <h1 className="shell-title">Create a game</h1>
        <p className="shell-subtitle">
          For a practice, scrimmage, tryout or pickup game. Once it starts it is an ordinary QBSheet game,
          saved on this device like any other.
        </p>
      </header>
      <ManualGameEditor
        input={input}
        setInput={setInput}
        presets={presets}
        draftSaveState={draftSaveState}
        onSubmit={async (submitted, definition) => {
          await props.onStart(definition);
          setPresets(rememberManualGamePreset(submitted));
          clearManualGameDraft();
        }}
        onCancel={() => {
          if (hasManualInput(input) && !window.confirm('Discard this game setup?')) return;
          clearManualGameDraft();
          props.onCancel();
        }}
      />
    </main>
  );
}
