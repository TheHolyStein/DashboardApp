import { z } from 'zod';
import { DashError } from '@dash/contract';
import { abortable, defineServer } from '../../../src/index.js';
import { goodManifest } from './manifest.js';

const Upstream = z.object({ value: z.number(), label: z.string() });

export const goodServer = defineServer({
  manifest: goodManifest,
  migrations: [
    { id: 1, up: 'CREATE TABLE m_sample_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL)' },
    { id: 2, up: 'CREATE INDEX m_sample_items_title ON m_sample_items (title)' },
  ],
  jobs: {
    async refresh({ host, signal }) {
      const key = await abortable(signal, host.secrets.get('apiKey'));
      let res;
      try {
        res = await abortable(
          signal,
          host.http.fetch('https://api.example.test/data', {
            headers: key ? { authorization: `Bearer ${key}` } : {},
          }),
        );
      } catch (e) {
        throw e instanceof DashError ? e : new DashError('upstream', 'request failed');
      }
      const parsed = res.status < 400 ? Upstream.safeParse(res.data) : null;
      if (!parsed?.success) throw new DashError('upstream', 'unexpected upstream response');
      host.push(null, parsed.data);
      host.bus.publish('timer.finished', { id: 'sample', label: parsed.data.label });
    },
  },
  routes(r, host) {
    r.get('/items/:id', { level: 'view' }, (req) => Promise.resolve({ id: req.params['id'] }));
    r.post('/items', { level: 'edit', body: z.object({ title: z.string() }) }, (req) => {
      const { title } = req.body;
      return Promise.resolve(host.store.db.run('INSERT INTO m_sample_items (title) VALUES (?)', [title]));
    });
    r.post('/read', { level: 'view' }, () => Promise.resolve({ ok: true }));
    r.get('/boom', { level: 'view' }, () => Promise.reject(new DashError('not_found', 'nothing here')));
    r.get('/crash', { level: 'view' }, () => Promise.reject(new Error('unexpected')));
  },
  on: {
    'todo.changed': async (_payload, host) => {
      await host.store.set('lastTodoChange', true);
    },
  },
});

export function goodHappyHttp(host: { respond: (m: string, r: { data: unknown }) => void }): void {
  host.respond('api.example.test', { data: { value: 42, label: 'Kitchen' } });
}
