import type { ThemeManifest } from '@dash/contract';

// Themes may import only @dash/contract, @dash/ui and their own files, so this is a typed
// object instead of `defineTheme(...)` from @dash/module-kit (which defineTheme only types).
const theme: ThemeManifest = {
  id: 'sample',
  name: 'Sample',
  version: '0.1.0',
  description: 'TODO: one sentence about the look of Sample.',
  css: ['tokens.css'],
  backgrounds: [
    {
      id: 'plain',
      name: 'Plain',
      component: () => import('./background/Plain.svelte'),
      staticImage: 'background/plain.webp',
    },
  ],
  clockFaces: [{ id: 'digital', name: 'Digital', component: () => import('./clock/Digital.svelte') }],
  icons: {},
  strings: {},
  chart: {
    day: {
      series: ['#1d4ed8', '#b45309', '#047857', '#be123c', '#6d28d9', '#0e7490'],
      grid: '#d5d9e0',
      axis: '#4a5160',
      fill: 0.15,
      lineWidth: 2,
      glow: false,
    },
    night: {
      series: ['#7aa2ff', '#fbbf24', '#34d399', '#fb7185', '#a78bfa', '#22d3ee'],
      grid: '#2a303c',
      axis: '#a3aab8',
      fill: 0.2,
      lineWidth: 2,
      glow: false,
    },
  },
  pane: { durationMs: 250, in: 'db-pane-in', out: 'db-pane-out' },
};

export default theme;
