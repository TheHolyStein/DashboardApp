import { test, expect } from 'vitest';
import { z } from 'zod';
import { validateManifest, type ModuleManifest } from '../src/index.js';

const base = (): ModuleManifest => ({ id:'clock', name:'Clock', description:'', version:'1.0.0', icon:'clock',
  scope:'user', multiInstance:true, tile:{ default:{w:3,h:2}, min:{w:2,h:1}, max:{w:6,h:4} },
  settings:z.object({}), config:z.object({}), levels:['view'], jobs:[], publishes:[], subscribes:[], outbound:[] });
test('valid manifest has no problems', () => expect(validateManifest(base())).toEqual([]));
test('rejects bad id', () => expect(validateManifest({ ...base(), id:'Clock!' })).toHaveLength(1));
test('rejects default smaller than min', () =>
  expect(validateManifest({ ...base(), tile:{ default:{w:1,h:1}, min:{w:2,h:1}, max:{w:6,h:4} } })).toHaveLength(1));
test('rejects tile wider than grid', () =>
  expect(validateManifest({ ...base(), tile:{ default:{w:3,h:2}, min:{w:2,h:1}, max:{w:13,h:4} } })).toHaveLength(1));
test('rejects duplicate job names and interval < 5', () =>
  expect(validateManifest({ ...base(), jobs:[
    { name:'a', intervalSec:60, mode:'always', per:'module' },
    { name:'a', intervalSec:1,  mode:'always', per:'module' } ] })).toHaveLength(2));
test('rejects host rule with scheme', () =>
  expect(validateManifest({ ...base(), outbound:[{ kind:'host', host:'https://x.org/a' }] })).toHaveLength(1));
test('rejects unknown event name', () =>
  expect(validateManifest({ ...base(), publishes:['nope.event' as never] })).toHaveLength(1));
