import { expectTypeOf, test } from 'vitest';
import type { EventName, HostServices } from '../src/index.js';

test('bus.publish takes an EventName and a payload checked per event', () => {
  expectTypeOf<HostServices['bus']['publish']>().parameter(0).toEqualTypeOf<EventName>();
  // @ts-expect-error wrong payload shape for event
  ({} as HostServices).bus.publish('timer.finished', { nope: 1 });
});
