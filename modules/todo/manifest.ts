import { z } from 'zod';
import { defineManifest } from '@dash/module-kit';

export default defineManifest({
  id: 'todo',
  name: 'Todo',
  description: 'TODO: one sentence about what Todo shows.',
  version: '0.1.0',
  icon: 'note',
  scope: 'shared',
  multiInstance: false,
  tile: { default: { w: 3, h: 2 }, min: { w: 2, h: 1 }, max: { w: 6, h: 4 } },
  settings: z.object({}),
  config: z.object({}),
  levels: ['view', 'edit'],
  jobs: [],
  publishes: [],
  subscribes: [],
  outbound: [],
});
