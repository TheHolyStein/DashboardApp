import { defineServer } from '@dash/module-kit';
import manifest from '../manifest.js';
import { migrations } from './migrations.js';

// T1: storage and rules only; routes, requests, snapshots and the rollover job arrive with T2.
export default defineServer({
  manifest,
  migrations,
  jobs: { rollover: () => Promise.resolve() },
});
