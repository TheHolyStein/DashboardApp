import { runServerContractSuite } from '@dash/module-kit';
import server from '../server/index.js';

runServerContractSuite(server, {
  moduleDir: import.meta.dirname + '/..',
  // happyHttp: (host) => host.respond('api.example.com', { data: { ... } }),
  // viewWrites: ['POST /read'],   // non-GET routes at level view that only change the caller's own state
});
