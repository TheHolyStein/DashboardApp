import { createStream, type EventSourceLike, type StreamDeps } from '../../src/lib/stream.svelte.js';

export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  /** Deliver a raw message (string) or a StreamEvent object (JSON-encoded). */
  emit(ev: unknown): void {
    this.onmessage?.({ data: typeof ev === 'string' ? ev : JSON.stringify(ev) });
  }
  fail(): void {
    this.onerror?.({});
  }
  static get last(): FakeEventSource {
    const l = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!l) throw new Error('no EventSource opened');
    return l;
  }
}

export const snap = (instanceId: string, data: unknown = null) => ({
  type: 'snapshot' as const,
  snapshot: { instanceId, data, updatedAt: null, stale: false },
});
export const ping = () => ({ type: 'ping' as const, at: '2026-01-01T00:00:00Z' });

class FakeTarget {
  handlers = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    (this.handlers.get(type) ?? this.handlers.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.handlers.get(type)?.delete(fn);
  }
  fire(type: string): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn();
  }
  get count(): number {
    let n = 0;
    for (const s of this.handlers.values()) n += s.size;
    return n;
  }
}

/** Build an isolated stream with fakes. Use with `vi.useFakeTimers()`. */
export function makeStream(over: Partial<StreamDeps> = {}) {
  FakeEventSource.instances = [];
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const env = { online: true, visible: true, rand: 1, posts: [] as { path: string; body: unknown }[], failPost: false };
  const s = createStream({
    EventSource: FakeEventSource,
    post: (path, body) => {
      env.posts.push({ path, body });
      return env.failPost ? Promise.reject(new Error('x')) : Promise.resolve();
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    random: () => env.rand,
    isOnline: () => env.online,
    isVisible: () => env.visible,
    window: win,
    document: doc,
    ...over,
  });
  return { s, win, doc, env };
}
