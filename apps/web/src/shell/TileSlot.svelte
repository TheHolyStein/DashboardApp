<script lang="ts">
  import { clientModules } from '../generated/modules.js';
  import type { Instance, ModuleRegistry } from '../lib/grid.js';
  import { t } from '../lib/i18n.js';
  import type { Page } from '../lib/pages.svelte.js';
  import { Button } from '@dash/ui';
  import { api } from '../lib/api.js';
  import { pages } from '../lib/pages.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import Confirm from './Confirm.svelte';
  import TileHost from './TileHost.svelte';

  let {
    instance,
    page,
    modules = clientModules,
  }: { instance: Instance; page: Page; modules?: ModuleRegistry } = $props();

  const manifest = $derived(modules[instance.moduleId]?.manifest);
  const name = $derived(manifest ? t(`module.${manifest.id}.name`, manifest.name) : null);

  const canRemove = $derived(pages.editing && page.ownerId === session.me?.id);
  let confirming = $state(false);
  let removing = $state(false);
  let removeError = $state(false);

  async function remove(): Promise<void> {
    if (removing) return;
    removing = true;
    removeError = false;
    try {
      await api.delete(`/instances/${encodeURIComponent(instance.id)}`);
      confirming = false;
      pages.removeInstance(instance.id);
    } catch {
      confirming = false;
      removeError = true;
    } finally {
      removing = false;
    }
  }
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
  {#if canRemove}
    <div class="remove">
      <Button variant="danger" data-edit aria-label={t('tile.remove', 'Remove {name}', { name: name ?? instance.moduleId })} onclick={() => (confirming = true)}>✕</Button>
    </div>
  {/if}
  {#if removeError}<p class="hint" role="alert">{t('tile.removeFailed', 'Could not remove the tile.')}</p>{/if}
{#if confirming}
  <Confirm
    title={t('tile.removeTitle', 'Remove tile?')}
    message={t('tile.removeMessage', 'Remove {name} from this page? Its settings are deleted.', { name: name ?? instance.moduleId })}
    confirmLabel={t('tile.removeConfirm', 'Remove')}
    busy={removing}
    onConfirm={() => void remove()}
    onCancel={() => (confirming = false)}
  />
{/if}
</section>

<style>
  .tile {
    position: relative; height: 100%; padding: var(--db-tile-pad, 12px); background: var(--db-surface, #fff);
    border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); color: var(--db-fg, #15181d);
    overflow: hidden;
  }
  .hosted { padding: 0; background: none; border: 0; border-radius: 0; overflow: visible; }
  .unavailable { color: var(--db-muted, #4a5260); border-style: dashed; }
  .remove { position: absolute; top: 4px; right: 4px; z-index: 2; }
  .name { margin: 0; font-weight: 600; }
  .hint { margin: 0.25rem 0 0; font-size: 0.85em; }
</style>
