import { describe, expect, it } from 'vitest';
import { abortable } from '../src/index.js';

describe('abortable', () => {
  it('resolves and rejects like the wrapped promise', async () => {
    const c = new AbortController();
    await expect(abortable(c.signal, Promise.resolve(5))).resolves.toBe(5);
    const err = new Error('x');
    await expect(abortable(c.signal, Promise.reject(err))).rejects.toBe(err);
  });

  it('rejects with DashError upstream/aborted as soon as the signal aborts', async () => {
    const c = new AbortController();
    const p = abortable(c.signal, new Promise<never>(() => undefined));
    c.abort();
    await expect(p).rejects.toMatchObject({ code: 'upstream', message: 'aborted' });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(abortable(c.signal, Promise.resolve(1))).rejects.toMatchObject({ code: 'upstream', message: 'aborted' });
  });

  it('removes its abort listener once the promise settles', async () => {
    const c = new AbortController();
    let removed = 0;
    const orig = c.signal.removeEventListener.bind(c.signal);
    c.signal.removeEventListener = ((...args: Parameters<typeof orig>) => {
      removed++;
      orig(...args);
    }) as typeof orig;
    await abortable(c.signal, Promise.resolve(1));
    expect(removed).toBe(1);
  });
});
