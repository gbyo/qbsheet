/**
 * `BroadcastChannel`, scoped to the test file that is running.
 *
 * jsdom does not implement `BroadcastChannel`, so the bare global the application resolves is
 * Node's — and Node's is deliberately cross-thread: every worker in the process is one more
 * listener on the same channel. Under the fork pool that was invisible, because a file was a
 * process. Under the thread pool it means the duplicate-tab guard sees the *other test files*
 * running alongside it as rival tabs, and files that never mention tabs at all get sent to the
 * "already open in another tab" screen.
 *
 * A test file is one device. This is the same interface backed by a bus that lives in this
 * realm only, so two channels in one file still hear each other — which is what the guard's own
 * tests need — and two files never do.
 */
class RealmBroadcastChannel implements EventTarget {
  private static readonly buses = new Map<string, Set<RealmBroadcastChannel>>();

  private readonly listeners = new Set<EventListenerOrEventListenerObject>();
  private closed = false;

  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly name: string) {
    const bus = RealmBroadcastChannel.buses.get(name) ?? new Set<RealmBroadcastChannel>();
    bus.add(this);
    RealmBroadcastChannel.buses.set(name, bus);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new DOMException('Channel is closed', 'InvalidStateError');
    const bus = RealmBroadcastChannel.buses.get(this.name);
    if (!bus) return;
    // The real one never delivers to the sender, and never delivers synchronously.
    for (const peer of [...bus]) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => peer.deliver(data));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.onmessage = null;
    const bus = RealmBroadcastChannel.buses.get(this.name);
    bus?.delete(this);
    if (bus && bus.size === 0) RealmBroadcastChannel.buses.delete(this.name);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type !== 'message' || !listener) return;
    this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type !== 'message' || !listener) return;
    this.listeners.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    this.deliver((event as MessageEvent).data);
    return true;
  }

  private deliver(data: unknown): void {
    if (this.closed) return;
    const event = { data, type: 'message' } as MessageEvent;
    this.onmessage?.(event);
    for (const listener of [...this.listeners]) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

Object.defineProperty(globalThis, 'BroadcastChannel', {
  configurable: true,
  writable: true,
  value: RealmBroadcastChannel,
});

export {};
