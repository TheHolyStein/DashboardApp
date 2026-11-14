<script lang="ts">
  import { setContext, untrack, type Snippet } from 'svelte';
  import { ICONS_KEY, T_KEY } from '@dash/ui';
  import { THEME_KEY, type ThemeSeam } from '../lib/host.js';
  import { session } from '../lib/session.svelte.js';
  import { theme } from './engine.svelte.js';

  let { children }: { children: Snippet } = $props();

  const iconOrUndefined = (name: string): string | undefined => theme.icon(name) || undefined;
  const seam = {
    tileFor: (moduleId: string, size?: { w: number; h: number }) => theme.tileFor(moduleId, size),
    clockFace: (id?: string) => theme.clockFace(id),
    icon: iconOrUndefined,
    chart: () => theme.chart(),
    get mode() {
      return theme.mode;
    },
  };

  setContext(THEME_KEY, seam satisfies ThemeSeam);
  setContext(ICONS_KEY, iconOrUndefined);
  setContext(T_KEY, theme.t);

  $effect(() => {
    const prefs = session.status === 'signedIn' ? session.me?.prefs : undefined;
    const themeId = prefs?.theme ?? 'default';
    const policy = prefs?.modePolicy;
    const status = session.status;
    untrack(() => {
      if (policy) theme.setPolicy(policy);
      if (status !== 'loading') void theme.set(themeId);
    });
  });
</script>

{@render children()}
