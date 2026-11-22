import { runClientContractSuite } from '@dash/module-kit/client';
import client from '../client/index.js';

runClientContractSuite(client, {
  moduleDir: import.meta.dirname + '/..',
  tileFixture: 'tile',
});
