/**
 * `<dialog>` for jsdom.
 *
 * Director's modals, sheets, and confirmations are native `<dialog>` elements
 * opened with `showModal()`, because that is what gives them the platform's own
 * focus trap, top layer, backdrop, `aria-modal`, and Escape handling rather
 * than a hand-rolled imitation.
 *
 * jsdom implements the element but none of those three methods, so without this
 * every test that opens a Director dialog dies inside a commit-phase effect with
 * `dialog.showModal is not a function`. The shim is deliberately minimal — it
 * keeps `open` in step and fires `close`/`cancel`, which is all the tests
 * observe — and it installs only where the real methods are missing, so a jsdom
 * that grows them takes over.
 */
const proto = globalThis.HTMLDialogElement?.prototype;

if (proto && typeof proto.showModal !== 'function') {
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
    // Real modals are the only interactive content while open. Tests query by
    // role, so marking the element is enough for `aria-modal` assertions.
    this.setAttribute('open', '');
  };
  proto.show = function show(this: HTMLDialogElement) {
    this.open = true;
    this.setAttribute('open', '');
  };
  proto.close = function close(this: HTMLDialogElement, returnValue?: string) {
    if (!this.open) return;
    this.open = false;
    this.removeAttribute('open');
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event('close'));
  };
}
