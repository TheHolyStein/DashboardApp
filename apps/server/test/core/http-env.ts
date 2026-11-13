// Local throwaway servers and injected DNS for host.http tests: nothing touches the real network.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type dns from 'node:dns';
import type { ModuleManifest, OutboundRule } from '@dash/contract';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { createHttp } from '../../src/core/http/client.ts';

export interface TestServer {
  port: number;
  hits: http.IncomingMessage[];
  sockets: Set<import('node:net').Socket>;
  close(): Promise<void>;
}

export async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void,
): Promise<TestServer> {
  const hits: http.IncomingMessage[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const onReq = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    hits.push(req);
    handler(req, res, hits.length);
  };
  const server = http.createServer(onReq);
  server.on('connection', (s: import('node:net').Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    sockets,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Fake DNS: maps hostnames to address lists; counts lookups. */
export function fakeLookup(
  map: Record<string, string[]>,
  delays: Record<string, number> = {},
): typeof dns.lookup & { calls: string[] } {
  const calls: string[] = [];
  const fn = (host: string, _o: unknown, cb: (e: Error | null, r: unknown) => void): void => {
    calls.push(host);
    const list = map[host];
    const late = delays[host];
    if (late) {
      setTimeout(() => cb(null, (list ?? []).map((address) => ({ address, family: 4 }))), late);
      return;
    }
    if (!list) {
      cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
      return;
    }
    cb(null, list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
  return Object.assign(fn, { calls }) as unknown as typeof dns.lookup & { calls: string[] };
}

export function manifestWith(...outbound: OutboundRule[]): ModuleManifest {
  return { id: 'demo', outbound } as unknown as ModuleManifest;
}

export interface HttpEnv {
  db: ReturnType<typeof openDb>;
  http: ReturnType<typeof createHttp>;
  lookup: ReturnType<typeof fakeLookup>;
  clock: { t: number };
}

/** `port` directs every connection (after the guard passed) to a local server. */
export function makeHttp(opts: {
  outbound: OutboundRule[];
  dns?: Record<string, string[]>;
  port?: number;
  lan?: string[];
  lookupDelays?: Record<string, number>;
}): HttpEnv {
  const db = openDb(':memory:');
  migrateCore(db);
  const lookup = fakeLookup(opts.dns ?? {}, opts.lookupDelays);
  const clock = { t: Date.parse('2026-11-12T10:00:00.000Z') };
  const h = createHttp('demo', manifestWith(...opts.outbound), {
    db,
    lookup,
    lanDevices: () => opts.lan ?? [],
    now: () => new Date(clock.t),
    ...(opts.port !== undefined ? { connect: (t) => ({ address: '127.0.0.1', port: opts.port ?? t.port }) } : {}),
  });
  return { db, http: h, lookup, clock };
}
