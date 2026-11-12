import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DashError, type ModuleServer } from '@dash/contract';
import { serverContractCases, type ServerSuiteOptions } from '../src/index.js';
import { goodHappyHttp, goodServer } from './sample-module/good/server.js';
import { goodManifest } from './sample-module/good/manifest.js';

const opts: ServerSuiteOptions = {
  moduleDir: path.join(import.meta.dirname, 'sample-module', 'good'),
  happyHttp: goodHappyHttp,
  viewWrites: ['POST /read'],
};

async function failedCases(server: ModuleServer): Promise<string[]> {
  const failed: string[] = [];
  for (const c of serverContractCases(server, opts)) {
    try {
      await c.run();
    } catch {
      failed.push(c.name);
    }
  }
  return failed;
}

describe('server contract cases fail for the matching fault', () => {
  test('good sample passes every case', async () => {
    expect(await failedCases(goodServer)).toEqual([]);
  });

  test('manifest is valid', async () => {
    const server = { ...goodServer, manifest: { ...goodManifest, version: 'nope' } };
    expect(await failedCases(server)).toContain('manifest is valid');
  });

  test('jobs match manifest', async () => {
    const server = { ...goodServer, jobs: { ...goodServer.jobs, undeclared: () => Promise.resolve() } };
    expect(await failedCases(server)).toEqual(['jobs match manifest']);
  });

  test('event handlers are declared', async () => {
    const server = { ...goodServer, on: { 'timer.finished': () => Promise.resolve() } };
    expect(await failedCases(server)).toEqual(['event handlers are declared']);
  });

  test('snapshots contain no secrets', async () => {
    const server: ModuleServer = {
      ...goodServer,
      jobs: {
        refresh: async ({ host }) => {
          host.push(null, { key: await host.secrets.get('apiKey') });
        },
      },
    };
    expect(await failedCases(server)).toEqual(['snapshots contain no secrets']);
  });

  test('job honors abort signal', async () => {
    const server: ModuleServer = {
      ...goodServer,
      jobs: {
        // never reads ctx.signal
        refresh: async ({ host }) => {
          try {
            await host.http.fetch('https://api.example.test/data');
          } catch {
            throw new DashError('upstream', 'failed');
          }
        },
      },
    };
    expect(await failedCases(server)).toEqual(['job honors abort signal']);
  });
});
