import { useEffect, useState } from 'react';
import { IManualGameInput } from '../game/ManualGame';
import {
  DraftSaveState,
  emptyInput,
  hasManualInput,
  manualDraftStorage,
  readManualGameDraft,
} from './ManualGameDraft';
import useLeaveWarning from './useLeaveWarning';

/** Each editing surface owns its storage key. Scanning never mounts this hook. */
export function useManualGameDraft(storageKey: string, initialInput?: IManualGameInput) {
  const [input, setInput] = useState(() => initialInput ?? readManualGameDraft(storageKey) ?? emptyInput());
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>('not-saved');
  const dirty = hasManualInput(input);
  useLeaveWarning({
    gameInProgress: false,
    localSaveFailed: draftSaveState === 'failed',
    handoffOutstanding: false,
    setupDirty: dirty,
  });
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storage = manualDraftStorage();
      if (!storage) {
        setDraftSaveState(dirty ? 'failed' : 'not-saved');
        return;
      }
      try {
        if (dirty) storage.setItem(storageKey, JSON.stringify(input));
        else storage.removeItem(storageKey);
        setDraftSaveState(dirty ? 'saved' : 'not-saved');
      } catch {
        setDraftSaveState('failed');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [dirty, input, storageKey]);
  return { input, setInput, draftSaveState };
}
