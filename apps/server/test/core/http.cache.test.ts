import { afterEach, describe, expect, it } from 'vitest';
import { purgeExpiredCache } from '../../src/core/http/client.ts';
import { makeHttp, startServer, type TestServer } from './http-env.ts';

let srv: TestServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const DNS = { 'feed.example': ['93.184.216.34'] };
const URL_ = 'http://feed.example/x';

describe('host.http cache', () => {
  it('second GET within ttl is fromCache and makes no request', async () => {
    srv = await startServer((_q, res) => res.end('{"v":1}'));
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], dns: DNS, port: srv.port });
    const o = { rule: 'publicUrl', ttlSec: 60 } as const;
    const a = await e.http.fetch(URL_, o);
    e.clock.t += 30_000;
    const b = await e.http.fetch(URL_, o);
    expect(a.fromCache).toBe(false);
    expect(b).toMatchObject({ fromCache: true, data: { v: 1 }, status: 200 });
    expect(srv.hits.length).toBe(1);
  });

  it('after ttl sends If-None-Match and 304 refreshes ttl', async () => {
    srv = await startServer((q, res) => {
      if (q.headers['if-none-match'] === '"e1"') res.writeHead(304).end();
      else res.writeHead(200, { etag: '"e1"' }).end('{"v":1}');
    });
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], dns: DNS, port: srv.port });
    const o = { rule: 'publicUrl', ttlSec: 60 } as const;
    await e.http.fetch(URL_, o);
    e.clock.t += 61_000;
    const b = await e.http.fetch(URL_, o);
    expect(srv.hits[1]?.headers['if-none-match']).toBe('"e1"');
    expect(b).toMatchObject({ fromCache: true, data: { v: 1 } });
    e.clock.t += 30_000; // still inside the refreshed ttl
    await e.http.fetch(URL_, o);
    expect(srv.hits.length).toBe(2);
  });

  it('POST is never cached', async () => {
    srv = await startServer((_q, res) => res.end('{}'));
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], dns: DNS, port: srv.port });
    const o = { rule: 'publicUrl', ttlSec: 60, method: 'POST', body: 'x' } as const;
    await e.http.fetch(URL_, o);
    await e.http.fetch(URL_, o);
    expect(srv.hits.length).toBe(2);
    expect(e.db.prepare('SELECT count(*) AS n FROM http_cache').get()).toEqual({ n: 0 });
  });

  it('keys on accept headers, skips non-200 and oversize cached bodies', async () => {
    srv = await startServer((q, res) => {
      if (q.url === '/err') res.writeHead(500).end('{}');
      else res.end('{"big":"' + 'x'.repeat(500) + '"}');
    });
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], dns: DNS, port: srv.port });
    const o = { rule: 'publicUrl', ttlSec: 60 } as const;
    await e.http.fetch(URL_, o);
    await e.http.fetch(URL_, { ...o, headers: { Accept: 'application/json' } });
    expect(srv.hits.length).toBe(2);
    await e.http.fetch('http://feed.example/err', o);
    await e.http.fetch('http://feed.example/err', o);
    expect(srv.hits.length).toBe(4);
    await expect(e.http.fetch(URL_, { ...o, maxBytes: 100 })).rejects.toMatchObject({ code: 'upstream' });
  });

  it('purgeExpiredCache deletes rows more than 24 h past expiry', async () => {
    srv = await startServer((_q, res) => res.end('{}'));
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], dns: DNS, port: srv.port });
    await e.http.fetch(URL_, { rule: 'publicUrl', ttlSec: 60 });
    expect(purgeExpiredCache(e.db, new Date(e.clock.t + 60_000 + 23 * 3600_000))).toBe(0);
    expect(purgeExpiredCache(e.db, new Date(e.clock.t + 60_000 + 25 * 3600_000))).toBe(1);
  });
});
