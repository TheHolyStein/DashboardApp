// Pure redirect decision for host.http: no I/O, so the policy can be unit-tested.
import { DashError } from '@dash/contract';
import { urlHostname, type Rule } from './guard.ts';

export const MAX_REDIRECTS = 3;
export const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

export interface RedirectDecision {
  url: URL;
  /** 307/308 keep method and body; everything else becomes a body-less GET. */
  preserveMethodAndBody: boolean;
  /** Origin (scheme, host or port) changed: caller-supplied headers must be dropped. */
  scrubHeaders: boolean;
}

/**
 * `hops` is the number of redirects already followed. Throws `upstream` for too many redirects or an
 * unparsable Location, `forbidden` for https->http and (rule host) a different host. The caller still
 * validates the returned URL under the rule (manifest, ports, devices, addresses).
 */
export function decideRedirect(input: { current: URL; status: number; location: string; rule: Rule; hops: number }): RedirectDecision {
  const { current, status, location, rule, hops } = input;
  if (hops >= MAX_REDIRECTS) throw new DashError('upstream', 'Too many redirects');
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new DashError('upstream', 'Invalid redirect');
  }
  if (current.protocol === 'https:' && next.protocol === 'http:') {
    throw new DashError('forbidden', 'Redirect from https to http is not allowed');
  }
  if (rule === 'host' && urlHostname(next).toLowerCase() !== urlHostname(current).toLowerCase()) {
    throw new DashError('forbidden', 'Redirect to a different host is not allowed');
  }
  return {
    url: next,
    preserveMethodAndBody: status === 307 || status === 308,
    scrubHeaders: next.origin !== current.origin,
  };
}
