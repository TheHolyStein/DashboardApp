import { updater } from './lib/update.svelte.js';

// An external module (no inline script: the server's CSP forbids it). Production builds only.
if (import.meta.env.PROD) {
  window.addEventListener('load', () => void updater.register('/sw.js'));
}
