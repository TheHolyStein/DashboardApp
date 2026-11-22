import { describe, expect, test } from 'vitest';
import type { ModuleInstance } from '@dash/contract';
import { createMockHost, createMockRouter, migrationTargets } from '../src/testing.js';
import { goodServer } from './sample-module/good/server.js';

describe('migrationTargets', () => {
  test('a column named updated_at or online is not a statement', () => {
    const sql = 'CREATE TABLE m_x_items (id INTEGER, updated_at TEXT, online INTEGER, "on" TEXT)';
    expect(migrationTargets(sql)).toEqual(['m_x_items']);
  });
  test('real statements on other tables are still found', () => {
    expect(migrationTargets('UPDATE other_table SET a = 1')).toEqual(['other_table']);
    expect(migrationTargets('INSERT INTO core_users (a) VALUES (1)')).toEqual(['core_users']);
    expect(migrationTargets('DELETE FROM core_users')).toEqual(['core_users']);
    expect(migrationTargets('ALTER TABLE core_users ADD c')).toEqual(['core_users']);
    expect(migrationTargets('DROP TABLE IF EXISTS core_users')).toEqual(['core_users']);
    expect(migrationTargets('CREATE INDEX i ON core_users (a)')).toContain('core_users');
  });
});

describe('mock router instances', () => {
  const mine: ModuleInstance = { id: 'i1', ownerId: 'u1', pageId: 'p', settings: {} };
  const theirs: ModuleInstance = { id: 'i2', ownerId: 'u2', pageId: 'q', settings: {} };
  const setup = (canView?: () => boolean) => {
    const host = createMockHost(goodServer.manifest);
    host.setInstances([mine, theirs]);
    return createMockRouter(goodServer, host, canView ? { canView } : {});
  };
  test('own instance resolves; foreign, unknown and missing are 404', async () => {
    const router = setup();
    expect((await router.call('GET', '/detail', { level: 'view', instance: 'i1' })).body).toEqual({ id: 'i1' });
    for (const instance of ['i2', 'nope', undefined]) {
      expect((await router.call('GET', '/detail', { level: 'view', ...(instance ? { instance } : {}) })).status).toBe(404);
    }
  });
  test('canView is configurable (shared page)', async () => {
    const router = setup(() => true);
    expect((await router.call('GET', '/detail', { level: 'view', instance: 'i2' })).status).toBe(200);
  });
});
