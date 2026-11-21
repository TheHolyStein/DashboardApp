import { z } from 'zod';
import { createSnapshotPusher, defineServer, newId, type SnapshotPusher } from '@dash/module-kit';
import manifest from '../manifest.js';

// Typed route body: with `body: NewItem`, `req.body` is z.infer<typeof NewItem> (the server answers 422 first).
const NewItem = z.object({ label: z.string().trim().min(1).max(80) });

interface Row {
  id: string;
  label: string;
}

// Per-host state (the snapshot pusher, caches) lives in this closure and is created in `setup`, never at module scope.
function createServer() {
  let pusher: SnapshotPusher | undefined;
  const pusherOf = (): SnapshotPusher => {
    if (!pusher) throw new Error('setup has not run');
    return pusher;
  };

  return defineServer({
    manifest,
    // One migration may hold several statements (the table and its index). Ids ascend from 1; never edit a shipped one.
    migrations: [
      {
        id: 1,
        up: `CREATE TABLE m_todo_items (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX m_todo_items_created ON m_todo_items (created_at);`,
      },
    ],
    // jobs: { refresh: async ({ host, signal }) => { await abortable(signal, host.http.fetch(...)); } },   // keys must match manifest.jobs
    // Runs once after migrations, before the first job, route or event handler. A throw marks the module failed.
    setup(host) {
      pusher = createSnapshotPusher(host);
    },
    // teardown(host) { ... },   // optional: runs on shutdown before the database closes
    routes(r, host) {
      const snapshot = (): { value: number; label: string } => {
        const rows = host.store.db.all<Row>(
          'SELECT id, label FROM m_todo_items ORDER BY created_at DESC, id DESC',
        );
        return { value: rows.length, label: rows[0]?.label ?? 'Example' };
      };

      r.get('/items', { level: 'view' }, () =>
        host.store.db.all<Row>(
          'SELECT id, label FROM m_todo_items ORDER BY created_at DESC, id DESC LIMIT 100',
        ),
      );
      r.post('/items', { level: 'edit', body: NewItem }, (req) => {
        const id = newId(host.now()); // uuid v7, time-ordered; time comes from host.now()
        host.store.db.run(
          'INSERT INTO m_todo_items (id, label, created_at) VALUES (?, ?, ?)',
          [id, req.body.label, host.now().toISOString()],
        );
        pusherOf().push(null, snapshot()); // false (nothing sent) when the snapshot did not change
        return { id };
      });
      r.delete('/items/:id', { level: 'edit' }, (req) => {
        host.store.db.run('DELETE FROM m_todo_items WHERE id = ?', [req.params['id']]);
        pusherOf().push(null, snapshot());
        return undefined; // 204, no body
      });
    },
  });
}

export default createServer();
