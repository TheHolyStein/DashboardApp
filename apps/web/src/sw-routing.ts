/** Request routing of the service worker as pure functions (the worker imports them; tests call them directly). */

/** Paths that belong to the server: the worker has no handler for them, so the browser goes to the network. */
export const NEVER_HANDLED: readonly string[] = ['/api', '/dav', '/.well-known'];

export interface RequestLike {
  mode: string;
  method: string;
}

export type RouteKind = 'navigation' | 'asset' | null;

const excluded = (path: string): boolean => NEVER_HANDLED.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * `navigation`: a page load, answered with the cached shell when offline (served from the precache);
 * `asset`: a same-origin `/assets/*` file (stale-while-revalidate); `null`: not handled at all.
 */
export function routeKind(url: URL, request: RequestLike, origin: string = url.origin): RouteKind {
  if (url.origin !== origin || request.method !== 'GET' || excluded(url.pathname)) return null;
  if (request.mode === 'navigate') return 'navigation';
  if (url.pathname.startsWith('/assets/')) return 'asset';
  return null;
}

export function shouldHandle(url: URL, request: RequestLike, origin: string = url.origin): boolean {
  return routeKind(url, request, origin) !== null;
}
