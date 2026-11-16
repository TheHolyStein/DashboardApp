import type { Intensity } from '@dash/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSceneEnv } from '../../src/theme/env.svelte.js';
import {
  createIntensityGovernor,
  decideIntensity,
  setUserIntensityOverride,
  type BatteryLike,
  type GovernorDeps,
  type IntensityInputs,
} from '../../src/theme/intensity.js';

const base: IntensityInputs = { userOverride: null, reducedMotion: false, saveData: false, batteryLow: false, avgFps: null, hidden: false };

describe('decideIntensity', () => {
  it('override wins', () => {
    expect(decideIntensity({ ...base, userOverride: 'full', reducedMotion: true, saveData: true, batteryLow: true, avgFps: 5 })).toBe('full');
    expect(decideIntensity({ ...base, userOverride: 'static' })).toBe('static');
    expect(decideIntensity({ ...base, userOverride: 'calm' })).toBe('calm');
  });

  it('reduced motion → static', () => {
    expect(decideIntensity({ ...base, reducedMotion: true })).toBe('static');
    expect(decideIntensity({ ...base, saveData: true, batteryLow: true })).toBe('static');
  });

  it('battery low → calm, otherwise full; hidden does not change the level', () => {
    expect(decideIntensity({ ...base, batteryLow: true })).toBe('calm');
    expect(decideIntensity(base)).toBe('full');
    expect(decideIntensity({ ...base, hidden: true })).toBe('full');
  });

  it('low fps drops one level', () => {
    expect(decideIntensity({ ...base, avgFps: 29 })).toBe('calm');
    expect(decideIntensity({ ...base, avgFps: 30 })).toBe('full');
    expect(decideIntensity({ ...base, avgFps: 10, batteryLow: true })).toBe('static');
  });
});

/** Fake browser: manual rAF at a chosen frame rate, battery, media queries and visibility. */
function rig(o: { battery?: () => Promise<BatteryLike>; reduced?: boolean; saveData?: boolean } = {}) {
  let clock = 1000;
  let nextHandle = 1;
  const pending = new Map<number, () => void>();
  let rafRequests = 0;
  const applied: Intensity[] = [];
  const docListeners = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: (_: string, fn: () => void) => void docListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void docListeners.delete(fn),
  };
  const mq = { matches: o.reduced ?? false, change: new Set<() => void>(), addEventListener(_: string, fn: () => void) { this.change.add(fn); }, removeEventListener(_: string, fn: () => void) { this.change.delete(fn); } };
  let override: Intensity | null = null;
  const deps: Partial<GovernorDeps> & Pick<GovernorDeps, 'apply'> = {
    matchMedia: () => mq,
    connection: o.saveData ? { saveData: true } : undefined,
    getBattery: o.battery,
    requestAnimationFrame: (fn) => {
      rafRequests++;
      const h = nextHandle++;
      pending.set(h, fn);
      return h;
    },
    cancelAnimationFrame: (h) => void pending.delete(h),
    now: () => clock,
    document: doc,
    userOverride: () => override,
    apply: (i) => void applied.push(i),
  };
  const governor = createIntensityGovernor(deps);
  return {
    governor,
    applied,
    doc,
    mq,
    get rafRequests() {
      return rafRequests;
    },
    get pendingCount() {
      return pending.size;
    },
    get listenerCount() {
      return docListeners.size + mq.change.size;
    },
    setOverride: (i: Intensity | null) => {
      override = i;
      governor.refresh();
    },
    setHidden(h: boolean) {
      doc.hidden = h;
      docListeners.forEach((fn) => fn());
    },
    /** Run frames at `fps` for `ms` of fake time. */
    run(fps: number, ms: number) {
      const step = 1000 / fps;
      const end = clock + ms;
      while (clock < end) {
        const entry = [...pending.entries()][0];
        if (!entry) return;
        pending.delete(entry[0]);
        clock += step;
        entry[1]();
      }
    },
    flush: () => new Promise<void>((r) => setTimeout(r, 0)),
  };
}

afterEach(() => setUserIntensityOverride(null));

