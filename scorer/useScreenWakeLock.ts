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
    const acquire = async () => {
      if (!active || document.visibilityState === 'hidden' || sentinel.current) return;
      const { wakeLock } = navigator as INavigatorWithWakeLock;
      if (!wakeLock) return;
      try {
        const next = await wakeLock.request('screen');
        if (cancelled || !active) {
          await next.release().catch(() => undefined);
          return;
        }
        sentinel.current = next;
      } catch {
        // Unsupported, denied or unavailable is all the same to the scorer: continue normally.
      }
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
