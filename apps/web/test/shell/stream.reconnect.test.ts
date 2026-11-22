import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource, makeStream, ping, snap } from './streamHelpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const count = () => FakeEventSource.instances.length;

describe('stream reconnect', () => {
  it('after 60 s without ping reconnects', () => {
    const { s } = makeStream();
    s.connect();
    FakeEventSource.last.emit(ping());
    vi.advanceTimersByTime(59_000);
    expect(count()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(count()).toBe(2);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(s.status).toBe('connecting');
  });

  it('visibilitychange to visible reconnects at once when offline', () => {
    const { s, doc, env } = makeStream();
    s.connect();
    FakeEventSource.last.fail();
    expect(s.status).toBe('offline');
    env.visible = true;
    doc.fire('visibilitychange');
    expect(count()).toBe(2);
    expect(s.status).toBe('connecting');
    // live: visibility does not reconnect
    FakeEventSource.last.emit(ping());
    doc.fire('visibilitychange');
    expect(count()).toBe(2);
  });

  it('online event cancels a pending backoff and reconnects at once', () => {
    const { s, win } = makeStream();
    s.connect();
    FakeEventSource.last.fail();
    win.fire('online');
    expect(count()).toBe(2);
    vi.advanceTimersByTime(60_000 - 1);
    expect(count()).toBe(2); // old backoff timer was cancelled
  });

  it('backoff grows and is capped at 30 s', () => {
    const { s } = makeStream();
    s.connect();
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    delays.forEach((d, i) => {
      FakeEventSource.last.fail();
      vi.advanceTimersByTime(d - 1);
      expect(count()).toBe(i + 1);
      vi.advanceTimersByTime(1);
      expect(count()).toBe(i + 2);
    });
  });

  it('backoff applies jitter in [0.5, 1.0]', () => {
    const { s, env } = makeStream();
    env.rand = 0;
    s.connect();
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(500);
    expect(count()).toBe(2);
  });

  it('backoff resets after a healthy connection', () => {
    const { s } = makeStream();
    s.connect();
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(1000);
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(2000);
    expect(count()).toBe(3);
    FakeEventSource.last.emit(ping());
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(1000);
    expect(count()).toBe(4);
  });

  it('after reconnect stale local data is replaced, no page reload', () => {
    const { s } = makeStream();
    s.connect();
    FakeEventSource.last.emit(snap('a', 1));
    FakeEventSource.last.emit(snap('b', 1));
    FakeEventSource.last.emit(snap('core:sun', 1));
    FakeEventSource.last.emit(ping());
    FakeEventSource.last.fail();
    expect(s.status).toBe('offline');
    expect(Object.keys(s.snapshots)).toHaveLength(3); // kept while offline
    vi.advanceTimersByTime(1000);
    FakeEventSource.last.emit(snap('a', 2));
    expect(s.status).toBe('live');
    expect(s.snapshots['a']?.data).toBe(2);
    expect(s.snapshots['b']?.data).toBe(1); // not yet replaced, still visible
    FakeEventSource.last.emit(ping());
    expect(Object.keys(s.snapshots).sort()).toEqual(['a', 'core:sun']);
  });

  it('view heartbeat stops while document hidden', () => {
    const { s, doc, env } = makeStream();
    s.connect();
    FakeEventSource.last.emit(ping());
    s.setVisible(['a']);
    vi.advanceTimersByTime(250);
    expect(env.posts).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(env.posts).toHaveLength(2);
    env.visible = false;
    doc.fire('visibilitychange');
    vi.advanceTimersByTime(120_000);
    expect(env.posts).toHaveLength(2);
    env.visible = true;
    doc.fire('visibilitychange');
    expect(env.posts).toHaveLength(3); // immediate post on becoming visible
    vi.advanceTimersByTime(30_000);
    expect(env.posts).toHaveLength(4);
  });

  it('does not spin while navigator is offline; waits for online', () => {
    const { s, win, env } = makeStream();
    s.connect();
    FakeEventSource.last.emit(ping());
    env.online = false;
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(120_000);
    expect(count()).toBe(1);
    env.online = true;
    win.fire('online');
    expect(count()).toBe(2);
  });

  it('disconnect stops all timers and nothing reconnects', () => {
    const { s, win, doc, env } = makeStream();
    s.connect();
    FakeEventSource.last.emit(snap('a'));
    s.setVisible(['a']);
    FakeEventSource.last.fail();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    s.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    expect(win.count + doc.count).toBe(0);
    expect(s.snapshots).toEqual({});
    expect(s.status).toBe('offline');
    vi.advanceTimersByTime(300_000);
    win.fire('online');
    doc.fire('visibilitychange');
    expect(count()).toBe(1);
    expect(env.posts).toHaveLength(0);
    s.connect();
    expect(count()).toBe(2);
    s.connect(); // idempotent
    expect(count()).toBe(2);
  });

  it('a reconnect that goes live while hidden posts nothing; one post after becoming visible', () => {
    const { s, doc, env } = makeStream();
    s.connect();
    FakeEventSource.last.emit(ping());
    s.setVisible(['a']);
    vi.advanceTimersByTime(250);
    expect(env.posts).toHaveLength(1);
    env.visible = false;
    doc.fire('visibilitychange');
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(1000);
    expect(count()).toBe(2);
    FakeEventSource.last.emit(ping());
    expect(s.status).toBe('live');
    expect(env.posts).toHaveLength(1); // live while hidden: no view post
    env.visible = true;
    doc.fire('visibilitychange');
    expect(env.posts).toHaveLength(2);
    expect(env.posts[1]).toEqual({ path: '/stream/view', body: { instanceIds: ['a'] } });
  });

  it('after disconnect and connect, old visible ids and module map are not reused', () => {
    const { s, env } = makeStream();
    s.setInstanceModules({ a: 'weather' });
    s.connect();
    FakeEventSource.last.emit(ping());
    s.setVisible(['a']);
    vi.advanceTimersByTime(250);
    expect(env.posts).toHaveLength(1);
    s.disconnect();
    s.connect();
    FakeEventSource.last.emit(ping());
    expect(env.posts).toHaveLength(1); // old ids were reset, nothing posted on first event
    FakeEventSource.last.emit(snap('a', 1));
    expect(() => FakeEventSource.last.emit({ type: 'revoked', moduleId: 'weather' })).not.toThrow();
    expect(s.snapshots['a']?.data).toBe(1); // old instance->module map was reset
  });
});