describe('createIntensityGovernor', () => {
  it('low fps drops one level and stays', () => {
    const r = rig();
    r.governor.start();
    expect(r.applied).toEqual(['full']);
    r.run(20, 3600);
    expect(r.applied).toEqual(['full', 'calm']);
    r.run(60, 10_000); // fast again: never climbs back
    expect(r.applied).toEqual(['full', 'calm']);
    r.governor.stop();
    r.governor.start(); // same session keeps the cap
    expect(r.applied.at(-1)).toBe('calm');
  });

  it('a second drop needs a fresh 3 s window and ends at static, which stops sampling', () => {
    const r = rig();
    r.governor.start();
    r.run(20, 3200);
    expect(r.applied).toEqual(['full', 'calm']);
    r.run(20, 2500); // less than a fresh window since the drop
    expect(r.applied).toEqual(['full', 'calm']);
    r.run(20, 1500);
    expect(r.applied).toEqual(['full', 'calm', 'static']);
    expect(r.pendingCount).toBe(0);
    const before = r.rafRequests;
    r.run(20, 5000);
    expect(r.rafRequests).toBe(before);
  });

  it('healthy fps keeps full', () => {
    const r = rig();
    r.governor.start();
    r.run(60, 10_000);
    expect(r.applied).toEqual(['full']);
  });

  it('battery low → calm, charging → full', async () => {
    const low = rig({ battery: () => Promise.resolve({ level: 0.15, charging: false }) });
    low.governor.start();
    await low.flush();
    expect(low.applied).toEqual(['full', 'calm']);
    const charging = rig({ battery: () => Promise.resolve({ level: 0.15, charging: true }) });
    charging.governor.start();
    await charging.flush();
    expect(charging.applied).toEqual(['full']);
    const edge = rig({ battery: () => Promise.resolve({ level: 0.2, charging: false }) });
    edge.governor.start();
    await edge.flush();
    expect(edge.applied).toEqual(['full']);
  });

  it('battery changes are followed', async () => {
    const listeners: Array<() => void> = [];
    const battery: BatteryLike = { level: 0.5, charging: false, addEventListener: (_, fn) => void listeners.push(fn) };
    const r = rig({ battery: () => Promise.resolve(battery) });
    r.governor.start();
    await r.flush();
    battery.level = 0.1;
    listeners.forEach((fn) => fn());
    expect(r.applied).toEqual(['full', 'calm']);
  });

  it('getBattery missing or rejecting → not low', async () => {
    const none = rig();
    none.governor.start();
    await none.flush();
    expect(none.applied).toEqual(['full']);
    const rejecting = rig({ battery: () => Promise.reject(new Error('denied')) });
    rejecting.governor.start();
    await rejecting.flush();
    expect(rejecting.applied).toEqual(['full']);
  });

  it('reduced motion and save-data give static without any rAF', () => {
    const r = rig({ reduced: true });
    r.governor.start();
    expect(r.applied).toEqual(['static']);
    expect(r.rafRequests).toBe(0);
    const s = rig({ saveData: true });
    s.governor.start();
    expect(s.applied).toEqual(['static']);
    expect(s.rafRequests).toBe(0);
  });

  it('follows prefers-reduced-motion changes', () => {
    const r = rig();
    r.governor.start();
    r.mq.matches = true;
    r.mq.change.forEach((fn) => fn());
    expect(r.applied).toEqual(['full', 'static']);
  });

  it('no rAF callbacks are requested while hidden or at static; visible resumes', () => {
    const r = rig();
    r.setHidden(true);
    r.governor.start();
    expect(r.rafRequests).toBe(0);
    expect(r.applied).toEqual(['full']); // hidden keeps the level
    r.setHidden(false);
    expect(r.pendingCount).toBe(1);
    r.setHidden(true);
    expect(r.pendingCount).toBe(0);
    const n = r.rafRequests;
    r.run(60, 1000);
    expect(r.rafRequests).toBe(n);
  });

  it('a hidden gap does not count towards the window', () => {
    const r = rig();
    r.governor.start();
    r.run(60, 2000);
    r.setHidden(true);
    r.setHidden(false);
    r.run(60, 2000); // 2 s + 2 s would span a window if the gap were kept; fresh window means no judgement yet
    expect(r.applied).toEqual(['full']);
  });

  it('user override wins and suspends sampling', () => {
    const r = rig();
    r.governor.start();
    r.setOverride('full');
    expect(r.pendingCount).toBe(0);
    r.run(10, 5000);
    expect(r.applied).toEqual(['full']);
    r.setOverride('static');
    expect(r.applied).toEqual(['full', 'static']);
    r.setOverride(null);
    expect(r.applied).toEqual(['full', 'static', 'full']);
    expect(r.pendingCount).toBe(1);
  });

  it('setUserIntensityOverride reaches running governors', () => {
    const o = rig();
    const deps = { apply: vi.fn() };
    const g = createIntensityGovernor({ ...deps, matchMedia: undefined, getBattery: undefined, connection: undefined, document: o.doc, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, now: () => 0 });
    g.start();
    g.setUserIntensityOverride('calm');
    expect(deps.apply).toHaveBeenLastCalledWith('calm');
    g.stop();
  });

  it('stop leaves no rAF or listeners behind', () => {
    const r = rig();
    r.governor.start();
    expect(r.listenerCount).toBeGreaterThan(0);
    r.governor.stop();
    expect(r.pendingCount).toBe(0);
    expect(r.listenerCount).toBe(0);
  });
});

