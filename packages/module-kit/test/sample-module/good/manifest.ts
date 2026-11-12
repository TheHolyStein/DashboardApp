import { z } from 'zod';
import { defineManifest } from '../../../src/index.js';

export const goodManifest = defineManifest({
  id: 'sample',
  name: 'Sample',
  description: 'A tiny valid module used to test the module kit.',
  version: '1.0.0',
  icon: 'note',
  scope: 'shared',
  multiInstance: false,
  tile: { default: { w: 3, h: 2 }, min: { w: 2, h: 1 }, max: { w: 6, h: 4 } },
  settings: z.object({}),
  config: z.object({}),
  levels: ['view', 'edit'],
  jobs: [{ name: 'refresh', intervalSec: 60, mode: 'always', per: 'module' }],
  publishes: ['timer.finished'],
  subscribes: ['todo.changed'],
  outbound: [{ kind: 'host', host: 'api.example.test' }],
});
