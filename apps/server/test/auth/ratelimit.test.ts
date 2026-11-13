import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAuthEnv, PASSWORD, type AuthEnv } from './env.ts';

let env: AuthEnv | undefined;
afterEach(async () => {
  await env?.app.close();
  env = undefined;
});

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Cheap verifier: counts calls, accepts only PASSWORD. Avoids an argon2 hash per attempt. */
function makeVerify() {
  return vi.fn((_hash: string, password: string) => Promise.resolve(password === PASSWORD));
}

async function setup(users: string[] = ['Alice']) {
  const verify = makeVerify();
  env = await makeAuthEnv({ auth: { verifyPassword: verify } });
  for (const u of users) await env.addUser(u);
  return { env, verify };
}

function attempt(
  e: AuthEnv,
  name: string,
  password: string,
  extra: { remoteAddress?: string; xff?: string } = {},
) {
  return e.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json', ...(extra.xff ? { 'x-forwarded-for': extra.xff } : {}) },
    payload: { name, password },
    ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
  });
}

const BAD = 'wrong password!!';

/** 5 failures from one address for `name`. */
async function failFive(e: AuthEnv, name: string, extra: { remoteAddress?: string; xff?: string } = {}) {
  for (let i = 0; i < 5; i++) expect((await attempt(e, name, BAD, extra)).statusCode).toBe(401);
}

const rows = (e: AuthEnv) =>
  e.db.prepare('SELECT key, count, locked_until, lock_level FROM login_attempts ORDER BY key').all() as Array<{
    key: string;
    count: number;
    locked_until: string | null;
    lock_level: number;
  }>;

