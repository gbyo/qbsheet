import { IRecoveryFileHandle, IRecoveryWritableFile } from './RecoveryTypes';

export type ExternalWriteState = 'saved' | 'failed' | 'superseded';

export interface IExternalWriteResult {
  key: string;
  revision: number;
  state: ExternalWriteState;
  completedAt?: string;
  error?: unknown;
}

export interface IExternalBackupWriterOptions {
  /** A short debounce reduces bursts without delaying an explicit `flush`. */
  debounceMs?: number;
  now?: () => Date;
  onResult?: (result: IExternalWriteResult) => void;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface IPendingWrite {
  handle: IRecoveryFileHandle;
  contents: string;
  revision: number;
  waiters: Array<(result: IExternalWriteResult) => void>;
}

interface IFileQueue {
  newestRevision: number;
  active: boolean;
  activeRevision?: number;
  pending?: IPendingWrite;
  timer?: ReturnType<typeof setTimeout>;
  flushRequested: boolean;
  idleWaiters: Array<() => void>;
}

function safeCallback(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Observer failures must not break the writer's safety loop.
  }
}

/**
 * One serialized, coalescing writer per external backup file.
 *
 * A revision is supplied by the caller's scorer state. The queue refuses lower or equal revisions
 * after a newer one has been seen, which protects against delayed async callbacks publishing an old
 * snapshot after a correction. It never rejects a scoring operation: write errors are reported to
 * the optional observer and resolve as `failed`.
 */
export class CoalescingExternalBackupWriter {
  private readonly queues = new Map<string, IFileQueue>();
  private readonly debounceMs: number;
  private readonly now: () => Date;
  private readonly onResult?: (result: IExternalWriteResult) => void;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly cancelTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private nextRevision = 0;

  constructor(options: IExternalBackupWriterOptions = {}) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 250);
    this.now = options.now ?? (() => new Date());
    this.onResult = options.onResult;
    this.scheduleTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  }

  private queueFor(key: string): IFileQueue {
    const existing = this.queues.get(key);
    if (existing) return existing;
    const created: IFileQueue = {
      newestRevision: Number.NEGATIVE_INFINITY,
      active: false,
      flushRequested: false,
      idleWaiters: [],
    };
    this.queues.set(key, created);
    return created;
  }

  private result(result: IExternalWriteResult): IExternalWriteResult {
    try {
      this.onResult?.(result);
    } catch {
      // The status UI is advisory; it cannot be allowed to alter write ordering.
    }
    return result;
  }

  private resolveWaiters(
    waiters: Array<(result: IExternalWriteResult) => void>,
    result: IExternalWriteResult,
  ) {
    for (const resolve of waiters) resolve(this.result(result));
  }

  private resolveIdle(queue: IFileQueue): void {
    if (queue.active || queue.pending || queue.timer !== undefined) return;
    const waiters = queue.idleWaiters.splice(0);
    for (const resolve of waiters) safeCallback(resolve);
  }

  private schedule(key: string, queue: IFileQueue): void {
    if (queue.active || queue.pending === undefined || queue.timer !== undefined) return;
    if (queue.flushRequested) {
      void this.drain(key, queue);
      return;
    }
    queue.timer = this.scheduleTimer(() => {
      queue.timer = undefined;
      void this.drain(key, queue);
    }, this.debounceMs);
  }

  /**
   * Enqueue a complete serialized backup. Callers may intentionally ignore the returned promise;
   * it exists for tests and status surfaces, not as a prerequisite for scoring.
   */
  enqueue(
    key: string,
    handle: IRecoveryFileHandle,
    contents: string,
    revision?: number,
  ): Promise<IExternalWriteResult> {
    const queue = this.queueFor(key);
    const requestedRevision = revision ?? ++this.nextRevision;
    if (!Number.isFinite(requestedRevision)) {
      return Promise.resolve(this.result({ key, revision: requestedRevision, state: 'superseded' }));
    }
    if (requestedRevision <= queue.newestRevision) {
      return Promise.resolve(this.result({ key, revision: requestedRevision, state: 'superseded' }));
    }

    queue.newestRevision = requestedRevision;
    if (queue.pending) {
      this.resolveWaiters(queue.pending.waiters, {
        key,
        revision: queue.pending.revision,
        state: 'superseded',
      });
    }
    let resolvePromise!: (result: IExternalWriteResult) => void;
    const promise = new Promise<IExternalWriteResult>((resolve) => {
      resolvePromise = resolve;
    });
    queue.pending = {
      handle,
      contents,
      revision: requestedRevision,
      waiters: [resolvePromise],
    };
    this.schedule(key, queue);
    return promise;
  }

  private async closeAfterFailure(writable: IRecoveryWritableFile): Promise<void> {
    try {
      await writable.abort?.();
    } catch {
      // A failed stream may not support abort; the browser owns its temporary file cleanup.
    }
  }

  private async writeOne(key: string, pending: IPendingWrite): Promise<void> {
    let state: ExternalWriteState = 'failed';
    let error: unknown;
    let writable: IRecoveryWritableFile | null = null;
    try {
      writable = await pending.handle.createWritable();
      await writable.write(pending.contents);
      await writable.close();
      state = 'saved';
    } catch (caught) {
      error = caught;
      if (writable) await this.closeAfterFailure(writable);
    }
    const completedAt = (() => {
      try {
        return this.now().toISOString();
      } catch {
        return new Date().toISOString();
      }
    })();
    this.resolveWaiters(pending.waiters, {
      key,
      revision: pending.revision,
      state,
      completedAt,
      ...(error === undefined ? {} : { error }),
    });
  }

  private async drain(key: string, queue: IFileQueue): Promise<void> {
    if (queue.active || queue.pending === undefined) {
      this.resolveIdle(queue);
      return;
    }
    const pending = queue.pending;
    queue.pending = undefined;
    queue.active = true;
    queue.activeRevision = pending.revision;
    await this.writeOne(key, pending);
    queue.activeRevision = undefined;
    queue.active = false;
    if (queue.pending) {
      this.schedule(key, queue);
    } else {
      queue.flushRequested = false;
      this.resolveIdle(queue);
    }
  }

  /** Wait for all currently queued writes, bypassing debounce timers. */
  async flush(key?: string): Promise<void> {
    const keys = key === undefined ? [...this.queues.keys()] : [key];
    await Promise.all(
      keys.map(async (queueKey) => {
        const queue = this.queues.get(queueKey);
        if (!queue) return;
        queue.flushRequested = true;
        if (queue.timer !== undefined) {
          this.cancelTimer(queue.timer);
          queue.timer = undefined;
        }
        this.schedule(queueKey, queue);
        if (queue.active || queue.pending) {
          await new Promise<void>((resolve) => queue.idleWaiters.push(resolve));
        }
        queue.flushRequested = false;
      }),
    );
  }

  /** Cancel future debounce timers and resolve pending writes as superseded; an active write is not interrupted. */
  dispose(): void {
    for (const [key, queue] of this.queues) {
      if (queue.timer !== undefined) {
        this.cancelTimer(queue.timer);
        queue.timer = undefined;
      }
      if (queue.pending) {
        this.resolveWaiters(queue.pending.waiters, {
          key,
          revision: queue.pending.revision,
          state: 'superseded',
        });
        queue.pending = undefined;
      }
      queue.flushRequested = false;
      this.resolveIdle(queue);
    }
  }
}
