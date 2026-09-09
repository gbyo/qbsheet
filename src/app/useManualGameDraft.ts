import { useCallback, useEffect, useState, type SetStateAction } from 'react';
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
  const [input, setInputState] = useState(
    () => initialInput ?? readManualGameDraft(storageKey) ?? emptyInput(),
  );
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>('not-saved');
  const dirty = hasManualInput(input);
  const setupUnsaved = dirty && draftSaveState !== 'saved';
  const setInput = useCallback((next: SetStateAction<IManualGameInput>) => {
    // The saved state belongs to the previous input. Mark a new edit unsafe synchronously so a
    // navigation cannot slip through while React is waiting for the deferred write to run.
    setDraftSaveState('not-saved');
    setInputState(next);
  }, []);
  useLeaveWarning({
    gameInProgress: false,
    localSaveFailed: draftSaveState === 'failed',
    handoffOutstanding: false,
    setupUnsaved,
  });
  useEffect(() => {
    const persist = (updateState: boolean) => {
      const storage = manualDraftStorage();
      if (!storage) {
        if (updateState) setDraftSaveState(dirty ? 'failed' : 'not-saved');
        return;
      }
      try {
        if (dirty) storage.setItem(storageKey, JSON.stringify(input));
        else storage.removeItem(storageKey);
        if (updateState) setDraftSaveState(dirty ? 'saved' : 'not-saved');
      } catch {
        if (updateState) setDraftSaveState('failed');
      }
    };

    const timer = window.setTimeout(() => persist(true), 0);
    return () => {
      window.clearTimeout(timer);
      // A navigation can unmount this editor before the deferred save gets a turn. Persist the
      // committed draft during cleanup so the most recent typed setup is not lost on that path.
      persist(false);
    };
  }, [dirty, input, storageKey]);
  return { input, setInput, draftSaveState };
}
