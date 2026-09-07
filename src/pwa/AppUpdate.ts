/**
 * Replacing the running application, and refusing to.
 *
 * # The rule
 *
 * A new build never takes over a device that has a game on screen. Not when the deploy is urgent, not
 * when the running build is the one with the bug, not when the room is between rounds but has not
 * said so. A scoresheet that reloads itself under a scorekeeper's hands in the middle of a bonus is a
 * worse failure than any bug an update could fix, because the fix is one round away and the lost
 * question is not.
 *
 * # How the rule is kept
 *
 * Three mechanisms, and none of them is "remember to only render the button on the right screen":
 *
 *   1. The generated worker does not call `skipWaiting()` on install (see `vite.config.ts`). A new
 *      build installs, sits in `waiting`, and owns nothing. The old worker keeps serving the old
 *      cache to the page that is mid-game.
 *   2. `apply()` refuses unless the application has declared itself replaceable. The default is that
 *      it is not. A component that should not have been able to call this cannot cause the swap by
 *      calling it anyway.
 *   3. The reload is only performed for a swap this module initiated. The first install of a worker
 *      on a fresh device also fires `controllerchange`, and reloading for that would restart the
 *      application under somebody the moment they first opened it.
 *
 * # What the room is told
 *
 * That an update exists, and when it will happen — not that it should be dealt with. During a game
 * the notice says the update will apply afterwards and offers nothing to press, because there is
 * nothing a scorekeeper should be doing about it mid-round. The button appears at home and on the
 * room screen, where pressing it costs nothing.
 *
 * # Detection has to be active
 *
 * A browser checks for a new worker on navigation, and a tournament Chromebook does not navigate: it
 * is opened at eight and is still open at five. So the registration is polled, quietly, only while
 * the tab is visible and the network is up — a check that fires into a dead venue Wi-Fi teaches
 * nothing and a check nobody is looking at can wait.
 */

/** How often an open tab asks whether a newer build has been deployed. */
export const updateCheckIntervalMs = 15 * 60 * 1000;

/** How long an attempted worker takeover may wait for activation before it can be retried. */
export const updateApplyTimeoutMs = 10 * 1000;

/** What the build serving this page says about itself, when it can be asked. */
export interface IWorkerBuild {
  version: string;
  commit: string;
  builtAt: string;
  /** The shell cache this worker owns. Distinguishes two deploys of the same commit. */
  cache: string;
}

export interface IAppUpdateState {
  /** A newer build is installed and waiting for permission to replace the running one. */
  available: boolean;
  /** A swap this module started is in flight. The reload is imminent. */
  applying: boolean;
}

/**
 * The parts of the service-worker API this module uses, named structurally.
 *
 * Written out rather than taken from `lib.dom` so the decision logic can be driven by a fake in a
 * test. Every interesting behaviour here is a sequence of events over time, which is exactly the kind
 * of thing that is never exercised by a real browser in a unit test and always broken in production.
 */
export interface IWorkerLike {
  state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

export interface IRegistrationLike {
  installing: IWorkerLike | null;
  waiting: IWorkerLike | null;
  update(): Promise<unknown>;
  addEventListener(type: 'updatefound', listener: () => void): void;
  removeEventListener(type: 'updatefound', listener: () => void): void;
}

export interface IContainerLike {
  controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

/**
 * Whether a waiting worker is an update to offer, or the first one this device ever installed.
 *
 * The distinction matters because both produce a worker in `waiting` on some browsers, and calling
 * the first install an update offers a scorekeeper an Update now button that reloads them into the
 * build they are already running — which looks exactly like the application being broken.
 */
export function updateReady(registration: IRegistrationLike, controlled: boolean): boolean {
  return controlled && registration.waiting !== null;
}

export class AppUpdateWatcher {
  private state: IAppUpdateState = { available: false, applying: false };

  private readonly listeners = new Set<(state: IAppUpdateState) => void>();

  private registration: IRegistrationLike | null = null;

  private container: IContainerLike | null = null;

  /**
   * Whether the application currently has nothing on screen that an update could damage.
   *
   * Starts false. An update deferred by a device that never got round to declaring itself safe is a
   * device running last week's build, which is a nuisance; an update applied to a device that was
   * mid-game because the flag defaulted the other way costs somebody a round.
   */
  private replaceable = false;

