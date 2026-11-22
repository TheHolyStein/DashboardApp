<script lang="ts">
  import { onMount } from 'svelte';
  import { DashError } from '@dash/contract';
  import { Button } from '@dash/ui';
  import { z } from 'zod';
  import { AdminUser, isCode, isForbidden, type AdminUserT } from '../../lib/admin-api.js';
  import { api } from '../../lib/api.js';
  import { t } from '../../lib/i18n.js';
  import { session } from '../../lib/session.svelte.js';
  import Confirm from '../Confirm.svelte';

  const admin = $derived(session.me?.role === 'admin');
  let users = $state<AdminUserT[]>([]);
  let status = $state<'loading' | 'ready' | 'denied' | 'error'>('loading');
  let error = $state('');

  async function load(): Promise<void> {
    if (!admin) return; // members never reach an admin route
    try {
      users = await api.get('/admin/users', z.array(AdminUser));
      status = 'ready';
    } catch (e) {
      status = isForbidden(e) ? 'denied' : 'error';
    }
  }
  onMount(() => void load());

  // The server's last-admin 409 carries no `details`; its message is the only marker.
  const LAST_ADMIN = /last enabled admin/i;
  function explain(e: unknown): string {
    if (isCode(e, 'conflict')) {
      if (e instanceof DashError && LAST_ADMIN.test(e.message))
        return t('users.lastAdmin', 'This is the last administrator. Make someone else an administrator first.');
      return t('settings.users.conflict', e instanceof DashError ? e.message : 'That conflicts with an existing user.');
    }
    if (isForbidden(e)) return t('admin.denied', 'You are not allowed to do this.');
    if (isCode(e, 'invalid')) return t('users.invalid', 'Some values are not valid (names must be unique, passwords 12 to 256 characters).');
    return t('users.failed', 'That did not work. Try again.');
  }

  // ---- create ----
  let cName = $state('');
  let cPassword = $state('');
  let cRole = $state<'member' | 'admin'>('member');
  async function create(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    error = '';
    try {
      const u = await api.post('/admin/users', { name: cName.trim(), password: cPassword, role: cRole }, AdminUser);
      users = [...users, u];
      cName = cPassword = '';
      cRole = 'member';
    } catch (err) {
      error = explain(err);
    }
  }

  // ---- edit ----
  let editing = $state<string | null>(null);
  let eName = $state('');
  let ePassword = $state('');
  function startEdit(u: AdminUserT): void {
    editing = u.id;
    eName = u.name;
    ePassword = '';
  }
  async function patch(id: string, body: Record<string, unknown>): Promise<boolean> {
    error = '';
    try {
      const u = await api.patch(`/admin/users/${encodeURIComponent(id)}`, body, AdminUser);
      users = users.map((x) => (x.id === id ? u : x));
      return true;
    } catch (err) {
      error = explain(err);
      return false;
    }
  }
  async function saveEdit(u: AdminUserT): Promise<void> {
    const body: Record<string, unknown> = {};
    if (eName.trim() !== u.name) body.name = eName.trim();
    if (ePassword) body.password = ePassword;
    if (Object.keys(body).length === 0 || (await patch(u.id, body))) editing = null;
  }

  // ---- delete ----
  let removing = $state<AdminUserT | null>(null);
  async function remove(): Promise<void> {
    const target = removing;
    if (!target) return;
    removing = null;
    error = '';
    try {
      await api.delete(`/admin/users/${encodeURIComponent(target.id)}`);
      users = users.filter((u) => u.id !== target.id);
    } catch (err) {
      error = explain(err);
    }
  }
</script>

{#if admin}
  <div class="st">
    {#if status === 'denied'}
      <p role="alert">{t('admin.denied', 'You are not allowed to do this.')}</p>
    {:else if status === 'error'}
      <p role="alert">{t('admin.loadFailed', 'Could not load this list.')} <Button onclick={() => void load()}>{t('pages.retry', 'Retry')}</Button></p>
    {:else if status === 'loading'}
      <p role="status">{t('settings.loading', 'Loading…')}</p>
    {:else}
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      <ul class="plain">
        {#each users as u (u.id)}
          <li class="card" data-user-id={u.id}>
            <div class="row">
              <strong>{u.name}</strong>
              {#if u.id === session.me?.id}<span class="muted">{t('users.you', '(you)')}</span>{/if}
              <span class="muted">{u.role === 'admin' ? t('users.roleAdmin', 'administrator') : t('users.roleMember', 'member')}</span>
              {#if u.disabled}<span class="err">{t('users.disabled', 'disabled')}</span>{/if}
              {#if u.totpEnabled}<span class="muted">{t('users.totp', 'two-factor on')}</span>{/if}
            </div>
            {#if editing === u.id}
              <form onsubmit={(e) => { e.preventDefault(); void saveEdit(u); }}>
                <label>{t('users.name', 'Name')}<input required bind:value={eName} /></label>
                <label>{t('users.newPassword', 'New password (leave empty to keep)')}<input type="password" autocomplete="new-password" minlength="12" maxlength="256" bind:value={ePassword} /></label>
                <div class="row">
                  <Button type="submit" variant="primary">{t('settings.save', 'Save')}</Button>
                  <Button onclick={() => (editing = null)}>{t('settings.cancel', 'Cancel')}</Button>
                </div>
              </form>
            {:else}
              <div class="row">
                <Button onclick={() => startEdit(u)}>{t('users.edit', 'Edit')}</Button>
                <Button onclick={() => void patch(u.id, { role: u.role === 'admin' ? 'member' : 'admin' })}>
                  {u.role === 'admin' ? t('users.makeMember', 'Make member') : t('users.makeAdmin', 'Make administrator')}
                </Button>
                <Button onclick={() => void patch(u.id, { disabled: !u.disabled })}>
                  {u.disabled ? t('users.enable', 'Enable') : t('users.disable', 'Disable')}
                </Button>
                {#if u.totpEnabled}
                  <Button onclick={() => void patch(u.id, { resetTotp: true })}>{t('users.resetTotp', 'Reset two-factor')}</Button>
                {/if}
                <Button variant="danger" onclick={() => (removing = u)}>{t('users.delete', 'Delete')}</Button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      <h3>{t('users.add', 'Add a user')}</h3>
      <form onsubmit={create}>
        <label>{t('users.name', 'Name')}<input required bind:value={cName} /></label>
        <label>{t('users.password', 'Password')}<input type="password" autocomplete="new-password" required minlength="12" maxlength="256" bind:value={cPassword} /></label>
        <label>{t('users.role', 'Role')}
          <select bind:value={cRole}>
            <option value="member">{t('users.roleMember', 'member')}</option>
            <option value="admin">{t('users.roleAdmin', 'administrator')}</option>
          </select>
        </label>
        <div class="row"><Button type="submit" variant="primary">{t('users.create', 'Create user')}</Button></div>
      </form>
    {/if}
  </div>
{/if}

{#if removing}
  <Confirm
    title={t('users.deleteTitle', 'Delete user')}
    message={t('users.deleteMsg', 'Delete {name}? Their pages and sessions are removed.', { name: removing.name })}
    confirmLabel={t('users.delete', 'Delete')}
    onConfirm={() => void remove()}
    onCancel={() => (removing = null)}
  />
{/if}
