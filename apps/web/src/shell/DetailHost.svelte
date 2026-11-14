<script lang="ts">
  import { getContext, setContext, untrack } from 'svelte';
  import type { Mode } from '@dash/contract';
  import { Button, ICONS_KEY, Pane, T_KEY } from '@dash/ui';
  import { clientModules } from '../generated/modules.js';
  import { detail } from '../lib/detail.svelte.js';
  import { baseProps, loadClient, THEME_KEY, type HostRegistry, type ThemeSeam } from '../lib/host.js';
  import { t } from '../lib/i18n.js';
  import { pages } from '../lib/pages.svelte.js';
  import { session } from '../lib/session.svelte.js';

  let { modules = clientModules }: { modules?: HostRegistry } = $props();

  const theme = getContext<ThemeSeam | undefined>(THEME_KEY);
  setContext(T_KEY, t);
  let moduleIcons = $state<Record<string, string>>({});
  setContext(ICONS_KEY, (name: string): string | undefined => theme?.icon?.(name) ?? moduleIcons[name]);

  // The instance behind `?d=`, if the user can see it (it is on one of their pages and the module is not revoked).
  const found = $derived.by(() => {
    const id = detail.current?.id;
    if (!id) return null;
    for (const p of pages.list) {
      const i = p.instances.find((x) => x.id === id);
      if (i) return session.me?.grants[i.moduleId] === 'none' ? null : i;
    }
    return null;
  });

  // Once pages are known, drop an id the user cannot see from the URL.
  $effect(() => {
    if (pages.status === 'ready' && detail.current && !found) untrack(() => detail.drop());
  });

  const moduleId = $derived(found?.moduleId);
  const mode = $derived<Mode>(theme?.mode ?? 'day');
  let attempt = $state(0);
  const loading = $derived.by(() => {
    void attempt;
    const id = moduleId;
    if (!id) return null;
    return loadClient(modules[id], theme, false).then((loaded) => {
      moduleIcons = loaded.client.icons ?? {};
      return loaded;
    });
  });
  const title = $derived.by(() => {
    const m = moduleId ? modules[moduleId]?.manifest : undefined;
    return m ? t(`module.${m.id}.name`, m.name) : '';
  });
</script>

{#if found && loading}
  <Pane {title} onClose={() => detail.close()}>
    {#await loading}
      <div class="skeleton" role="status" aria-label={t('tile.loading', 'Loading')}></div>
    {:then loaded}
      {@const Body = loaded.client.Detail}
      <svelte:boundary>
        <Body {...baseProps(found, mode)} params={detail.current?.params ?? {}} close={() => detail.close()} />
        {#snippet failed(error, reset)}
          {@render failure(reset, error)}
        {/snippet}
      </svelte:boundary>
    {:catch}
      {@render failure(() => attempt++, undefined)}
    {/await}
  </Pane>
{/if}

{#snippet failure(retry: () => void, error: unknown)}
  <div class="failed" role="alert" data-failed="true">
    <p>{t('tile.failed', 'This module failed.')}</p>
    {#if import.meta.env.DEV && error}<pre class="err">{String(error)}</pre>{/if}
    <Button onclick={retry}>{t('tile.retry', 'Retry')}</Button>
  </div>
{/snippet}

<style>
  .skeleton { min-height: 6rem; border-radius: var(--db-radius, 8px); background: var(--db-surface-2, #eef0f4); }
  .failed { display: grid; gap: 0.5rem; justify-items: start; }
  .failed p { margin: 0; }
</style>