  private timer: ReturnType<typeof setInterval> | null = null;

  private applyResetTimer: ReturnType<typeof setTimeout> | null = null;

  private applyingWorker: IWorkerLike | null = null;

  private applyingWorkerStateHandler: (() => void) | null = null;

  private updateFoundHandler: (() => void) | null = null;

  private controllerChangeHandler: (() => void) | null = null;

  private readonly reload: () => void;

  constructor(options: { reload?: () => void } = {}) {
    this.reload =
      options.reload ??
      (() => {
        window.location.reload();
      });
  }

  snapshot(): IAppUpdateState {
    return this.state;
  }

  subscribe(listener: (state: IAppUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(change: Partial<IAppUpdateState>): void {
    const next = { ...this.state, ...change };
    if (next.available === this.state.available && next.applying === this.state.applying) return;
    this.state = next;
    this.listeners.forEach((listener) => listener(next));
  }

  private clearApplyingWorkerListener(): void {
    if (this.applyingWorker && this.applyingWorkerStateHandler) {
      this.applyingWorker.removeEventListener('statechange', this.applyingWorkerStateHandler);
    }
    this.applyingWorker = null;
    this.applyingWorkerStateHandler = null;
  }

  /**
   * Finish a swap this watcher initiated.
   *
   * `controllerchange` is the ideal signal, but browsers also expose the waiting worker's own state.
   * The generated worker does its cache cleanup and `clients.claim()` inside the activate event's
   * `waitUntil`, so reaching `activated` is also a safe point to reload. Listening to both avoids an
   * update button that appears to do nothing when a browser delays or misses `controllerchange`.
   */
  private completeApply(): void {
    if (!this.state.applying) return;
    if (this.applyResetTimer !== null) clearTimeout(this.applyResetTimer);
    this.applyResetTimer = null;
    this.clearApplyingWorkerListener();
    this.publish({ available: false, applying: false });
    this.reload();
  }

  private abandonApply(): void {
    if (this.applyResetTimer !== null) clearTimeout(this.applyResetTimer);
    this.applyResetTimer = null;
    this.clearApplyingWorkerListener();
    this.publish({ applying: false });
    this.evaluate();
  }

  /** Clear transient apply state, primarily for a fresh observation or a test boundary. */
  reset(): void {
    if (this.applyResetTimer !== null) clearTimeout(this.applyResetTimer);
    this.applyResetTimer = null;
    this.clearApplyingWorkerListener();
    this.publish({ applying: false });
  }

  /**
   * Declare whether the running application may be replaced.
   *
   * Called from wherever knows what is on screen. Turning it off does not cancel a swap already in
   * flight, because by then the new worker is activating and the honest thing is to complete the
   * reload rather than leave the page controlled by a worker whose cache has been deleted.
   */
  setReplaceable(replaceable: boolean): void {
    this.replaceable = replaceable;
  }

  /** Begin watching a registration for newer builds. */
  observe(registration: IRegistrationLike, container: IContainerLike): void {
    // Observing twice would otherwise leave the first interval and event handlers running forever.
    this.stop();
    this.registration = registration;
    this.container = container;

    this.evaluate();

    this.updateFoundHandler = () => {
      // `installing` is the new worker. It is not an update to offer until it has finished
      // installing — a download that is still in flight, or that fails, must not put a button on
      // screen that reloads into a half-cached build.
      const installing = registration.installing;
      if (!installing) {
        this.evaluate();
        return;
      }
      const onChange = () => {
        if (installing.state === 'installed' || installing.state === 'redundant') {
          installing.removeEventListener('statechange', onChange);
        }
        this.evaluate();
      };
      installing.addEventListener('statechange', onChange);
    };
    registration.addEventListener('updatefound', this.updateFoundHandler);

    this.controllerChangeHandler = () => {
      // Only a swap this module asked for. A first install also lands here, and reloading for that
      // would restart the application the instant somebody opened it for the first time.
      this.completeApply();
    };
    container.addEventListener('controllerchange', this.controllerChangeHandler);

    this.timer = setInterval(() => void this.checkNow(), updateCheckIntervalMs);
  }

  stop(): void {
    if (this.registration && this.updateFoundHandler) {
      this.registration.removeEventListener('updatefound', this.updateFoundHandler);
    }
    if (this.container && this.controllerChangeHandler) {
      this.container.removeEventListener('controllerchange', this.controllerChangeHandler);
    }
    this.registration = null;
    this.container = null;
    this.updateFoundHandler = null;
    this.controllerChangeHandler = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.applyResetTimer !== null) clearTimeout(this.applyResetTimer);
    this.applyResetTimer = null;
    this.clearApplyingWorkerListener();
    this.publish({ available: false, applying: false });
  }

  private evaluate(): void {
    const registration = this.registration;
    if (!registration) return;
    this.publish({ available: updateReady(registration, this.container?.controller != null) });
  }

  /**
   * Ask whether a newer build has been deployed.
   *
   * Silent about failure. A venue whose Wi-Fi has dropped, or whose captive portal is answering for
   * the origin, produces a rejected update check several times an hour, and none of those is
   * something to tell a room about.
   */
  async checkNow(): Promise<void> {
    const registration = this.registration;
    if (!registration) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      await registration.update();
    } catch {
      // Nothing to say and nothing to do; the next check is a quarter of an hour away.
    }
    this.evaluate();
  }

