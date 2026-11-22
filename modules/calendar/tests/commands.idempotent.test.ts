import { describe, expect, it } from 'vitest';
import { createMockHostWithSetup, createMockRouter } from '@dash/module-kit/testing';
import server from '../server/index.js';
import { reconcile } from '../server/derive.js';
import { NOW, USERS, create, personal, setup } from './api-helpers.js';

const keys = (published: Array<{ name: string; payload: unknown }>) =>
  published.filter((p) => p.name === 'todo.create.request').map((p) => (p.payload as { sourceKey: string }).sourceKey).sort();

describe('derive is idempotent', () => {
  it('reconcile twice publishes nothing the second time', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Trip @eli #shopping maps, snacks' });
    expect(keys(host.published)).toHaveLength(3);
    host.published.length = 0;
    await reconcile(host, host.now());
    await reconcile(host, host.now());
    expect(host.published).toEqual([]);
  });

  it('simulated crash after bookkeeping commit and before publish: next reconcile publishes nothing new but a forced replay publishes identical sourceKeys', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    const publish = host.bus.publish.bind(host.bus);
    host.bus.publish = (name, payload) => {
      if (name === 'todo.create.request') throw new Error('power cut');
      publish(name, payload);
    };
    await create(router, 'u1', { calendarId: cal, title: 'Trip @eli #shopping maps' }); // the hook logs the failure
    host.bus.publish = publish;
    expect(host.store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM m_calendar_derived')?.n).toBe(2);
    await reconcile(host, host.now());
    expect(keys(host.published)).toEqual([]);
    await reconcile(host, host.now(), { replay: true });
    const replayed = keys(host.published);
    expect(replayed).toHaveLength(2);
    host.published.length = 0;
    await reconcile(host, host.now(), { replay: true });
    expect(keys(host.published)).toEqual(replayed);
  });

  it('restart with the same data creates no duplicates', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Trip @eli' });
    // A "restarted" server: a fresh module instance on the same database contents.
    const dump = host.store.db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'm_calendar_%'");
    expect(dump.length).toBeGreaterThan(0);
    const restarted = await createMockHostWithSetup(server, { now: NOW, prepare: (h) => h.setUsers(USERS) });
    for (const table of ['m_calendar_calendars', 'm_calendar_events', 'm_calendar_derived', 'm_calendar_reminders']) {
      for (const row of host.store.db.all<Record<string, unknown>>(`SELECT * FROM ${table}`)) {
        const cols = Object.keys(row);
        restarted.store.db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(row));
      }
    }
    createMockRouter(server, restarted);
    await server.jobs!['derive']!({ host: restarted, instance: null, signal: new AbortController().signal });
    expect(keys(restarted.published)).toEqual([]);
  });
});
