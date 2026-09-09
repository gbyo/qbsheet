/**
 * `ResizeObserver` for jsdom.
 *
 * Every Director menu is a `cmdk` command list, and `cmdk` measures its own list to publish the
 * `--cmdk-list-height` custom property an animated popover would size itself from. jsdom has no
 * `ResizeObserver`, so without this the observer's constructor throws inside a commit-phase effect
 * and every test that opens a menu dies there.
 *
 * The shim observes nothing: jsdom lays nothing out, so a real implementation would report zero
 * anyway, and nothing under test reads the measurement. It installs only where the API is missing,
 * so a jsdom that grows one takes over.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver;
}
