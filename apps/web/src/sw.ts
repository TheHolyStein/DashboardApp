// Service worker (built by vite-plugin-pwa, injectManifest). It never touches /api, /dav or /.well-known:
// no route is registered for them, so those requests go straight to the network.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { StaleWhileRevalidate } from 'workbox-strategies';
import { routeKind } from './sw-routing.js';

// Minimal view of the worker scope (the app's tsconfig has the DOM lib, not the WebWorker lib).
declare global {
  interface Window {
    __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
  }
}

const scope = self as unknown as {
  location: { origin: string };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
};

precacheAndRoute(self.__WB_MANIFEST); // replaced with the build's file list
cleanupOutdatedCaches();

// Page loads fall back to the cached shell (index.html is in the precache).
registerRoute(
  ({ url, request }) => routeKind(url, request, scope.location.origin) === 'navigation',
  createHandlerBoundToURL('/index.html'),
);

// Module and theme chunks and theme images that are not precached.
registerRoute(
  ({ url, request }) => routeKind(url, request, scope.location.origin) === 'asset',
  new StaleWhileRevalidate({ cacheName: 'dash-assets' }),
);

// A new version waits until the user clicks "Update available — reload".
scope.addEventListener('message', (e) => {
  if (typeof e.data === 'object' && e.data !== null && (e.data as { type?: unknown }).type === 'SKIP_WAITING') void scope.skipWaiting();
});
