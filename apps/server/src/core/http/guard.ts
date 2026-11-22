// Request-forgery guard: address classification and per-rule URL validation.
import { isIP } from 'node:net';
import { DashError, type ModuleManifest } from '@dash/contract';

export type AddressClass = 'public' | 'private' | 'loopback' | 'linklocal' | 'reserved';

function classifyV4(o: readonly number[]): AddressClass {
  const [a = 0, b = 0, c = 0] = o;
  if (a === 0) return 'reserved';
  if (a === 10) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT, also Tailscale
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'linklocal';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved';
  if (a === 192 && b === 168) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a === 198 && b === 51 && c === 100) return 'reserved';
  if (a === 203 && b === 0 && c === 113) return 'reserved';
  if (a >= 224) return 'reserved'; // multicast, class E, broadcast
  return 'public';
}

function parseV4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Parses an IPv6 text form into 8 16-bit groups; null when invalid. */
function parseV6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (isIP(s) !== 6) return null;
  // Embedded dotted IPv4 tail.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    const hex = ((v4[0]! << 8) | v4[1]!).toString(16) + ':' + ((v4[2]! << 8) | v4[3]!).toString(16);
    s = s.slice(0, lastColon + 1) + hex;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function v4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

export function classifyAddress(ip: string): AddressClass {
  const v4 = parseV4(ip);
  if (v4) return classifyV4(v4);
  const g = parseV6(ip);
  if (!g) return 'reserved';
  const g0 = g[0]!;
  const allZero = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 7)) {
    if (g[7] === 0) return 'reserved'; // ::
    if (g[7] === 1) return 'loopback'; // ::1
  }
  // IPv4-compatible (::a.b.c.d) and IPv4-mapped (::ffff:a.b.c.d)
  if (allZero(0, 6) || (allZero(0, 5) && g[5] === 0xffff)) return classifyV4(v4FromGroups(g[6]!, g[7]!));
  // NAT64 64:ff9b::/96
  if (g0 === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return classifyV4(v4FromGroups(g[6]!, g[7]!));
  // 6to4 2002::/16 embeds an IPv4 address
  if (g0 === 0x2002) return classifyV4(v4FromGroups(g[1]!, g[2]!));
  if ((g0 & 0xffc0) === 0xfe80) return 'linklocal';
  if ((g0 & 0xffc0) === 0xfec0) return 'reserved'; // deprecated site-local
  if ((g0 & 0xfe00) === 0xfc00) return 'private';
  if ((g0 & 0xff00) === 0xff00) return 'reserved';
  if (g0 === 0x2001 && g[1] === 0x0db8) return 'reserved';
  return 'public';
}

export type Rule = 'host' | 'publicUrl' | 'lanDevice';

export interface ParsedLanEntry {
  host: string;
  port: number | null;
}

function normHost(h: string): string {
  let host = h.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  try {
    const u = new URL(`http://${host.includes(':') ? `[${host}]` : host}`);
    host = u.hostname;
  } catch {
    return host;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

export function parseLanEntry(entry: string): ParsedLanEntry {
  const e = entry.trim();
  if (e.startsWith('[')) {
    const close = e.indexOf(']');
    if (close > 0) {
      const portPart = e.slice(close + 1);
      const port = /^:\d+$/.test(portPart) ? Number(portPart.slice(1)) : null;
      return { host: normHost(e.slice(1, close)), port };
    }
  }
  const colons = e.split(':').length - 1;
  if (colons === 1) {
    const [h = '', p = ''] = e.split(':');
    return { host: normHost(h), port: /^\d+$/.test(p) ? Number(p) : null };
  }
  return { host: normHost(e), port: null };
}

export function effectivePort(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

/** Hostname without IPv6 brackets, as normalised by the WHATWG URL parser. */
export function urlHostname(u: URL): string {
  const h = u.hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** Static (pre-DNS) validation of a URL under a rule. Throws forbidden. */
export function checkUrl(
  u: URL,
  rule: Rule,
  manifest: Pick<ModuleManifest, 'outbound'>,
  lanDevices: readonly string[],
): void {
  if (u.username || u.password) throw new DashError('forbidden', 'URLs with credentials are not allowed');
  const hostname = urlHostname(u).toLowerCase();
  if (rule === 'host') {
    if (u.protocol !== 'https:') throw new DashError('forbidden', 'host rule requires https');
    if (u.port !== '') throw new DashError('forbidden', 'host rule requires the default port');
    const ok = manifest.outbound.some((r) => r.kind === 'host' && r.host.toLowerCase() === hostname);
    if (!ok) throw new DashError('forbidden', `host not allowed: ${hostname}`);
  } else if (rule === 'publicUrl') {
    if (!manifest.outbound.some((r) => r.kind === 'publicUrl')) {
      throw new DashError('forbidden', 'module has no publicUrl outbound rule');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new DashError('forbidden', 'scheme not allowed');
    const port = effectivePort(u);
    if (port !== 80 && port !== 443) throw new DashError('forbidden', 'port not allowed');
  } else if (rule === 'lanDevice') {
    if (!manifest.outbound.some((r) => r.kind === 'lanDevice')) {
      throw new DashError('forbidden', 'module has no lanDevice outbound rule');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new DashError('forbidden', 'scheme not allowed');
    const port = effectivePort(u);
    const ok = lanDevices.some((raw) => {
      const e = parseLanEntry(raw);
      return e.host === hostname && (e.port === null || e.port === port);
    });
    if (!ok) throw new DashError('forbidden', `device not configured: ${hostname}`);
  } else {
    throw new DashError('forbidden', 'unknown rule');
  }
}

/** Checks every resolved address against the rule's required class. Throws forbidden. */
export function checkAddresses(rule: Rule, addresses: readonly string[]): void {
  if (addresses.length === 0) throw new DashError('upstream', 'host did not resolve');
  const need: AddressClass = rule === 'lanDevice' ? 'private' : 'public';
  for (const a of addresses) {
    if (classifyAddress(a) !== need) throw new DashError('forbidden', `address not allowed for rule ${rule}`);
  }
}
