import { describe, expect, it } from 'vitest';
import { createSnapshotPusher, newId } from '../src/index.js';
import { createMockHost } from '../src/testing.js';
import { goodManifest } from './sample-module/good/manifest.js';

describe('newId', () => {
  it('has the uuid v7 layout and embeds the given time', () => {
    const id = newId(new Date('2026-01-01T12:00:00.000Z'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(ms).toBe(Date.parse('2026-01-01T12:00:00.000Z'));
  });
  it('ids from increasing times sort increasingly', () => {
    const ids = [0, 1, 1000, 86_400_000, 10 ** 12].map((ms) => newId(new Date(1_700_000_000_000 + ms)));
    expect([...ids].sort()).toEqual(ids);
  });
  it('defaults to the current time and differs between calls', () => {
    expect(newId()).not.toBe(newId());
  });
});

describe('createSnapshotPusher', () => {
  it('pushes identical data once and changed data again', () => {
    const host = createMockHost(goodManifest);
    const p = createSnapshotPusher(host);
    expect(p.push('i1', { a: 1 })).toBe(true);
    expect(p.push('i1', { a: 1 })).toBe(false);
    expect(p.push('i1', { a: 2 })).toBe(true);
    expect(p.push('i2', { a: 2 })).toBe(true);
    expect(host.pushed).toEqual([
      { instanceId: 'i1', data: { a: 1 } },
      { instanceId: 'i1', data: { a: 2 } },
      { instanceId: 'i2', data: { a: 2 } },
    ]);
  });
  it('forget and forgetAll make the next push go out; module-wide (null) is tracked separately', () => {
    const host = createMockHost(goodManifest);
    const p = createSnapshotPusher(host);
    p.push('i1', 1);
    p.push(null, 1);
    expect(p.push(null, 1)).toBe(false);
    p.forget('i1');
    expect(p.push('i1', 1)).toBe(true);
    p.forgetAll();
    expect(p.push(null, 1)).toBe(true);
  });
  it('state is per pusher', () => {
    const host = createMockHost(goodManifest);
    expect(createSnapshotPusher(host).push('i', 1)).toBe(true);
    expect(createSnapshotPusher(host).push('i', 1)).toBe(true);
  });
});
