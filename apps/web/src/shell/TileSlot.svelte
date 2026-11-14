<script lang="ts">
  import { clientModules } from '../generated/modules.js';
  import type { Instance, ModuleRegistry } from '../lib/grid.js';
  import { t } from '../lib/i18n.js';
  import type { Page } from '../lib/pages.svelte.js';
  import TileHost from './TileHost.svelte';

  let {
    instance,
    page,
    modules = clientModules,
  }: { instance: Instance; page: Page; modules?: ModuleRegistry } = $props();

  const manifest = $derived(modules[instance.moduleId]?.manifest);
  const name = $derived(manifest ? t(`module.${manifest.id}.name`, manifest.name) : null);
</script>

<!-- Tile frame; the host loads the module and renders its tile inside the @dash/ui Tile surface. -->
<section
  class="tile"
  class:unavailable={!manifest}
  class:hosted={!!manifest}
  data-instance-id={instance.id}
  data-module-id={instance.moduleId}
  data-page-id={page.id}
  aria-label={name ?? t('tile.unavailable', 'Module unavailable')}
>
  {#if manifest}
    <TileHost {instance} {page} {modules} />
  {:else}
    <p class="name">{t('tile.unavailable', 'Module unavailable')}</p>
    <p class="hint">{instance.moduleId}</p>
  {/if}
</section>

<style>
  .tile {
    height: 100%; padding: var(--db-tile-pad, 12px); background: var(--db-surface, #fff);
    border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); color: var(--db-fg, #15181d);
    overflow: hidden;
  }
  .hosted { padding: 0; background: none; border: 0; border-radius: 0; overflow: visible; }
  .unavailable { color: var(--db-muted, #4a5260); border-style: dashed; }
  .name { margin: 0; font-weight: 600; }
  .hint { margin: 0.25rem 0 0; font-size: 0.85em; }
</style>
