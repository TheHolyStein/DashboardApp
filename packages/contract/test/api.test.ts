import { test, expect } from 'vitest';
import { StreamEvent, HTTP_STATUS, CONTRACT_VERSION, THEME_CONTEXT_KEY, T_CONTEXT_KEY, ICONS_CONTEXT_KEY, NotificationDto, MeDto } from '../src/index.js';

test('StreamEvent parses a snapshot', () =>
  expect(StreamEvent.parse({ type:'snapshot', snapshot:{ instanceId:'i', data:{a:1}, updatedAt:null, stale:false } }).type).toBe('snapshot'));
test('StreamEvent rejects unknown type', () => expect(StreamEvent.safeParse({ type:'x' }).success).toBe(false));
test('HTTP_STATUS maps conflict to 409 and invalid to 422', () => { expect(HTTP_STATUS.conflict).toBe(409); expect(HTTP_STATUS.invalid).toBe(422); });

test('contract v2 constants', () => {
  expect(CONTRACT_VERSION).toBe(2);
  expect([THEME_CONTEXT_KEY, T_CONTEXT_KEY, ICONS_CONTEXT_KEY]).toEqual(['dash:theme', 'dash:t', 'dash:icons']);
});
test('NotificationDto carries nullable text keys; MeDto carries totpEnabled', () => {
  const n = { id: 'n', moduleId: 'clock', level: 'info', title: 'T', body: null, titleKey: 'k', bodyKey: null, vars: { a: 1, b: 'x' }, url: null, createdAt: 'c', readAt: null };
  expect(NotificationDto.parse(n).vars).toEqual({ a: 1, b: 'x' });
  expect(NotificationDto.safeParse({ ...n, titleKey: undefined }).success).toBe(false);
  const me = { id: 'u', name: 'n', handle: 'h', role: 'member', grants: {}, csrf: 'c', totpEnabled: true, prefs: { theme: 'default', modePolicy: 'system', locale: 'en', timeZone: 'UTC' } };
  expect(MeDto.parse(me).totpEnabled).toBe(true);
  expect(MeDto.safeParse({ ...me, totpEnabled: undefined }).success).toBe(false);
});
