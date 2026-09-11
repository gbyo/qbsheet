import '@testing-library/jest-dom/vitest';

/*
 * React Aria measures overlays, and jsdom implements none of the geometry APIs it reaches for.
 * Without these, a popover renders but every position is NaN and the tests fail on layout rather
 * than on behaviour, which is the thing actually under test.
 */
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!globalThis.DOMRect) {
  globalThis.DOMRect = class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    top = 0;
    left = 0;
    right = 0;
    bottom = 0;
    toJSON() {
      return {};
    }
    static fromRect() {
      return new globalThis.DOMRect();
    }
  } as unknown as typeof DOMRect;
}
