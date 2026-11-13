import { afterEach, describe, expect, it } from 'vitest';
import { classifyAddress } from '../../src/core/http/guard.ts';
import { makeHttp, selfSigned, startServer, type TestServer } from './http-env.ts';

let srv: TestServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const PUBLIC = { dns: { 'feed.example': ['93.184.216.34'] } };
const forbidden = { code: 'forbidden' };

describe('host.http guard', () => {
  it('rejects host not in manifest', async () => {
    const e = makeHttp({ outbound: [{ kind: 'host', host: 'api.example' }], dns: { 'evil.example': ['93.184.216.34'] } });
    await expect(e.http.fetch('https://evil.example/x')).rejects.toMatchObject(forbidden);
    expect(e.lookup.calls).toEqual([]);
  });

  it('rejects http:// for host rule', async () => {
    const e = makeHttp({ outbound: [{ kind: 'host', host: 'api.example' }], dns: { 'api.example': ['93.184.216.34'] } });
    await expect(e.http.fetch('http://api.example/x')).rejects.toMatchObject(forbidden);
    await expect(e.http.fetch('https://api.example:8443/x')).rejects.toMatchObject(forbidden);
    await expect(e.http.fetch('https://user:pw@api.example/x')).rejects.toMatchObject(forbidden);
  });

  it('publicUrl to 127.0.0.1, 10.0.0.5, 192.168.1.1, 169.254.169.254, [::1], fd00::1 → forbidden', async () => {
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }] });
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '[::1]', '[fd00::1]']) {
      await expect(e.http.fetch(`http://${host}/x`, { rule: 'publicUrl' }), host).rejects.toMatchObject(forbidden);
    }
  });

  it('publicUrl rejects mapped IPv6, odd IPv4 notations, CGNAT and credentials', async () => {
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }] });
    const urls = [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:10.0.0.1]/',
      'http://2130706433/',
      'http://0177.0.0.1/',
      'http://0x7f.0.0.1/',
      'http://127.1/',
      'http://100.64.0.1/',
      'http://user:pass@93.184.216.34/',
    ];
    for (const u of urls) await expect(e.http.fetch(u, { rule: 'publicUrl' }), u).rejects.toMatchObject(forbidden);
  });

  it('classifyAddress covers the reserved ranges', () => {
    const cases: Array<[string, string]> = [
      ['0.1.2.3', 'reserved'], ['10.1.1.1', 'private'], ['100.64.0.1', 'private'], ['127.0.0.1', 'loopback'],
      ['169.254.1.1', 'linklocal'], ['172.16.0.1', 'private'], ['172.32.0.1', 'public'], ['192.0.0.1', 'reserved'],
      ['192.0.2.1', 'reserved'], ['192.168.0.1', 'private'], ['198.18.0.1', 'reserved'], ['198.51.100.1', 'reserved'],
      ['203.0.113.1', 'reserved'], ['224.0.0.1', 'reserved'], ['240.0.0.1', 'reserved'], ['255.255.255.255', 'reserved'],
      ['8.8.8.8', 'public'], ['::', 'reserved'], ['::1', 'loopback'], ['fe80::1', 'linklocal'], ['fc00::1', 'private'],
      ['fd12::1', 'private'], ['ff02::1', 'reserved'], ['2001:db8::1', 'reserved'], ['64:ff9b::7f00:1', 'loopback'],
      ['64:ff9b::8.8.8.8', 'public'], ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'],
      ['::ffff:8.8.8.8', 'public'], ['::127.0.0.1', 'loopback'], ['2606:4700::1111', 'public'], ['garbage', 'reserved'],
    ];
    for (const [ip, cls] of cases) expect(classifyAddress(ip), ip).toBe(cls);
  });

  it('publicUrl whose DNS returns public then private (rebinding) → forbidden', async () => {
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], dns: { 'rebind.example': ['93.184.216.34', '10.0.0.5'] } });
    await expect(e.http.fetch('http://rebind.example/', { rule: 'publicUrl' })).rejects.toMatchObject(forbidden);
    expect(e.lookup.calls).toEqual(['rebind.example']);
  });

  it('connects once to the checked address with a single DNS lookup', async () => {
    srv = await startServer((_q, res) => res.end('{"ok":true}'));
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], ...PUBLIC, port: srv.port });
    const r = await e.http.fetch<{ ok: boolean }>('http://feed.example/x', { rule: 'publicUrl' });
    expect(r.data).toEqual({ ok: true });
    expect(e.lookup.calls).toEqual(['feed.example']);
    expect(srv.hits[0]?.headers.host).toBe('feed.example');
    expect(srv.hits[0]?.headers['user-agent']).toBe('home-dashboard');
  });

  it('redirect to private address → forbidden', async () => {
    srv = await startServer((_q, res) => {
      res.writeHead(302, { location: 'http://internal.example/secret' }).end();
    });
    const e = makeHttp({
      outbound: [{ kind: 'publicUrl' }],
      dns: { ...PUBLIC.dns, 'internal.example': ['192.168.1.10'] },
      port: srv.port,
    });
    await expect(e.http.fetch('http://feed.example/', { rule: 'publicUrl' })).rejects.toMatchObject(forbidden);
  });

  it('more than 3 redirects → upstream', async () => {
    srv = await startServer((_q, res, n) => {
      res.writeHead(302, { location: `/r${n}` }).end();
    });
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], ...PUBLIC, port: srv.port });
    await expect(e.http.fetch('http://feed.example/', { rule: 'publicUrl' })).rejects.toMatchObject({ code: 'upstream' });
    expect(srv.hits.length).toBe(4);
  });

  it('redirect from https to http is forbidden', async () => {
    const tls = selfSigned();
    if (!tls) return;
    srv = await startServer((_q, res) => {
      res.writeHead(302, { location: 'http://feed.example/' }).end();
    }, tls);
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], ...PUBLIC, port: srv.port });
      await expect(e.http.fetch('https://feed.example/', { rule: 'publicUrl' })).rejects.toMatchObject(forbidden);
      expect(srv.hits.length).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  });

  it('Authorization is dropped on cross-host redirect', async () => {
    srv = await startServer((q, res) => {
      if (q.headers.host === 'a.example') res.writeHead(302, { location: 'http://b.example/y' }).end();
      else res.end('{}');
    });
    const e = makeHttp({
      outbound: [{ kind: 'publicUrl' }],
      dns: { 'a.example': ['93.184.216.34'], 'b.example': ['93.184.216.35'] },
      port: srv.port,
    });
    await e.http.fetch('http://a.example/x', { rule: 'publicUrl', headers: { Authorization: 'Bearer s', 'X-Key': 'k' } });
    expect(srv.hits[0]?.headers.authorization).toBe('Bearer s');
    expect(srv.hits[1]?.headers.authorization).toBeUndefined();
    expect(srv.hits[1]?.headers['x-key']).toBeUndefined();
  });

  it('Set-Cookie is never returned and never replayed', async () => {
    srv = await startServer((_q, res) => {
      res.setHeader('Set-Cookie', 'sid=1');
      res.end('{}');
    });
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], ...PUBLIC, port: srv.port });
    const r = await e.http.fetch('http://feed.example/', { rule: 'publicUrl', headers: { Cookie: 'mine=1' } });
    expect(r.headers['set-cookie']).toBeUndefined();
    await e.http.fetch('http://feed.example/', { rule: 'publicUrl' });
    expect(srv.hits[0]?.headers.cookie).toBeUndefined();
    expect(srv.hits[1]?.headers.cookie).toBeUndefined();
  });

  it('lanDevice to public address → forbidden', async () => {
    const e = makeHttp({ outbound: [{ kind: 'lanDevice' }], dns: { 'nas.lan': ['93.184.216.34'] }, lan: ['nas.lan'] });
    await expect(e.http.fetch('http://nas.lan/', { rule: 'lanDevice' })).rejects.toMatchObject(forbidden);
  });

  it('lanDevice not in device list → forbidden', async () => {
    const e = makeHttp({ outbound: [{ kind: 'lanDevice' }], dns: { 'nas.lan': ['192.168.1.5'] }, lan: ['other.lan', 'nas.lan:8080'] });
    await expect(e.http.fetch('http://nas.lan/', { rule: 'lanDevice' })).rejects.toMatchObject(forbidden);
    expect(e.lookup.calls).toEqual([]);
  });

  it('lanDevice allows a listed private device and rejects loopback', async () => {
    srv = await startServer((_q, res) => res.end('{"a":1}'));
    const e = makeHttp({
      outbound: [{ kind: 'lanDevice' }],
      dns: { 'nas.lan': ['192.168.1.5'], 'lo.lan': ['127.0.0.1'] },
      lan: ['NAS.lan', 'lo.lan'],
      port: srv.port,
    });
    expect((await e.http.fetch('http://nas.lan:8123/', { rule: 'lanDevice' })).data).toEqual({ a: 1 });
    await expect(e.http.fetch('http://lo.lan/', { rule: 'lanDevice' })).rejects.toMatchObject(forbidden);
  });

  it('publicUrl on port 22 → forbidden', async () => {
    const e = makeHttp({ outbound: [{ kind: 'publicUrl' }], ...PUBLIC });
    await expect(e.http.fetch('http://feed.example:22/', { rule: 'publicUrl' })).rejects.toMatchObject(forbidden);
  });
});
