import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ModuleClient } from '@dash/contract';
import { clientContractCases } from '../src/suite-client.js';
import { goodClient } from './sample-module/good/client.js';
import ThrowsAtNight from './sample-module/negative/ThrowsAtNight.svelte';
import ThrowsOnUndefined from './sample-module/negative/ThrowsOnUndefined.svelte';
import ThrowsWhenStale from './sample-module/negative/ThrowsWhenStale.svelte';
import ThrowsWhenSmall from './sample-module/negative/ThrowsWhenSmall.svelte';
import ThrowsAlways from './sample-module/negative/ThrowsAlways.svelte';
import HardcodedWhenEmpty from './sample-module/negative/HardcodedWhenEmpty.svelte';
import Substring from './sample-module/negative/Substring.svelte';
import DataValue from './sample-module/negative/DataValue.svelte';
import DataUser from './sample-module/negative/DataUser.svelte';
import DataUserInDataValue from './sample-module/negative/DataUserInDataValue.svelte';
import ExpectsSuiteLocale from './sample-module/negative/ExpectsSuiteLocale.svelte';
import DataValueProse from './sample-module/negative/DataValueProse.svelte';

const opts = {
  moduleDir: path.join(import.meta.dirname, 'sample-module', 'good'),
  tileFixture: 'sample',
  detailFixture: 'detail',
};

async function failedCases(client: ModuleClient): Promise<string[]> {
  const failed: string[] = [];
  for (const c of clientContractCases(client, opts)) {
    try {
      await c.run();
    } catch {
      failed.push(c.name);
    }
  }
  return failed;
}

const withTile = (Tile: ModuleClient['Tile']): ModuleClient => ({ ...goodClient, Tile });

describe('client contract cases fail for the matching fault', () => {
  test('good sample passes every case', async () => {
    expect(await failedCases(goodClient)).toEqual([]);
  });

  test('tile renders with fixture data (night)', async () => {
    expect(await failedCases(withTile(ThrowsAtNight))).toContain('tile renders with fixture data');
  });

  test('tile renders with data undefined', async () => {
    expect(await failedCases(withTile(ThrowsOnUndefined))).toContain('tile renders with data undefined');
  });

  test('tile renders stale state', async () => {
    expect(await failedCases(withTile(ThrowsWhenStale))).toContain('tile renders stale state');
  });

  test('tile renders at min and max size', async () => {
    expect(await failedCases(withTile(ThrowsWhenSmall))).toContain('tile renders at min and max size');
  });

  test('detail renders with fixture data', async () => {
    expect(await failedCases({ ...goodClient, Detail: ThrowsAlways })).toContain('detail renders with fixture data');
  });

  test('all visible text goes through t(): hard-coded text in the empty and stale states', async () => {
    expect(await failedCases(withTile(HardcodedWhenEmpty))).toContain('all visible text goes through t()');
  });

  test('all visible text goes through t(): fixture exemption matches whole tokens only', async () => {
    expect(await failedCases(withTile(Substring))).toContain('all visible text goes through t()');
  });

  test('all visible text goes through t(): a data-value span holding a sentence fails', async () => {
    expect(await failedCases(withTile(DataValueProse))).toContain('all visible text goes through t()');
  });

  test('all visible text goes through t(): a data-value span holding a formatted time passes', async () => {
    expect(await failedCases(withTile(DataValue))).not.toContain('all visible text goes through t()');
  });

  test('all visible text goes through t(): text inside data-user passes, the same text in data-value fails', async () => {
    expect(await failedCases(withTile(DataUser))).not.toContain('all visible text goes through t()');
    expect(await failedCases(withTile(DataUserInDataValue))).toContain('all visible text goes through t()');
  });

  test('the suite renders tiles and details with explicit locale and time zone (de-DE, Asia/Kolkata)', async () => {
    expect(await failedCases(withTile(ExpectsSuiteLocale))).toEqual([]);
    expect(await failedCases({ ...goodClient, Detail: ExpectsSuiteLocale })).toEqual([]);
  });
});
