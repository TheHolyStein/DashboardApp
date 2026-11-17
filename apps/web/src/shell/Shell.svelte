<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import { offline } from '../lib/offline.svelte.js';
  import { pages } from '../lib/pages.svelte.js';
  import { rememberTheme } from '../lib/prefs.js';
  import { session } from '../lib/session.svelte.js';
  import { stream } from '../lib/stream.svelte.js';
  import { settingsArea } from '../lib/ui-state.svelte.js';
  import BackgroundHost from '../theme/BackgroundHost.svelte';
  import { sceneEnv } from '../theme/env.svelte.js';
  import Banners from './Banners.svelte';
  import Catalog from './Catalog.svelte';
  import DetailHost from './DetailHost.svelte';
  import NotificationToasts from './NotificationToasts.svelte';
  import PageTabs from './PageTabs.svelte';
  import Pages from './Pages.svelte';
  import SettingsDialog from './SettingsDialog.svelte';
  import TopBar from './TopBar.svelte';

  /** The user's first weather / moon snapshot data (those modules may not exist: then nothing is bound). */
  function firstData(moduleId: string): unknown {
    for (const p of pages.list) {
      for (const i of p.instances) {
        if (i.moduleId !== moduleId) continue;
        const s = stream.snapshots[i.id];
        if (s?.data !== undefined && s.data !== null) return s.data;
      }
    }
    return undefined;
  }

  onMount(() => {
    sceneEnv.bindSnapshots(() => ({ weather: firstData('weather'), moon: firstData('moon') }));
    return () => sceneEnv.bindSnapshots(null);
  });

  // The sign-in screen is themed with what was used last on this device.
  $effect(() => {
    const prefs = session.me?.prefs;
    if (prefs && !offline.restored) rememberTheme(prefs);
  });

  // The page layout changes what offline start can show.
  $effect(() => {
    void pages.list;
    offline.markDirty();
  });

  // The settings area (settings, admin screens, QR code) is fetched on first open.
  let SettingsArea = $state.raw<Component | null>(null);
  $effect(() => {
    if (settingsArea.open && !SettingsArea) void import('./SettingsArea.svelte').then((m) => (SettingsArea = m.default));
  });
</script>

<BackgroundHost background={pages.current?.background ?? null} />
<Banners />
<main class="signed-in" data-region="shell-content">
  <TopBar><PageTabs /></TopBar>
  <Pages />
  <DetailHost />
  <SettingsDialog />
  <Catalog />
  {#if SettingsArea}<SettingsArea />{/if}
</main>
<NotificationToasts />

<style>
  /* No background here: the theme's layer sits at z-index -1 behind this. */
  .signed-in { padding: 0 0.5rem 1rem; background: transparent; }
</style>
