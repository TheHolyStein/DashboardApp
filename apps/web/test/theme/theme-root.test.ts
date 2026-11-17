import { render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import RootWithConsumer from './fixtures/RootWithConsumer.svelte';

// ThemeRoot reads the `theme` singleton, whose registry is generated (empty here); swap in an engine with fixture themes.
vi.mock('../../src/theme/engine.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/theme/engine.svelte.js')>('../../src/theme/engine.svelte.js');
  // Minimal valid manifests (the shared harness imports this module, so it cannot be used inside the factory).
  const palette = { series: ['1', '2', '3', '4', '5', '6'], grid: '#111', axis: '#222', fill: 0.2, lineWidth: 2, glow: false };
  const make = (id: string, bell: string) => ({
    id,
    name: id,
    version: '1.0.0',
    description: id,
    css: ['tokens.css'],
    backgrounds: [{ id: 'p', name: 'P', component: () => Promise.reject(new Error('unused')), staticImage: 'p.webp' }],
    clockFaces: [{ id: 'd', name: 'D', component: () => Promise.reject(new Error('unused')) }],
    icons: { bell },
    strings: {},
    chart: { day: palette, night: palette },
    pane: { durationMs: 0, in: 'in', out: 'out' },
  });
  const themes = { default: make('default', '<svg d/>'), alt: make('alt', '<svg a/>') };
  const engine = actual.createThemeEngine({
    registry: Object.fromEntries(Object.entries(themes).map(([id, m]) => [id, { load: () => Promise.resolve({ default: m as never }) }])),
    document,
    now: () => new Date('2026-11-14T12:00:00Z'),
    loadStylesheet: () => Promise.resolve({ remove: () => undefined }),
    notify: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    sun: () => null,
    timeZone: () => 'UTC',
    locale: () => 'en',
    localeString: () => undefined,
    readToken: () => '',
    logError: () => undefined,
  });
  return { ...actual, theme: engine };
});

describe('ThemeRoot seam', () => {
  it('exposes reactive id, mode and icon to consumers without re-mounting', async () => {
    const { theme } = await import('../../src/theme/engine.svelte.js');
    await theme.set('default');
    theme.setPolicy('day');
    render(RootWithConsumer);
    const el = screen.getByTestId('seam');
    expect(el.textContent).toBe('default|day|<svg d/>');

    await theme.set('alt');
    flushSync();
    expect(screen.getByTestId('seam')).toBe(el);
    expect(el.textContent).toBe('alt|day|<svg a/>');

    theme.setPolicy('night');
    flushSync();
    expect(screen.getByTestId('seam')).toBe(el);
    expect(el.textContent).toBe('alt|night|<svg a/>');
  });
});
