import { expectTypeOf, test } from 'vitest';
import { z } from 'zod';
import {
  type EventName, type HostServices, type ModuleClient, type ModuleRouter, type ThemeSeam,
} from '../src/index.js';

test('bus.publish takes an EventName and a payload checked per event', () => {
  expectTypeOf<HostServices['bus']['publish']>().parameter(0).toEqualTypeOf<EventName>();
  // @ts-expect-error wrong payload shape for event
  ({} as HostServices).bus.publish('timer.finished', { nope: 1 });
});

test('typed route bodies: req.body is the inferred schema type; untyped usage still compiles', () => {
  const r = {} as ModuleRouter;
  const body = z.object({ label: z.string(), n: z.number() });
  const query = z.object({ q: z.string() });
  r.post('/x', { level: 'edit', body, query }, (req) => {
    expectTypeOf(req.body).toEqualTypeOf<{ label: string; n: number }>();
    expectTypeOf(req.query).toEqualTypeOf<{ q: string }>();
    return { ok: true }; // sync return allowed
  });
  r.get('/y', { level: 'view' }, (req) => {
    expectTypeOf(req.body).toBeUnknown();
    return Promise.resolve([]);
  });
  r.delete('/z', { level: 'edit' }, () => undefined);
});

test('theme seam type and ModuleClient.detail', () => {
  expectTypeOf<ThemeSeam['tileFor']>().toBeFunction();
  expectTypeOf<ModuleClient['detail']>().toEqualTypeOf<boolean | undefined>();
});
