<script lang="ts">
  import { tick } from 'svelte';
  import { DashError, InstanceDto } from '@dash/contract';
  import { Button, Icon, Pane } from '@dash/ui';
  import { clientModules } from '../generated/modules.js';
  import { api } from '../lib/api.js';
  import { t } from '../lib/i18n.js';
  import { pages } from '../lib/pages.svelte.js';
  import type { EditRegistry } from '../lib/schema-form.js';
  import { session } from '../lib/session.svelte.js';
  import { catalogUi } from '../lib/ui-state.svelte.js';

  let { modules = clientModules }: { modules?: EditRegistry } = $props();

  let filter = $state('');
  let error = $state('');
  let adding = $state<string | null>(null);

  const placed = $derived(
    new Set(pages.list.filter((p) => p.ownerId === session.me?.id).flatMap((p) => p.instances.map((i) => i.moduleId))),
  );
  const items = $derived.by(() => {
    const grants = session.me?.grants ?? {};
    const q = filter.trim().toLowerCase();
    return Object.values(modules)
      .filter((e) => grants[e.manifest.id] === 'view' || grants[e.manifest.id] === 'edit')
      .map((e) => ({
        id: e.manifest.id,
        icon: e.manifest.icon,
        name: t(`module.${e.manifest.id}.name`, e.manifest.name),
        description: t(`module.${e.manifest.id}.description`, e.manifest.description),
        taken: !e.manifest.multiInstance && placed.has(e.manifest.id),
      }))
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  const total = $derived(Object.keys(modules).length);

  function close(): void {
    catalogUi.open = false;
    filter = '';
    error = '';
  }

  function messageFor(e: unknown): string {
    if (e instanceof DashError) {
      if (e.code === 'conflict') return t('catalog.conflict', 'This module is already on one of your pages.');
      if (e.code === 'forbidden') return t('catalog.forbidden', 'You do not have access to this module.');
      if (e.code === 'not_found') return t('catalog.notFound', 'This module is not available.');
    }
    return t('catalog.failed', 'Could not add the module. Try again.');
  }

  async function add(moduleId: string): Promise<void> {
    const pageId = pages.currentId;
    if (!pageId || adding) return;
    adding = moduleId;
    error = '';
    try {
      // No layout: the server picks the first free slot and the module's default size.
      const created = await api.post('/instances', { moduleId, pageId }, InstanceDto);
      pages.addInstance(created);
      close();
      await tick();
      requestAnimationFrame(() => {
        const tile = [...document.querySelectorAll<HTMLElement>('[data-instance-id]')].find((el) => el.dataset.instanceId === created.id);
        tile?.scrollIntoView?.({ block: 'nearest' });
      });
    } catch (e) {
      error = messageFor(e);
    } finally {
      adding = null;
    }
  }
</script>

{#if catalogUi.open}
  <Pane title={t('catalog.title', 'Add a module')} onClose={close}>
    {#if total === 0}
      <p>{t('catalog.empty', 'No modules installed')}</p>
    {:else}
      <label class="filter">
        <span>{t('catalog.filter', 'Filter')}</span>
        <input type="search" bind:value={filter} />
      </label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if items.length === 0}
        <p>{t('catalog.none', 'No matching modules')}</p>
      {:else}
        <ul class="list">
          {#each items as m (m.id)}
            <li>
              <Button data-edit disabled={m.taken || adding !== null} onclick={() => void add(m.id)}>
                <span class="card">
                  <Icon name={m.icon} />
                  <span class="text">
                    <strong>{m.name}</strong>
                    <span class="desc">{m.description}</span>
                    {#if m.taken}<em class="note">{t('catalog.placed', 'Already added')}</em>{/if}
                  </span>
                </span>
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </Pane>
{/if}

<style>
  .filter { display: grid; gap: 0.25rem; margin-bottom: var(--db-gap, 8px); }
  .filter input {
    font: inherit; padding: 0.4rem 0.5rem; color: var(--db-fg, #15181d); background: var(--db-surface, #fff);
    border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px);
  }
  .list { display: grid; gap: var(--db-gap, 8px); padding: 0; margin: 0; list-style: none; }
  .list :global(.btn) { width: 100%; text-align: left; }
  .card { display: flex; gap: 0.75rem; align-items: center; }
  .text { display: grid; gap: 0.15rem; }
  .desc, .note { font-size: 0.85em; color: var(--db-muted, #4a5260); }
  .error { color: var(--db-danger, #b42318); }
</style>