  /**
   * Replace the running application with the waiting build, if that is currently allowed.
   *
   * Returns whether the swap was started, so a caller that reached this while a game was live finds
   * out rather than assuming. The reload happens once either the container reports `controllerchange`
   * or the worker reaches `activated`; both are after the generated worker's activate work, including
   * `clients.claim()`, has completed. Reloading before then can land back on the old worker and looks
   * exactly like an update button that did nothing.
   */
  apply(): boolean {
    const waiting = this.registration?.waiting;
    if (!waiting || !this.replaceable || this.state.applying) return false;

    this.publish({ applying: true });
    this.applyingWorker = waiting;
    this.applyingWorkerStateHandler = () => {
      if (waiting.state === 'activated') {
        this.completeApply();
        return;
      }
      if (waiting.state === 'redundant') this.abandonApply();
    };
    waiting.addEventListener('statechange', this.applyingWorkerStateHandler);

    try {
      waiting.postMessage('qbsheet:skip-waiting');
    } catch {
      this.abandonApply();
      return false;
    }

    this.applyResetTimer = setTimeout(() => {
      this.applyResetTimer = null;
      this.clearApplyingWorkerListener();
      this.publish({ applying: false });
      this.evaluate();
    }, updateApplyTimeoutMs);
    return true;
  }
}

/** The application's watcher. Started by `registerServiceWorker`. */
export const appUpdates = new AppUpdateWatcher();

/**
 * What the worker actually serving this page reports about itself.
 *
 * Worth asking separately from `buildVersion`, which describes the bundle that is executing. Those
 * two can disagree: a page reloaded while online is served a fresh `index.html` off the network and
 * runs new code, while the old worker still owns the cache underneath it. A room behaving like it is
 * running last week's build is usually this, and it is invisible from anywhere else.
 *
 * Resolves to null rather than rejecting — no worker, no support, or a worker that does not answer
 * are all just an absent line in a diagnostics file.
 */
export async function serviceWorkerBuild(timeoutMs = 1500): Promise<IWorkerBuild | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const worker = navigator.serviceWorker.controller;
  if (!worker) return null;
  return new Promise<IWorkerBuild | null>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      const value: unknown = event.data;
      if (value === null || typeof value !== 'object') {
        resolve(null);
        return;
      }
      const candidate = value as Partial<IWorkerBuild>;
      resolve(
        typeof candidate.commit === 'string' && typeof candidate.cache === 'string'
          ? {
              version: typeof candidate.version === 'string' ? candidate.version : '',
              commit: candidate.commit,
              builtAt: typeof candidate.builtAt === 'string' ? candidate.builtAt : '',
              cache: candidate.cache,
            }
          : null,
      );
    };
    try {
      worker.postMessage('qbsheet:build', [channel.port2]);
    } catch {
      clearTimeout(timer);
      channel.port1.close();
      resolve(null);
    }
  });
}
