// host.http: the only way a module reaches the network. SSRF boundary: the hostname is resolved exactly
// once, every address is classified, and the socket is opened to an already-checked address.
import type dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import type BetterSqlite3 from 'better-sqlite3';
import { DashError, type HostServices, type HttpOptions, type HttpResult, type ModuleId, type ModuleManifest } from '@dash/contract';
import { cacheKey, readCache, refreshCache, writeCache } from './cache.ts';
import { checkAddresses, checkUrl, effectivePort, urlHostname, type Rule } from './guard.ts';
import { decideRedirect, REDIRECT_STATUSES } from './redirect.ts';

export { classifyAddress } from './guard.ts';
export { purgeExpiredCache } from './cache.ts';

export interface ConnectTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
}

export interface HttpDeps {
  db: BetterSqlite3.Database;
  lookup: typeof dns.lookup;
  /** Admin-configured device list (hosts or host:port) of the module. */
  lanDevices: (moduleId: ModuleId) => string[];
  /** Clock; the factory wiring passes the real clock when omitted. */
  now?: () => Date;
  /** Test hook only: redirect the connection for an already-checked address. Production passes nothing. */
  connect?: (target: ConnectTarget) => { address: string; port: number };
}

const DEFAULT_TIMEOUT = 10_000;
const MAX_TIMEOUT = 30_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const MAX_MAX_BYTES = 20_000_000;
const STRIPPED = new Set(['cookie', 'host', 'content-length', 'transfer-encoding', 'connection', 'accept-encoding']);
const KEY_HEADERS = new Set(['accept', 'accept-language', 'authorization']);

interface State {
  req?: http.ClientRequest;
  /** Aborted by the total deadline: nothing new may start once it fires. */
  ctrl: AbortController;
}

function assertLive(st: State): void {
  if (st.ctrl.signal.aborted) throw upstream('Request timed out');
}

function upstream(msg: string): DashError {
  return new DashError('upstream', msg);
}

function errMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return `Request failed${typeof code === 'string' ? ` (${code})` : ''}`;
}

async function resolveAll(lookup: typeof dns.lookup, hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }];
  return new Promise((resolve, reject) => {
    (lookup as unknown as (h: string, o: object, cb: (e: Error | null, r: dns.LookupAddress[]) => void) => void)(
      hostname,
      { all: true, verbatim: true },
      (err, res) => {
        if (err) reject(upstream(errMessage(err)));
        else resolve(res.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 })));
      },
    );
  });
}

function pinnedLookup(address: string, family: 4 | 6) {
  return (_h: string, o: unknown, cb: (...a: unknown[]) => void): void => {
    if (typeof o === 'object' && o !== null && (o as { all?: boolean }).all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

interface Hop {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
  address: string;
  family: 4 | 6;
}

function requestOnce(hop: Hop, deps: HttpDeps, st: State): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (st.ctrl.signal.aborted) {
      reject(upstream('Request timed out'));
      return;
    }
    const { url } = hop;
    const isHttps = url.protocol === 'https:';
    const hostname = urlHostname(url);
    const port = effectivePort(url);
    const target = deps.connect?.({ hostname, address: hop.address, family: hop.family, port }) ?? {
      address: hop.address,
      port,
    };
    const headers: Record<string, string | number> = { ...hop.headers, host: url.host, connection: 'close' };
    if (hop.body !== undefined) headers['content-length'] = hop.body.byteLength;
    const options: https.RequestOptions = {
      host: target.address,
      port: target.port,
      method: hop.method,
      path: url.pathname + url.search,
      headers,
      agent: false,
      lookup: pinnedLookup(target.address, hop.family) as never,
    };
    if (isHttps && !isIP(hostname)) options.servername = hostname;
    const req = (isHttps ? https : http).request(options, resolve);
    st.req = req;
    st.ctrl.signal.addEventListener('abort', () => req.destroy(), { once: true });
    req.on('error', (e) => reject(upstream(errMessage(e))));
    req.end(hop.body === undefined ? undefined : Buffer.from(hop.body));
  });
}

async function readBody(res: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const enc = String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  let src: NodeJS.ReadableStream = res;
  if (enc === 'gzip' || enc === 'x-gzip') src = pipeline(res, zlib.createGunzip(), () => {});
  else if (enc === 'br') src = pipeline(res, zlib.createBrotliDecompress(), () => {});
  else if (enc === 'deflate') src = pipeline(res, zlib.createInflate(), () => {});
  else if (enc !== 'identity' && enc !== '') throw upstream('Unsupported content encoding');
  if (enc === 'identity' || enc === '') {
    const len = Number(res.headers['content-length']);
    if (Number.isFinite(len) && len > maxBytes) throw upstream('Response too large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of src) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > maxBytes) throw upstream('Response too large');
      chunks.push(buf);
    }
  } catch (e) {
    if (e instanceof DashError) throw e;
    throw upstream(errMessage(e));
  }
  return Buffer.concat(chunks, total);
}

function cleanHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const name = k.toLowerCase();
    if (name === 'set-cookie' || v === undefined) continue;
    out[name] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function shape<T>(body: Buffer, as: 'json' | 'text' | 'buffer'): T {
  if (as === 'buffer') return new Uint8Array(body) as T;
  const text = body.toString('utf8');
  if (as === 'text') return text as T;
  if (text.trim() === '') return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw upstream('Response is not valid JSON');
  }
}

export function createHttp(moduleId: ModuleId, manifest: ModuleManifest, deps: HttpDeps): HostServices['http'] {
  const now = deps.now ?? ((): Date => new Date());

  async function run(url0: string, opts: HttpOptions, st: State): Promise<{ status: number; headers: Record<string, string>; body: Buffer; fromCache: boolean }> {
    const rule: Rule = opts.rule ?? 'host';
    const method = opts.method ?? 'GET';
    const maxBytes = Math.min(Math.max(opts.maxBytes ?? DEFAULT_MAX_BYTES, 1), MAX_MAX_BYTES);
    let url: URL;
    try {
      url = new URL(url0);
    } catch {
      throw new DashError('invalid', 'Invalid URL');
    }
    const callerHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      const name = k.toLowerCase();
      if (!STRIPPED.has(name)) callerHeaders[name] = String(v);
    }
    const devices = rule === 'lanDevice' ? deps.lanDevices(moduleId) : [];
    checkUrl(url, rule, manifest, devices);

    const ttl = opts.ttlSec ?? 0;
    const cacheable = method === 'GET' && ttl > 0;
    const key = cacheable
      ? cacheKey(moduleId, method, url.href, Object.fromEntries(Object.entries(callerHeaders).filter(([k]) => KEY_HEADERS.has(k))))
      : '';
    let stale: ReturnType<typeof readCache>;
    if (cacheable) {
      const row = readCache(deps.db, key);
      if (row && row.body && row.body.length <= maxBytes) {
        if (row.expires_at > now().toISOString()) {
          return { status: row.status, headers: JSON.parse(row.headers) as Record<string, string>, body: row.body, fromCache: true };
        }
        if (row.etag) stale = row;
      }
    }

    const headers: Record<string, string> = { 'user-agent': 'home-dashboard', ...callerHeaders, 'accept-encoding': 'gzip, br' };
    if (stale?.etag) headers['if-none-match'] = stale.etag;
    let body: Uint8Array | undefined = typeof opts.body === 'string' ? Buffer.from(opts.body) : opts.body;
    let hopMethod = method;

    for (let hops = 0; ; hops++) {
      assertLive(st);
      const addrs = await resolveAll(deps.lookup, urlHostname(url));
      assertLive(st);
      checkAddresses(rule, addrs.map((a) => a.address));
      const chosen = addrs[0]!;
      const res = await requestOnce(
        { url, method: hopMethod, headers, body, address: chosen.address, family: chosen.family },
        deps,
        st,
      );
      assertLive(st);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECT_STATUSES.includes(status) && location) {
        res.destroy();
        st.req?.destroy();
        const d = decideRedirect({ current: url, status, location, rule, hops });
        const next = d.url;
        checkUrl(next, rule, manifest, devices);
        if (d.scrubHeaders) {
          for (const k of Object.keys(headers)) {
            if (k !== 'user-agent' && k !== 'accept-encoding') delete headers[k];
          }
        }
        if (!d.preserveMethodAndBody) {
          hopMethod = 'GET';
          body = undefined;
          delete headers['content-type'];
        }
        url = next;
        continue;
      }
      const respHeaders = cleanHeaders(res.headers);
      if (status === 304 && stale) {
        assertLive(st);
        res.destroy();
        st.req?.destroy();
        refreshCache(deps.db, key, new Date(now().getTime() + ttl * 1000).toISOString());
        return { status: stale.status, headers: JSON.parse(stale.headers) as Record<string, string>, body: stale.body!, fromCache: true };
      }
      let buf: Buffer;
      try {
        buf = await readBody(res, maxBytes);
      } finally {
        res.destroy();
        st.req?.destroy();
      }
      assertLive(st);
      if (cacheable && status === 200) {
        writeCache(deps.db, {
          key,
          status,
          headers: respHeaders,
          body: buf,
          expiresAt: new Date(now().getTime() + ttl * 1000).toISOString(),
          etag: respHeaders.etag ?? null,
        });
      }
      return { status, headers: respHeaders, body: buf, fromCache: false };
    }
  }

  return {
    async fetch<T = unknown>(url: string, opts: HttpOptions = {}): Promise<HttpResult<T>> {
      const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT, 1), MAX_TIMEOUT);
      const st: State = { ctrl: new AbortController() };
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          st.ctrl.abort();
          st.req?.destroy();
          reject(upstream('Request timed out'));
        }, timeoutMs);
      });
      const work = run(url, opts, st);
      work.catch(() => {});
      try {
        const r = await Promise.race([work, deadline]);
        return { status: r.status, headers: r.headers, data: shape<T>(r.body, opts.as ?? 'json'), fromCache: r.fromCache };
      } catch (e) {
        st.ctrl.abort();
        st.req?.destroy();
        if (e instanceof DashError) throw e;
        throw upstream(errMessage(e));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
