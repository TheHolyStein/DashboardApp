import type { ChartPalette, Mode } from '@dash/contract';

/** Reactive stand-in for the theme engine's `dash:theme` seam. */
export function makeThemeSeam(initial: ChartPalette, initialMode: Mode = 'day') {
  let palette = $state(initial);
  let mode = $state<Mode>(initialMode);
  return {
    chart: () => palette,
    get mode() { return mode; },
    set(p: ChartPalette, m: Mode) { palette = p; mode = m; },
  };
}
