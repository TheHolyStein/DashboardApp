<script lang="ts">
  import { PageDto } from '@dash/contract';
  import { Button } from '@dash/ui';
  import { isCode } from '../../lib/admin-api.js';
  import { api } from '../../lib/api.js';
  import { t } from '../../lib/i18n.js';
  import { pages } from '../../lib/pages.svelte.js';
  import { session } from '../../lib/session.svelte.js';
  import Confirm from '../Confirm.svelte';

  const mine = $derived(pages.list.filter((p) => p.ownerId === session.me?.id));
  let newName = $state('');
  let names = $state<Record<string, string>>({});
  let error = $state('');
  let removing = $state<{ id: string; name: string } | null>(null);

  const nameOf = (id: string, fallback: string): string => names[id] ?? fallback;

  async function add(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    error = '';
    try {
      pages.addPage(await api.post('/pages', { name: newName.trim() }, PageDto));
      newName = '';
    } catch {
      error = t('pages.addFailed', 'Could not add the page.');
    }
  }
  async function rename(id: string): Promise<void> {
    error = '';
    const name = (names[id] ?? '').trim();
    if (!name) return;
    try {
      pages.replacePage(await api.patch(`/pages/${encodeURIComponent(id)}`, { name }, PageDto));
      delete names[id];
    } catch {
      error = t('pages.renameFailed', 'Could not rename the page.');
    }
  }
  async function remove(): Promise<void> {
    const target = removing;
    if (!target) return;
    removing = null;
    error = '';
    try {
      await api.delete(`/pages/${encodeURIComponent(target.id)}`);
      pages.removePage(target.id);
    } catch (e) {
      error = isCode(e, 'conflict')
        ? t('pages.lastPage', 'The last page cannot be deleted.')
        : t('pages.deleteFailed', 'Could not delete the page.');
    }
  }
</script>

<div class="st">
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  <ul class="plain">
    {#each mine as p (p.id)}
      <li class="card">
        <div class="row">
          <label>
            <span class="muted">{t('pages.name', 'Name')}</span>
            <input value={nameOf(p.id, p.name)} maxlength="80" oninput={(e) => (names[p.id] = e.currentTarget.value)} />
          </label>
          <Button data-edit disabled={nameOf(p.id, p.name).trim() === '' || nameOf(p.id, p.name) === p.name} onclick={() => void rename(p.id)}>{t('pages.rename', 'Rename')}</Button>
          <Button variant="danger" data-edit onclick={() => (removing = { id: p.id, name: p.name })}>{t('pages.delete', 'Delete')}</Button>
        </div>
      </li>
    {/each}
  </ul>
  <form onsubmit={add}>
    <label>{t('pages.newName', 'New page')}<input required maxlength="80" bind:value={newName} /></label>
    <div class="row"><Button type="submit" variant="primary" data-edit>{t('pages.add', 'Add page')}</Button></div>
  </form>
</div>

{#if removing}
  <Confirm
    title={t('pages.deleteTitle', 'Delete page')}
    message={t('pages.deleteMsg', 'Delete “{name}” and all of its tiles?', { name: removing.name })}
    confirmLabel={t('pages.delete', 'Delete')}
    onConfirm={() => void remove()}
    onCancel={() => (removing = null)}
  />
{/if}
