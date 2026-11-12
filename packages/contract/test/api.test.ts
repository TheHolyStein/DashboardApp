import { test, expect } from 'vitest';
import { StreamEvent, HTTP_STATUS } from '../src/index.js';

test('StreamEvent parses a snapshot', () =>
  expect(StreamEvent.parse({ type:'snapshot', snapshot:{ instanceId:'i', data:{a:1}, updatedAt:null, stale:false } }).type).toBe('snapshot'));
test('StreamEvent rejects unknown type', () => expect(StreamEvent.safeParse({ type:'x' }).success).toBe(false));
test('HTTP_STATUS maps conflict to 409 and invalid to 422', () => { expect(HTTP_STATUS.conflict).toBe(409); expect(HTTP_STATUS.invalid).toBe(422); });
