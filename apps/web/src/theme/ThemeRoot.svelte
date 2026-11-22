<script lang="ts">
  import { setContext, untrack, type Snippet } from 'svelte';
  import { ICONS_CONTEXT_KEY, T_CONTEXT_KEY, THEME_CONTEXT_KEY, type ThemeSeam } from '@dash/contract';
  import { session } from '../lib/session.svelte.js';
  import { theme } from './engine.svelte.js';

  let { children }: { children: Snippet } = $props();

  const iconOrUndefined = (name: string): string | undefined => theme.icon(name) || undefined;
  const seam = {
    tileFor: (moduleId: string, size?: { w: number; h: number }) => theme.tileFor(moduleId, size),
    clockFace: (id?: string) => theme.clockFace(id),
    icon: iconOrUndefined,
    chart: () => theme.chart(),
    get id() {
      return theme.id;
    },
    get mode() {
      return theme.mode;
    },
  };

  setContext(THEME_CONTEXT_KEY, seam satisfies ThemeSeam);
  setContext(ICONS_CONTEXT_KEY, iconOrUndefined);
  setContext(T_CONTEXT_KEY, theme.t);

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
