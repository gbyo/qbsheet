import { IRecoveryCheckpointInput } from './RecoveryTypes';

export interface ICoalescedCheckpointWriterOptions {
  debounceMs?: number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface IPendingCheckpoint {
  input: IRecoveryCheckpointInput;
  revision: number;
  waiters: Array<(saved: boolean) => void>;
}

interface ICheckpointQueue {
  newestRevision: number;
  active: boolean;
  pending?: IPendingCheckpoint;
  timer?: ReturnType<typeof setTimeout>;
  flushRequested: boolean;
  idleWaiters: Array<() => void>;
}

/**
 * Coalesce ultra-fast exact checkpoint requests independently for each game.
 *
 * A false result means either persistence failed or that this revision was superseded. In both
 * cases the scorer remains usable; the next newest state is still attempted when one exists.
 */
export class CoalescingCheckpointWriter {
  private readonly queues = new Map<string, ICheckpointQueue>();
  private readonly debounceMs: number;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly cancelTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private nextRevision = 0;

  constructor(
    private readonly write: (input: IRecoveryCheckpointInput) => Promise<boolean>,
    options: ICoalescedCheckpointWriterOptions = {},
  ) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 100);
    this.scheduleTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  }

  private queueFor(gameKey: string): ICheckpointQueue {
    const existing = this.queues.get(gameKey);
    if (existing) return existing;
    const queue: ICheckpointQueue = {
      newestRevision: Number.NEGATIVE_INFINITY,
      active: false,
      flushRequested: false,
      idleWaiters: [],
    };
    this.queues.set(gameKey, queue);
    return queue;
  }

  private resolveIdle(queue: ICheckpointQueue): void {
    if (queue.active || queue.pending || queue.timer !== undefined) return;
    const waiters = queue.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private schedule(gameKey: string, queue: ICheckpointQueue): void {
    if (queue.active || !queue.pending || queue.timer !== undefined) return;
    if (queue.flushRequested) {
      void this.drain(gameKey, queue);
      return;
    }
    queue.timer = this.scheduleTimer(() => {
      queue.timer = undefined;
      void this.drain(gameKey, queue);
    }, this.debounceMs);
  }

  enqueue(gameKey: string, input: IRecoveryCheckpointInput, revision?: number): Promise<boolean> {
    const queue = this.queueFor(gameKey);
    const requestedRevision = revision ?? ++this.nextRevision;
    if (!Number.isFinite(requestedRevision) || requestedRevision <= queue.newestRevision) {
      return Promise.resolve(false);
    }
    queue.newestRevision = requestedRevision;
    if (queue.pending) {
      for (const resolve of queue.pending.waiters) resolve(false);
    }
    let resolvePromise!: (saved: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });
    queue.pending = { input, revision: requestedRevision, waiters: [resolvePromise] };
    this.schedule(gameKey, queue);
    return result;
  }

  private async drain(gameKey: string, queue: ICheckpointQueue): Promise<void> {
    if (queue.active || !queue.pending) {
      this.resolveIdle(queue);
      return;
    }
    const pending = queue.pending;
    queue.pending = undefined;
    queue.active = true;
    let saved = false;
    try {
      saved = await this.write(pending.input);
    } catch {
      saved = false;
    }
    for (const resolve of pending.waiters) resolve(saved);
    queue.active = false;
    if (queue.pending) this.schedule(gameKey, queue);
    else {
      queue.flushRequested = false;
      this.resolveIdle(queue);
    }
  }

  async flush(gameKey?: string): Promise<void> {
    const keys = gameKey === undefined ? [...this.queues.keys()] : [gameKey];
    await Promise.all(
      keys.map(async (key) => {
        const queue = this.queues.get(key);
        if (!queue) return;
        queue.flushRequested = true;
        if (queue.timer !== undefined) {
          this.cancelTimer(queue.timer);
          queue.timer = undefined;
        }
        this.schedule(key, queue);
        if (queue.active || queue.pending) {
          await new Promise<void>((resolve) => queue.idleWaiters.push(resolve));
        }
        queue.flushRequested = false;
      }),
    );
  }

  dispose(): void {
    for (const queue of this.queues.values()) {
      if (queue.timer !== undefined) {
        this.cancelTimer(queue.timer);
        queue.timer = undefined;
      }
      if (queue.pending) {
        for (const resolve of queue.pending.waiters) resolve(false);
        queue.pending = undefined;
      }
      queue.flushRequested = false;
      this.resolveIdle(queue);
    }
  }
}
