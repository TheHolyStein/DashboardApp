<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '@dash/ui';
  import { z } from 'zod';
  import { clientModules } from '../../generated/modules.js';
  import {
    AdminModule,
    AdminUser,
    GrantRow,
    isCode,
    isForbidden,
    type AdminModuleT,
    type AdminUserT,
    type GrantLevel,
  } from '../../lib/admin-api.js';
  import { api } from '../../lib/api.js';
  import { t } from '../../lib/i18n.js';
  import { session } from '../../lib/session.svelte.js';

  let { modules = clientModules }: { modules?: Record<string, { manifest: { levels: ReadonlyArray<'view' | 'edit'> } }> } = $props();

  const admin = $derived(session.me?.role === 'admin');
  let users = $state<AdminUserT[]>([]);
  let mods = $state<AdminModuleT[]>([]);
  let levels = $state<Record<string, GrantLevel>>({});
  let cellError = $state<Record<string, string>>({});
  let status = $state<'loading' | 'ready' | 'denied' | 'error'>('loading');

  const key = (userId: string, moduleId: string): string => `${userId}\u0000${moduleId}`;
  const shown = $derived(mods.filter((m) => !m.failed));

  /** The levels a module supports: its client manifest when known, else what the server reports. */
  function offered(m: AdminModuleT): ReadonlyArray<'view' | 'edit'> {
    return Object.hasOwn(modules, m.id) ? modules[m.id]!.manifest.levels : m.levels;
  }

  async function load(): Promise<void> {
    if (!admin) return; // members never reach an admin route
    status = 'loading';
    try {
      const [u, m, g] = await Promise.all([
        api.get('/admin/users', z.array(AdminUser)),
        api.get('/admin/modules', z.array(AdminModule)),
        api.get('/admin/grants', z.array(GrantRow)),
      ]);
      users = u;
      mods = m;
      levels = Object.fromEntries(g.map((r) => [key(r.userId, r.moduleId), r.level]));
      status = 'ready';
    } catch (e) {
      status = isForbidden(e) ? 'denied' : 'error';
    }
  }
  onMount(() => void load());

  async function change(userId: string, moduleId: string, level: GrantLevel): Promise<void> {
    const k = key(userId, moduleId);
    const previous = levels[k] ?? 'none';
    delete cellError[k];
    levels[k] = level; // optimistic
    try {
      await api.put('/admin/grants', { userId, moduleId, level });
    } catch (e) {
      levels[k] = previous;
      cellError[k] = isCode(e, 'invalid')
        ? t('grants.unsupported', 'This module does not support that level.')
        : isForbidden(e)
          ? t('admin.denied', 'You are not allowed to do this.')
          : t('grants.failed', 'Could not save.');
    }
  }
  const levelName = (l: GrantLevel): string =>
    l === 'none' ? t('grants.none', 'none') : l === 'view' ? t('grants.view', 'view') : t('grants.edit', 'edit');
</script>

{#if admin}
  <div class="st">
    {#if status === 'denied'}
      <p role="alert">{t('admin.denied', 'You are not allowed to do this.')}</p>
    {:else if status === 'error'}
      <p role="alert">{t('admin.loadFailed', 'Could not load this list.')} <Button onclick={() => void load()}>{t('pages.retry', 'Retry')}</Button></p>
    {:else if status === 'loading'}
      <p role="status">{t('settings.loading', 'Loading…')}</p>
    {:else if shown.length === 0}
      <p class="muted">{t('grants.noModules', 'No modules installed.')}</p>
    {:else}
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('grants.user', 'User')}</th>
              {#each shown as m (m.id)}<th scope="col">{t(`module.${m.id}.name`, m.name)}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each users as u (u.id)}
              <tr>
                <th scope="row">{u.name}</th>
                {#each shown as m (m.id)}
                  {@const k = key(u.id, m.id)}
                  <td>
                    {#if u.role === 'admin'}
                      <span class="muted">{t('grants.adminEdit', 'edit (admin)')}</span>
                    {:else}
                      <select
                        aria-label={t('grants.cell', '{user}: {module}', { user: u.name, module: t(`module.${m.id}.name`, m.name) })}
                        value={levels[k] ?? 'none'}
                        onchange={(e) => void change(u.id, m.id, e.currentTarget.value as GrantLevel)}
                      >
                        <option value="none">{levelName('none')}</option>
                        {#each offered(m) as l (l)}<option value={l}>{levelName(l)}</option>{/each}
                      </select>
                      {#if cellError[k]}<span class="err" role="alert">{cellError[k]}</span>{/if}
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
{/if}
