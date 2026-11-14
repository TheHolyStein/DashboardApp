import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/svelte';

/**
 * jsdom's <dialog> support is partial: `showModal`/`close` may be missing. Polyfill the parts the Pane
 * relies on (open attribute, close event). Modal focus trapping and Escape-to-cancel are browser
 * features and are not simulated; tests dispatch `cancel`/keydown themselves.
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

afterEach(() => cleanup());
