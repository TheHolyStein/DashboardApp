// Child process for db.crash.test.ts: inserts rows in transactions forever and prints the
// committed row count after each commit. Killed with SIGKILL by the parent.
import { writeSync } from 'node:fs';
import { openDb } from '../../../src/core/db.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: crash-writer.ts <db file>');
const BATCH = 10;

const db = openDb(file);
db.exec('CREATE TABLE IF NOT EXISTS crash_rows (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
const insert = db.prepare('INSERT INTO crash_rows (payload) VALUES (?)');
const commitBatch = db.transaction(() => {
  for (let i = 0; i < BATCH; i++) insert.run('x'.repeat(200));
});

let committed = 0;
writeSync(1, 'ready\n');
for (;;) {
  // `intent` is printed before COMMIT, `done` after it (synchronous writes, one per line). A kill
  // between COMMIT and the `done` line leaves the DB at the last `intent` value.
  writeSync(1, `intent ${committed + BATCH}\n`);
  commitBatch();
  committed += BATCH;
  writeSync(1, `done ${committed}\n`);
}
