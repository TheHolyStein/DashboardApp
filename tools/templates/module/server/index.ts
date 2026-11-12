import { defineServer } from '@dash/module-kit';
import manifest from '../manifest.js';

export default defineServer({
  manifest,
  // migrations: [{ id: 1, up: 'CREATE TABLE m_<id with - as _>_items (...)' }],
  // jobs: { refresh: async ({ host }) => { ... } },   // keys must match manifest.jobs
  routes(r) {
    r.get('/status', { level: 'view' }, () => Promise.resolve({ ok: true }));
  },
});
