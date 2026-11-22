import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { runServerContractSuite, serverContractCases } from '../src/testing.js';
import { goodHappyHttp, goodServer } from './sample-module/good/server.js';
import { badServer } from './sample-module/bad/server.js';

const goodDir = path.join(import.meta.dirname, 'sample-module', 'good');
const badDir = path.join(import.meta.dirname, 'sample-module', 'bad');

const CASE_NAMES = [
  'manifest is valid',
  'jobs match manifest',
  'event handlers are declared',
  'migrations only touch own tables',
  'every route declares a level',
  'view level cannot call edit routes',
  'instance-scoped routes need a visible instance',
  'job survives bad upstream',
  'job publishes only declared events',
  'snapshots contain no secrets',
  'job honors abort signal',
];

describe('server contract suite: good sample', () => {
  runServerContractSuite(goodServer, {
    moduleDir: goodDir,
    happyHttp: goodHappyHttp,
    viewWrites: ['POST /read'],
  });
});

describe('server contract suite: bad sample', () => {
  test('exposes the eleven cases in order', () => {
    expect(serverContractCases(goodServer, { moduleDir: goodDir }).map((c) => c.name)).toEqual(CASE_NAMES);
  });

  test('fails exactly the migration, route and upstream cases', async () => {
    const cases = serverContractCases(badServer, {
      moduleDir: badDir,
      happyHttp: (h) => h.respond('api.example.test', { data: { value: 1 } }),
    });
    const failed: string[] = [];
    for (const c of cases) {
      try {
        await c.run();
      } catch {
        failed.push(c.name);
      }
    }
    expect(failed).toEqual([
      'migrations only touch own tables',
      'every route declares a level',
      'view level cannot call edit routes',
      'job survives bad upstream',
      'job publishes only declared events',
      'job honors abort signal',
    ]);
  });
});
