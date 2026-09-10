import { useCallback, useEffect, useRef, useState } from 'react';
import { getCloseGuardRequest, getClosePerformer, registerCloseGuardRequest } from '../platform/closeGuard';
import type { CloseReadiness, DirectorController } from '../state/useDirectorController';

export type CloseGuardPhase = 'idle' | 'flushing' | 'blocked';

export type CloseGuardBlock = Extract<CloseReadiness, { status: 'blocked' }>;

/** The controller surface the exit guard needs; a narrow Pick keeps tests light. */
export type CloseGuardController = Pick<
  DirectorController,
  'canLeaveCurrentDocument' | 'prepareForClose' | 'retryPersistence'
>;

export interface CloseGuard {
  phase: CloseGuardPhase;
  blockedCheck: CloseGuardBlock | null;
  /** True when a native shell installed a real window close (destructive quit available). */
  canForceClose: boolean;
  /**
   * Run the guarded close: flush persistence, then resolve true only when the
   * current revision is durable. Concurrent calls share one attempt and never
   * fork duplicate flushes.
   */
  requestClose(): Promise<boolean>;
  /** Abandon a pending close; the app stays open. */
  cancelClose(): void;
  /** Retry the failed save, then re-run the guarded close. */
  retryClose(): Promise<boolean>;
  /** Native-only destructive exit used by the explicit quit-without-saving path. */
  quitWithoutSaving(): void;
}

/**
 * Process-exit durability guard (#731). The native shell calls the registered
 * `requestClose` from its `onCloseRequested` interception; the blocked and
 * flushing phases drive the quit dialogs rendered by DirectorApp.
 */
export function useCloseGuard(controller: CloseGuardController): CloseGuard {
  const [phase, setPhase] = useState<CloseGuardPhase>('idle');
  const [blockedCheck, setBlockedCheck] = useState<CloseGuardBlock | null>(null);
  const [canForceClose] = useState(() => getClosePerformer() !== null);
  const controllerRef = useRef(controller);
  useEffect(() => {
    controllerRef.current = controller;
  });
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const cancelledRef = useRef(false);

  const requestClose = useCallback((): Promise<boolean> => {
    if (inFlightRef.current) return inFlightRef.current;
    cancelledRef.current = false;
    const run = (async (): Promise<boolean> => {
      setPhase('flushing');
      setBlockedCheck(null);
      try {
        for (;;) {
          if (cancelledRef.current) return false;
          const readiness = await controllerRef.current.prepareForClose();
          if (cancelledRef.current) return false;
          if (readiness.status === 'blocked') {
            setBlockedCheck(readiness);
            setPhase('blocked');
            return false;
          }
          // prepareForClose resolves safe against the counters it observed;
          // re-check synchronously so a mutation that landed in the gap
          // loops back into the flush instead of racing window.close().
          if (controllerRef.current.canLeaveCurrentDocument().ok) {
            setPhase('idle');
            return true;
          }
        }
      } catch {
        // Fail closed: an unexpected guard error must never read as safe.
        setPhase('idle');
        return false;
      }
    })();
    inFlightRef.current = run;
    const release = () => {
      if (inFlightRef.current === run) inFlightRef.current = null;
    };
    run.then(release, release);
    return run;
  }, []);

  const cancelClose = useCallback((): void => {
    cancelledRef.current = true;
    inFlightRef.current = null;
    setBlockedCheck(null);
    setPhase('idle');
  }, []);

  const retryClose = useCallback(async (): Promise<boolean> => {
    await controllerRef.current.retryPersistence();
    return requestClose();
  }, [requestClose]);

  const quitWithoutSaving = useCallback((): void => {
    getClosePerformer()?.();
  }, []);

  useEffect(() => {
    registerCloseGuardRequest(requestClose);
    return () => {
      if (getCloseGuardRequest() === requestClose) registerCloseGuardRequest(null);
    };
  }, [requestClose]);

  return { phase, blockedCheck, canForceClose, requestClose, cancelClose, retryClose, quitWithoutSaving };
}
