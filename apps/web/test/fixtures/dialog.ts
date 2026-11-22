/**
 * jsdom's <dialog> support is partial (`showModal`/`close` may be missing and there is no Escape handling).
 * Importing this file polyfills open/close; focus trapping is a browser feature and is not simulated.
 */
const proto = HTMLDialogElement.prototype;
if (typeof proto.showModal !== 'function') {
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
if (typeof proto.close !== 'function') {
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
