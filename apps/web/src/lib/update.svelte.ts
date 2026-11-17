/** Service worker registration and the "update available" state. */

export interface WorkerLike {
  state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', fn: () => void): void;
}
export interface RegistrationLike {
  waiting: WorkerLike | null;
  installing: WorkerLike | null;
  addEventListener(type: 'updatefound', fn: () => void): void;
  update?(): Promise<unknown>;
}
export interface ContainerLike {
  controller: unknown;
  register(url: string): Promise<RegistrationLike>;
  addEventListener(type: 'controllerchange', fn: () => void): void;
}

export interface UpdaterDeps {
  container: ContainerLike | undefined;
  reload: () => void;
}

export function createUpdater(deps: UpdaterDeps) {
  let waiting = $state.raw<WorkerLike | null>(null);
  let reloading = false;

  function track(reg: RegistrationLike): void {
    if (reg.waiting && deps.container?.controller) waiting = reg.waiting;
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        // "installed" with a controller present = an update, not the first install
        if (w.state === 'installed' && deps.container?.controller) waiting = w;
      });
    });
  }

  return {
    get available(): boolean {
      return waiting !== null;
    },
    async register(url = '/sw.js'): Promise<void> {
      const c = deps.container;
      if (!c) return;
      c.addEventListener('controllerchange', () => {
        if (reloading || !waiting) return; // only after the user asked for the update; reload once
        reloading = true;
        deps.reload();
      });
      try {
        track(await c.register(url));
      } catch {
        /* no service worker: the app works online as before */
      }
    },
    /** The user's click: tell the waiting worker to take over; the page reloads when it does. */
    apply(): void {
      waiting?.postMessage({ type: 'SKIP_WAITING' });
    },
  };
}

export const updater = createUpdater({
  container: typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
  reload: () => location.reload(),
});
