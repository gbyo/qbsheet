import { useEffect, useRef } from 'react';

interface IWakeLockSentinel {
  release: () => Promise<void>;
}

type INavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<IWakeLockSentinel> };
};

/** Best-effort screen wake lock. Scoring remains correct when the browser does not implement it. */
export default function useScreenWakeLock(active: boolean): void {
  const sentinel = useRef<IWakeLockSentinel | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const release = async () => {
      const { current } = sentinel;
      sentinel.current = null;
      if (!current) return;
      try {
        await current.release();
      } catch {
        // A browser may already have released it while suspending the page.
      }
    };
    const releaseResolved = async (next: IWakeLockSentinel) => {
      await next.release().catch(() => undefined);
    };
    const acquire = async (): Promise<void> => {
      if (!active || document.visibilityState !== 'visible' || sentinel.current) return;
      if (inFlight.current) {
        await inFlight.current;
        if (!cancelled) await acquire();
        return;
      }
      const { wakeLock } = navigator as INavigatorWithWakeLock;
      if (!wakeLock) return;
      const request = wakeLock
        .request('screen')
        .then(async (next) => {
          if (cancelled || !active || document.visibilityState !== 'visible' || sentinel.current) {
            await releaseResolved(next);
            return undefined;
          }
          sentinel.current = next;
          return undefined;
        })
        .catch(() => {
          // Unsupported, denied or unavailable is all the same to the scorer: continue normally.
          return undefined;
        })
        .finally(() => {
          if (inFlight.current === request) inFlight.current = null;
        });
      inFlight.current = request;
      await request;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire().catch(() => undefined);
      else release().catch(() => undefined);
    };

    if (active) acquire().catch(() => undefined);
    else release().catch(() => undefined);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      release().catch(() => undefined);
    };
  }, [active]);
}
