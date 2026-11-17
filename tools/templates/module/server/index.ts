import { z } from 'zod';
import { createSnapshotPusher, defineServer, newId } from '@dash/module-kit';
import manifest from '../manifest.js';

// Typed route body: with `body: NewItem`, `req.body` is z.infer<typeof NewItem> (the server answers 422 first).
const NewItem = z.object({ label: z.string().trim().min(1).max(80) });

interface Row {
  id: string;
  label: string;
}

export default defineServer({
  manifest,
  // One migration may hold several statements (the table and its index). Ids ascend from 1; never edit a shipped one.
  migrations: [
    {
      id: 1,
      up: `CREATE TABLE __TABLE_PREFIX__items (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX __TABLE_PREFIX__items_created ON __TABLE_PREFIX__items (created_at);`,
    },
  ],
  // jobs: { refresh: async ({ host, signal }) => { await abortable(signal, host.http.fetch(...)); } },   // keys must match manifest.jobs
  routes(r, host) {
    // Owned by this registration, not by the module file: no hidden module-level state.
    const pusher = createSnapshotPusher(host);
    const snapshot = (): { value: number; label: string } => {
      const rows = host.store.db.all<Row>('SELECT id, label FROM __TABLE_PREFIX__items ORDER BY created_at DESC, id DESC');
      return { value: rows.length, label: rows[0]?.label ?? 'Example' };
    };

    r.get('/items', { level: 'view' }, () =>
      host.store.db.all<Row>('SELECT id, label FROM __TABLE_PREFIX__items ORDER BY created_at DESC, id DESC LIMIT 100'),
    );
    r.post('/items', { level: 'edit', body: NewItem }, (req) => {
      const id = newId(host.now()); // uuid v7, time-ordered; time comes from host.now()
      host.store.db.run('INSERT INTO __TABLE_PREFIX__items (id, label, created_at) VALUES (?, ?, ?)', [
        id,
        req.body.label,
        host.now().toISOString(),
      ]);
      pusher.push(null, snapshot()); // false (nothing sent) when the snapshot did not change
      return { id };
    });
    r.delete('/items/:id', { level: 'edit' }, (req) => {
      host.store.db.run('DELETE FROM __TABLE_PREFIX__items WHERE id = ?', [req.params['id']]);
      pusher.push(null, snapshot());
      return undefined; // 204, no body
    });
  },
});
