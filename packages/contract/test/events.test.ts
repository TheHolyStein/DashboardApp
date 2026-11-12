import { test, expect } from 'vitest';
import { events } from '../src/index.js';

test('every event name is dot-separated lowercase', () =>
  Object.keys(events).forEach(k => expect(k).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/)));
test('weather.updated rejects unknown condition', () =>
  expect(events['weather.updated'].safeParse({ condition:'lava', tempC:1, nextPrecip:null, pollenMax:null, aqi:null }).success).toBe(false));
