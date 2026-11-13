import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource, makeStream, ping, snap } from './streamHelpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('stream store', () => {
  it('snapshot event updates store', () => {
    const { s } = makeStream();
    s.connect();
    expect(s.status).toBe('connecting');
    FakeEventSource.last.emit(snap('a', { n: 1 }));
    expect(s.status).toBe('live');
    expect(s.snapshots['a']?.data).toEqual({ n: 1 });
    FakeEventSource.last.emit(snap('a', { n: 2 }));
    expect(s.snapshots['a']?.data).toEqual({ n: 2 });
  });

  it('revoked removes module snapshots', () => {
    const { s } = makeStream();
    const seen: string[] = [];
    s.on('revoked', (e) => seen.push(e.moduleId));
    s.setInstanceModules({ a: 'weather', b: 'weather', c: 'notes' });
    s.connect();
    for (const id of ['a', 'b', 'c', 'core:sun']) FakeEventSource.last.emit(snap(id));
    FakeEventSource.last.emit({ type: 'revoked', moduleId: 'weather' });
    expect(Object.keys(s.snapshots).sort()).toEqual(['c', 'core:sun']);
    expect(seen).toEqual(['weather']);
  });

  it('invalid message is dropped without throwing', () => {
    const { s } = makeStream();
    s.connect();
    const es = FakeEventSource.last;
    expect(() => {
      es.emit('not json');
      es.emit({ type: 'nope' });
      es.emit({ type: 'snapshot', snapshot: { instanceId: 1 } });
    }).not.toThrow();
    expect(s.status).toBe('connecting');
    expect(s.snapshots).toEqual({});
    es.emit(snap('a'));
    expect(s.status).toBe('live');
  });

  it('a throwing listener does not stop the others', () => {
    const { s } = makeStream();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: string[] = [];
    s.on('ping', () => {
      throw new Error('boom');
    });
    s.on('ping', () => got.push('ok'));
    s.connect();
    FakeEventSource.last.emit(ping());
    expect(got).toEqual(['ok']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('on() unsubscribe works', () => {
    const { s } = makeStream();
    const fn = vi.fn();
    const off = s.on('ping', fn);
    s.connect();
    FakeEventSource.last.emit(ping());
    off();
    FakeEventSource.last.emit(ping());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('setVisible debounces and caps at 200 ids', () => {
    const { s, env } = makeStream();
    s.connect();
    FakeEventSource.last.emit(ping());
    s.setVisible(['a']);
    s.setVisible(['a', 'b']);
    expect(env.posts).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(env.posts).toEqual([{ path: '/stream/view', body: { instanceIds: ['a', 'b'] } }]);
    const many = Array.from({ length: 300 }, (_, i) => `i${i % 250}`);
    s.setVisible(many);
    vi.advanceTimersByTime(250);
    const body = env.posts[1]?.body as { instanceIds: string[] };
    expect(body.instanceIds).toHaveLength(200);
    expect(new Set(body.instanceIds).size).toBe(200);
  });

  it('no view post while offline or after disconnect; failed post is ignored', async () => {
    const { s, env } = makeStream();
    s.setVisible(['a']);
    vi.advanceTimersByTime(250);
    expect(env.posts).toHaveLength(0); // not connected
    s.connect();
    FakeEventSource.last.emit(ping());
    env.failPost = true;
    s.setVisible(['a', 'b']);
    vi.advanceTimersByTime(250);
    await Promise.resolve();
    expect(env.posts).toHaveLength(2); // initial post on live + changed set; rejection swallowed
    FakeEventSource.last.fail();
    s.setVisible(['c']);
    vi.advanceTimersByTime(250);
    expect(env.posts).toHaveLength(2);
  });
});
