import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { clientContractCases, runClientContractSuite } from '../src/suite-client.js';
import { goodClient } from './sample-module/good/client.js';
import { badClient } from './sample-module/bad/client.js';

const goodDir = path.join(import.meta.dirname, 'sample-module', 'good');
const badDir = path.join(import.meta.dirname, 'sample-module', 'bad');

describe('client contract suite: good sample', () => {
  runClientContractSuite(goodClient, { moduleDir: goodDir, tileFixture: 'sample', detailFixture: 'detail' });
});

describe('client contract suite: bad sample', () => {
  test('fails the t() and view-level cases only', async () => {
    const cases = clientContractCases(badClient, { moduleDir: badDir, tileFixture: 'sample' });
    expect(cases.map((c) => c.name)).toEqual([
      'tile renders with fixture data',
      'tile renders with data undefined',
      'tile renders stale state',
      'tile renders at min and max size',
      'detail renders with fixture data',
      'all visible text goes through t()',
      'view level shows no edit controls',
    ]);
    const failed: string[] = [];
    for (const c of cases) {
      try {
        await c.run();
      } catch {
        failed.push(c.name);
      }
    }
    expect(failed).toEqual(['all visible text goes through t()', 'view level shows no edit controls']);
  });
});