describe('sceneEnv ticker', () => {
  it('ticks once per minute and stops while hidden', () => {
    vi.useFakeTimers();
    try {
      let t = Date.parse('2026-11-14T12:00:00Z');
      const listeners = new Set<() => void>();
      const doc = { hidden: false, addEventListener: (_: 'visibilitychange', fn: () => void) => void listeners.add(fn), removeEventListener: (_: 'visibilitychange', fn: () => void) => void listeners.delete(fn) };
      const env = createSceneEnv({ now: () => new Date(t), sun: () => null, setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as never), document: doc });
      env.start();
      t += 60_000;
      vi.advanceTimersByTime(60_000);
      expect(env.now.getTime()).toBe(t);
      expect(vi.getTimerCount()).toBe(1);
      doc.hidden = true;
      listeners.forEach((fn) => fn());
      expect(vi.getTimerCount()).toBe(0);
      const frozen = env.now.getTime();
      t += 5 * 60_000;
      vi.advanceTimersByTime(5 * 60_000);
      expect(env.now.getTime()).toBe(frozen);
      doc.hidden = false;
      listeners.forEach((fn) => fn());
      expect(env.now.getTime()).toBe(t); // catches up at once
      expect(vi.getTimerCount()).toBe(1);
      env.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sunAltitudeDeg is positive at noon, negative at night and null without data', () => {
    const sun = { sunrise: '2026-11-14T06:30:00Z', sunset: '2026-11-14T16:30:00Z' };
    let at = '2026-11-14T11:30:00Z';
    let data: typeof sun | null = sun;
    const mk = () => createSceneEnv({ now: () => new Date(at), sun: () => data, setInterval: () => 0, clearInterval: () => {}, document: undefined });
    const noon = mk().sunAltitudeDeg;
    expect(noon).toBeGreaterThan(50);
    expect(noon).toBeLessThanOrEqual(90);
    at = '2026-11-14T08:00:00Z';
    expect(mk().sunAltitudeDeg).toBeGreaterThan(0);
    expect(mk().sunAltitudeDeg).toBeLessThan(noon!);
    at = '2026-11-15T00:00:00Z';
    expect(mk().sunAltitudeDeg).toBe(-18);
    at = '2026-11-14T02:00:00Z';
    expect(mk().sunAltitudeDeg).toBeLessThan(0);
    at = '2026-11-20T11:30:00Z'; // stale snapshot from days ago: shifted by whole days
    expect(mk().sunAltitudeDeg).toBeGreaterThan(50);
    data = null;
    expect(mk().sunAltitudeDeg).toBeNull();
    data = { sunrise: 'nope', sunset: 'x' };
    expect(mk().sunAltitudeDeg).toBeNull();
  });

  it('weather and moon come from setters or bound snapshots', () => {
    const env = createSceneEnv({ now: () => new Date(0), sun: () => null, setInterval: () => 0, clearInterval: () => {}, document: undefined });
    expect([env.weather, env.moonPhase]).toEqual([null, null]);
    env.bindSnapshots(() => ({ weather: { condition: 'rain', tempC: 3 }, moon: { phase: 0.5 } }));
    expect([env.weather, env.moonPhase]).toEqual(['rain', 0.5]);
    env.setWeather('snow');
    env.setMoonPhase(0.25);
    expect([env.weather, env.moonPhase]).toEqual(['snow', 0.25]);
    env.setWeather(null);
    env.setMoonPhase(null);
    env.bindSnapshots(() => ({ weather: { condition: 'bogus' }, moon: { phase: 7 } }));
    expect([env.weather, env.moonPhase]).toEqual([null, null]);
  });
});
