import { z } from 'zod';
import { defineManifest, defineServer } from '../../../src/index.js';

// Deliberately broken: touches a table outside its prefix, mutates through a `view` route,
// and its job crashes with a TypeError on anything that is not the happy payload.
export const badManifest = defineManifest({
  id: 'bad',
  name: 'Bad',
  description: 'Deliberately broken module used to prove the contract suites catch mistakes.',
  version: '1.0.0',
  icon: 'note',
  scope: 'shared',
  multiInstance: false,
  tile: { default: { w: 3, h: 2 }, min: { w: 2, h: 1 }, max: { w: 6, h: 4 } },
  settings: z.object({}),
  config: z.object({}),
  levels: ['view', 'edit'],
  jobs: [{ name: 'refresh', intervalSec: 60, mode: 'always', per: 'module' }],
  publishes: [],
  subscribes: [],
  outbound: [{ kind: 'host', host: 'api.example.test' }],
});

export const badServer = defineServer({
  manifest: badManifest,
  migrations: [{ id: 1, up: 'CREATE TABLE users2 (id INTEGER PRIMARY KEY)' }],
  jobs: {
    async refresh({ host }) {
      const res = await host.http.fetch<{ value: number }>('https://api.example.test/data', { as: 'text' });
      host.push(null, { value: res.data.value.toFixed(0) });
    },
  },
  routes(r) {
    r.post('/items', { level: 'view' }, () => Promise.resolve({ ok: true }));
  },
});
