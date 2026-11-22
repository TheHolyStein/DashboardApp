import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHttp, startServer, type TestServer } from './http-env.ts';

let srv: TestServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const DNS = { 'feed.example': ['93.184.216.34'] };
const env = (port: number) => makeHttp({ outbound: [{ kind: 'publicUrl' }], dns: DNS, port });
const URL_ = 'http://feed.example/x';

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
}

describe('host.http limits', () => {
  it('slow server past timeout → upstream', async () => {
    srv = await startServer((_q, res) => {
      res.writeHead(200);
      res.write('{');
      // never finishes
    });
    await expect(env(srv.port).http.fetch(URL_, { rule: 'publicUrl', timeoutMs: 150 })).rejects.toMatchObject({ code: 'upstream' });
    await waitFor(() => srv!.sockets.size === 0);
    expect(srv.sockets.size).toBe(0);
  });

  it("50 MB body is cut at maxBytes → upstream and socket destroyed", async () => {
    srv = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(1_000_000, 97);
      let sent = 0;
      const pump = (): void => {
        while (sent < 50 && res.write(chunk)) sent++;
        if (sent < 50) res.once('drain', pump);
        else res.end();
      };
      pump();
    });
    await expect(
      env(srv.port).http.fetch(URL_, { rule: 'publicUrl', as: 'buffer', maxBytes: 1_000_000 }),
    ).rejects.toMatchObject({ code: 'upstream' });
    await waitFor(() => srv!.sockets.size === 0);
    expect(srv.sockets.size).toBe(0);
  });

  it('gzip bomb is cut at maxBytes (decoded size)', async () => {
    const bomb = gzipSync(Buffer.alloc(50_000_000, 0));
    srv = await startServer((_q, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(bomb);
    });
    expect(bomb.length).toBeLessThan(200_000);
    await expect(
      env(srv.port).http.fetch(URL_, { rule: 'publicUrl', as: 'buffer', maxBytes: 100_000 }),
    ).rejects.toMatchObject({ code: 'upstream' });
    await waitFor(() => srv!.sockets.size === 0);
    expect(srv.sockets.size).toBe(0);
  });

  it('decodes gzip within limits and sends Accept-Encoding', async () => {
    srv = await startServer((_q, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(gzipSync('{"n":1}'));
    });
    const r = await env(srv.port).http.fetch<{ n: number }>(URL_, { rule: 'publicUrl' });
    expect(r.data).toEqual({ n: 1 });
    expect(srv.hits[0]?.headers['accept-encoding']).toBe('gzip, br');
  });

  it("HTML body with as:'json' → upstream", async () => {
    srv = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>secret-body</html>');
    });
    const err = await env(srv.port).http.fetch(URL_, { rule: 'publicUrl' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'upstream' });
    expect((err as Error).message).not.toContain('secret-body');
  });

  it('500 response resolves with status 500', async () => {
    srv = await startServer((_q, res) => {
      res.writeHead(500, { 'x-Thing': 'A' });
      res.end('boom');
    });
    const r = await env(srv.port).http.fetch(URL_, { rule: 'publicUrl', as: 'text' });
    expect(r.status).toBe(500);
    expect(r.data).toBe('boom');
    expect(r.headers['x-thing']).toBe('A');
  });

  it('deadline during a slow DNS lookup leaves no connection open', async () => {
    srv = await startServer((_q, res) => {
      res.writeHead(200);
      const t = setInterval(() => res.write(' '), 20);
      res.on('close', () => clearInterval(t));
    });
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], dns: DNS, port: srv.port, lookupDelays: { 'feed.example': 250 } });
    await expect(e.http.fetch(URL_, { rule: 'publicUrl', timeoutMs: 100 })).rejects.toMatchObject({ code: 'upstream' });
    await new Promise((r) => setTimeout(r, 500));
    expect(srv.hits.length).toBe(0);
    expect(srv.sockets.size).toBe(0);
  });

  it('deadline during a redirect chain writes no cache row', async () => {
    srv = await startServer((q, res) => {
      if (q.url === '/a') res.writeHead(302, { location: 'http://b.example/b' }).end();
      else res.end('{"v":1}');
    });
    const e = makeHttp({
      outbound: [{ kind: 'publicUrl' }],
      dns: { 'feed.example': ['93.184.216.34'], 'b.example': ['93.184.216.35'] },
      port: srv.port,
      lookupDelays: { 'b.example': 250 },
    });
    await expect(e.http.fetch('http://feed.example/a', { rule: 'publicUrl', ttlSec: 60, timeoutMs: 100 })).rejects.toMatchObject({ code: 'upstream' });
    await new Promise((r) => setTimeout(r, 500));
    expect(srv.hits.length).toBe(1);
    expect(e.db.prepare('SELECT count(*) AS n FROM http_cache').get()).toEqual({ n: 0 });
    expect(srv.sockets.size).toBe(0);
  });
});
