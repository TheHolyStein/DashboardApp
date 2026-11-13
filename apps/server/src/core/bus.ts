import { events, type EventName, type ModuleId, type ModuleManifest } from '@dash/contract';
import type { Bus, LoadedModule, LoggerLike } from './modules/deps.js';

export interface BusDeps {
  manifests: (moduleId: ModuleId) => ModuleManifest | undefined;
  logger: LoggerLike;
}

type Handler = (payload: unknown) => void | Promise<void>;

/** Only the core may publish this event. */
const CORE_ONLY: ReadonlySet<EventName> = new Set<EventName>(['notification.created']);

/**
 * Typed in-process event bus. Publishing validates the payload against the catalog and the publisher's
 * manifest; delivery is asynchronous and each subscriber is isolated. Log lines carry module id and event
 * name only, never the payload.
 */
export function createBus(deps: BusDeps): Bus {
  const subs = new Map<EventName, Array<{ moduleId: ModuleId; fn: Handler }>>();
  const log = deps.logger;

  function failed(moduleId: ModuleId, name: EventName, err: unknown): void {
    log.error(
      { module: moduleId, event: name, err: err instanceof Error ? err.message : String(err) },
      'event subscriber failed',
    );
  }

  function publish(from: string, name: EventName, payload: unknown): void {
    if (!Object.hasOwn(events, name)) {
      log.warn({ module: from, event: name }, 'event dropped: unknown event name');
      return;
    }
    if (from !== 'core') {
      const manifest = deps.manifests(from);
      if (CORE_ONLY.has(name) || !manifest || !manifest.publishes.includes(name)) {
        log.warn({ module: from, event: name }, 'event dropped: publisher has not declared this event');
        return;
      }
    }
    const parsed = events[name].safeParse(payload);
    if (!parsed.success) {
      log.warn({ module: from, event: name }, 'event dropped: payload does not match the event schema');
      return;
    }
    const targets = [...(subs.get(name) ?? [])];
    if (targets.length === 0) return;
    queueMicrotask(() => {
      for (const t of targets) {
        try {
          const r = t.fn(parsed.data);
          if (r && typeof r.then === 'function') {
            r.then(undefined, (err: unknown) => failed(t.moduleId, name, err));
          }
        } catch (err) {
          failed(t.moduleId, name, err);
        }
      }
    });
  }

  function subscribe(moduleId: string, name: EventName, fn: Handler): void {
    if (!Object.hasOwn(events, name)) throw new Error(`unknown event "${name}"`);
    if (moduleId !== 'core') {
      const manifest = deps.manifests(moduleId);
      if (!manifest || !manifest.subscribes.includes(name)) {
        throw new Error(`module "${moduleId}" has not declared "${name}" in manifest.subscribes`);
      }
    }
    const list = subs.get(name) ?? [];
    list.push({ moduleId, fn });
    subs.set(name, list);
  }

  return { publish, subscribe };
}

/** Registers a loaded module's `on` handlers (each receives the module's own host). */
export function wireModuleSubscriptions(bus: Bus, mod: LoadedModule): void {
  if (mod.failed !== undefined) return;
  const on = (mod.server.on ?? {}) as Record<
    string,
    ((p: unknown, host: LoadedModule['host']) => Promise<void>) | undefined
  >;
  for (const [name, handler] of Object.entries(on)) {
    if (!handler) continue;
    bus.subscribe(mod.id, name as EventName, (payload) => handler(payload, mod.host));
  }
}