describe('login rate limiting', () => {
  it('6th attempt within window → 429 with Retry-After', async () => {
    const { env: e } = await setup();
    await failFive(e, 'Alice');
    const res = await attempt(e, 'Alice', BAD);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe(String(15 * 60));
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).not.toMatch(/ip|user|name/i);
  });

  it('lock expires', async () => {
    const { env: e } = await setup();
    await failFive(e, 'Alice');
    e.clock.now = new Date(e.clock.now.getTime() + 15 * MIN - 1000);
    const still = await attempt(e, 'Alice', PASSWORD);
    expect(still.statusCode).toBe(429);
    expect(still.headers['retry-after']).toBe('1');
    e.clock.now = new Date(e.clock.now.getTime() + 1000);
    expect((await attempt(e, 'Alice', PASSWORD)).statusCode).toBe(200);
  });

  it('success resets counter', async () => {
    const { env: e } = await setup();
    for (let i = 0; i < 4; i++) await attempt(e, 'Alice', BAD, { remoteAddress: `10.0.0.${i + 1}` });
    expect((await attempt(e, 'Alice', PASSWORD, { remoteAddress: '10.0.1.1' })).statusCode).toBe(200);
    expect(rows(e).find((r) => r.key === 'user:alice')).toBeUndefined();
    // four fresh failures do not lock (they would have been the 5th-8th otherwise)
    for (let i = 0; i < 4; i++) await attempt(e, 'Alice', BAD, { remoteAddress: `10.0.2.${i + 1}` });
    expect((await attempt(e, 'Alice', PASSWORD, { remoteAddress: '10.0.3.1' })).statusCode).toBe(200);
  });

  it('X-Forwarded-For ignored from non-loopback peer', async () => {
    const { env: e } = await setup();
    const peer = '192.168.1.50';
    for (let i = 0; i < 5; i++) await attempt(e, `Nobody${i}`, BAD, { remoteAddress: peer, xff: `9.9.9.${i}` });
    // different spoofed XFF, same peer: still locked by the peer's ip key
    const res = await attempt(e, 'Other', BAD, { remoteAddress: peer, xff: '8.8.8.8' });
    expect(res.statusCode).toBe(429);
    expect(rows(e).some((r) => r.key.startsWith('ip:9.9.9.'))).toBe(false);
  });

  it('a locked key does no password verification and does not count further failures', async () => {
    const { env: e, verify } = await setup();
    await failFive(e, 'Alice');
    expect(verify).toHaveBeenCalledTimes(5);
    const before = rows(e);
    for (let i = 0; i < 3; i++) expect((await attempt(e, 'Alice', BAD)).statusCode).toBe(429);
    expect(verify).toHaveBeenCalledTimes(5);
    expect(rows(e)).toEqual(before);
  });

  it('correct password during a user lock → 429', async () => {
    const { env: e } = await setup();
    await failFive(e, 'Alice', { remoteAddress: '10.0.0.1' });
    // a different address, so only the user key is locked
    const res = await attempt(e, 'Alice', PASSWORD, { remoteAddress: '10.0.0.2' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('user key is case-insensitive and applies to non-existent names', async () => {
    const { env: e } = await setup();
    for (let i = 0; i < 5; i++) {
      await attempt(e, i % 2 ? 'GHOST' : 'ghost', BAD, { remoteAddress: `10.1.0.${i + 1}` });
    }
    expect((await attempt(e, 'Ghost', BAD, { remoteAddress: '10.1.9.9' })).statusCode).toBe(429);
    expect(rows(e).some((r) => r.key === 'user:ghost' && r.locked_until !== null)).toBe(true);
  });

  it('second lock lasts twice as long, capped at 24 h', async () => {
    const { env: e } = await setup();
    const expected = [15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR, 24 * HOUR];
    for (const lockMs of expected) {
      await failFive(e, 'Alice', { remoteAddress: '10.2.0.1' });
      const res = await attempt(e, 'Alice', BAD, { remoteAddress: '10.2.0.1' });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe(String(lockMs / 1000));
      e.clock.now = new Date(e.clock.now.getTime() + lockMs);
    }
  });

  it('lock level decays after 24 h without a failure', async () => {
    const { env: e } = await setup();
    await failFive(e, 'Alice', { remoteAddress: '10.3.0.1' });
    e.clock.now = new Date(e.clock.now.getTime() + 25 * HOUR);
    await failFive(e, 'Alice', { remoteAddress: '10.3.0.1' });
    const res = await attempt(e, 'Alice', BAD, { remoteAddress: '10.3.0.1' });
    expect(res.headers['retry-after']).toBe(String(15 * 60));
  });

  it('failures older than the 15 minute window do not add up', async () => {
    const { env: e } = await setup();
    for (let i = 0; i < 4; i++) await attempt(e, 'Alice', BAD);
    e.clock.now = new Date(e.clock.now.getTime() + 16 * MIN);
    for (let i = 0; i < 4; i++) expect((await attempt(e, 'Alice', BAD)).statusCode).toBe(401);
  });

  it('X-Forwarded-For with several entries from a loopback peer uses the last one', async () => {
    const { env: e } = await setup();
    await failFive(e, 'Alice', { xff: '1.1.1.1, 2.2.2.2, 203.0.113.7' });
    const keys = rows(e).map((r) => r.key);
    expect(keys).toContain('ip:203.0.113.7');
    expect(keys).not.toContain('ip:1.1.1.1');
    // the same client is refused even under another name, a different client is not
    expect((await attempt(e, 'Bob', BAD, { xff: '5.5.5.5, 203.0.113.7' })).statusCode).toBe(429);
    expect((await attempt(e, 'Bob', BAD, { xff: '203.0.113.7, 5.5.5.5' })).statusCode).toBe(401);
  });

  it('malformed X-Forwarded-For falls back to the peer', async () => {
    const { env: e } = await setup();
    await attempt(e, 'Alice', BAD, { xff: '1.2.3.4, not-an-ip' });
    expect(rows(e).map((r) => r.key)).toContain('ip:127.0.0.1');
  });

  it('the ip key is not cleared by a success', async () => {
    const { env: e } = await setup(['Alice', 'Bob']);
    for (let i = 0; i < 4; i++) await attempt(e, `Ghost${i}`, BAD, { remoteAddress: '10.4.0.1' });
    expect((await attempt(e, 'Alice', PASSWORD, { remoteAddress: '10.4.0.1' })).statusCode).toBe(200);
    expect(rows(e).find((r) => r.key === 'ip:10.4.0.1')?.count).toBe(4);
    expect(rows(e).find((r) => r.key === 'user:alice')).toBeUndefined();
    // one more failure from that address is its 5th: the ip is now locked, even for Bob's right password
    await attempt(e, 'Ghost9', BAD, { remoteAddress: '10.4.0.1' });
    expect((await attempt(e, 'Bob', PASSWORD, { remoteAddress: '10.4.0.1' })).statusCode).toBe(429);
  });

  it('audits a lock as auth.lockout with the key kind and duration', async () => {
    const { env: e } = await setup();
    await failFive(e, 'Alice', { remoteAddress: '10.5.0.1' });
    const audited = e.db
      .prepare("SELECT detail, ip FROM audit_log WHERE action = 'auth.lockout' ORDER BY id")
      .all() as Array<{ detail: string; ip: string | null }>;
    expect(audited.map((a) => JSON.parse(a.detail) as unknown)).toEqual([
      { key: 'ip', lockSec: 900 },
      { key: 'user', lockSec: 900 },
    ]);
    expect(audited[0]?.ip).toBe('10.5.0.1');
    expect(JSON.stringify(audited)).not.toContain('alice');
  });

  it('purge removes decayed unlocked rows and keeps locked or recent ones', async () => {
    const { env: e } = await setup();
    await failFive(e, 'Alice', { remoteAddress: '10.6.0.1' });
    await attempt(e, 'Bob', BAD, { remoteAddress: '10.6.0.2' });
    e.auth.loginLimiter.purge(new Date(e.clock.now.getTime() + 20 * MIN));
    expect(rows(e).map((r) => r.key)).toEqual(['ip:10.6.0.1', 'ip:10.6.0.2', 'user:alice', 'user:bob']);
    e.auth.loginLimiter.purge(new Date(e.clock.now.getTime() + 25 * HOUR));
    expect(rows(e)).toEqual([]);
  });

  describe('concurrent attempts', () => {
    /** Slow verifier so that all requests are in flight before any verification finishes. */
    async function slowSetup() {
      const verify = vi.fn(
        (_hash: string, password: string) =>
          new Promise<boolean>((resolve) => setTimeout(() => resolve(password === PASSWORD), 30)),
      );
      env = await makeAuthEnv({ auth: { verifyPassword: verify } });
      await env.addUser('Alice');
      verify.mockClear();
      return { e: env, verify };
    }

    it('10 concurrent logins: at most 5 are verified and a correct password last is refused', async () => {
      const { e, verify } = await slowSetup();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => attempt(e, 'Alice', i === 9 ? PASSWORD : BAD)),
      );
      expect(verify.mock.calls.length).toBeLessThanOrEqual(5);
      expect(results.filter((r) => r.statusCode === 401)).toHaveLength(5);
      expect(results.filter((r) => r.statusCode === 429)).toHaveLength(5);
      expect(results[9]?.statusCode).toBe(429);
      expect(results[9]?.headers['set-cookie']).toBeUndefined();
      expect(e.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
      // the lock set by the burst survives
      expect(rows(e).find((r) => r.key === 'user:alice')?.locked_until).not.toBeNull();
    });

    it('a correct password in the burst does not log in once another request locked the keys', async () => {
      const { e } = await slowSetup();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => attempt(e, 'Alice', i === 2 ? PASSWORD : BAD)),
      );
      expect(results[2]?.statusCode).toBe(429);
      expect(results[2]?.headers['set-cookie']).toBeUndefined();
      expect(e.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
      expect(rows(e).find((r) => r.key === 'user:alice')?.locked_until).not.toBeNull();
    });

    it('a sequence of successful logins from one IP never locks the IP', async () => {
      const { env: e } = await setup();
      for (let i = 0; i < 12; i++) expect((await attempt(e, 'Alice', PASSWORD)).statusCode).toBe(200);
      const ipRow = rows(e).find((r) => r.key === 'ip:127.0.0.1');
      expect(ipRow?.locked_until ?? null).toBeNull();
      expect(ipRow?.count ?? 0).toBe(0);
    });

    it('the 5th attempt (reserved, locking) can still log in when it is the only one', async () => {
      const { env: e } = await setup();
      for (let i = 0; i < 4; i++) await attempt(e, 'Alice', BAD);
      expect((await attempt(e, 'Alice', PASSWORD)).statusCode).toBe(200);
      expect(rows(e).every((r) => r.locked_until === null)).toBe(true);
    });
  });
});
