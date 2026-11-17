<script lang="ts">
  import type { Component } from 'svelte';
  import { Pane } from '@dash/ui';
  import { t } from '../lib/i18n.js';
  import { session } from '../lib/session.svelte.js';
  import { settingsArea, type SettingsSection } from '../lib/ui-state.svelte.js';
  import './settings/settings.css';

  const ADMIN: readonly SettingsSection[] = ['users', 'grants', 'modules'];
  // Each section is its own chunk, fetched on first open.
  const LOADERS: Record<SettingsSection, () => Promise<{ default: Component }>> = {
    account: () => import('./settings/Account.svelte'),
    appearance: () => import('./settings/Appearance.svelte'),
    pages: () => import('./settings/PageManager.svelte'),
    users: () => import('./settings/Users.svelte'),
    grants: () => import('./settings/Grants.svelte'),
    modules: () => import('./settings/Modules.svelte'),
    about: () => import('./settings/About.svelte'),
  };
  const NAMES: Record<SettingsSection, () => string> = {
    account: () => t('settings.account', 'Account'),
    appearance: () => t('settings.appearance', 'Appearance'),
    pages: () => t('settings.pages', 'Pages'),
    users: () => t('settings.users', 'Users'),
    grants: () => t('settings.grants', 'Permissions'),
    modules: () => t('settings.modules', 'Modules'),
    about: () => t('settings.about', 'About'),
  };

  const isAdmin = $derived(session.me?.role === 'admin');
  const sections = $derived((Object.keys(LOADERS) as SettingsSection[]).filter((s) => isAdmin || !ADMIN.includes(s)));
  // A member who opens an admin URL lands on the account section; admin code is never loaded for them.
  const active = $derived.by<SettingsSection>(() => {
    const s = settingsArea.section;
    return s && sections.includes(s) ? s : 'account';
  });

  let Section = $state.raw<Component | null>(null);
  let loadError = $state(false);
  $effect(() => {
    const s = active;
    let live = true;
    Section = null;
    loadError = false;
    LOADERS[s]().then(
      (m) => {
        if (live) Section = m.default;
      },
      () => {
        if (live) loadError = true;
      },
    );
    return () => {
      live = false;
    };
  });
</script>

{#if settingsArea.open}
  <Pane title={t('settings.areaTitle', 'Settings')} onClose={() => settingsArea.close()}>
    <div class="area">
      <nav aria-label={t('settings.sections', 'Settings sections')}>
        {#each sections as s (s)}
          <button type="button" aria-current={s === active ? 'page' : undefined} onclick={() => settingsArea.show(s)}>{NAMES[s]()}</button>
        {/each}
      </nav>
      <section class="content">
        <h2>{NAMES[active]()}</h2>
        {#if loadError}
          <p role="alert">{t('settings.sectionFailed', 'Could not load this section. Reload and try again.')}</p>
        {:else if Section}
          {#key active}<Section />{/key}
        {:else}
          <p role="status">{t('settings.loading', 'Loading…')}</p>
        {/if}
      </section>
    </div>
  </Pane>
{/if}

<style>
  .area { display: grid; grid-template-columns: 11rem 1fr; gap: 1rem; }
  nav { display: grid; align-content: start; gap: 0.25rem; }
  nav button {
    font: inherit; padding: 0.45rem 0.7rem; text-align: left; cursor: pointer; color: var(--db-fg, #15181d); background: transparent;
    border: 1px solid transparent; border-radius: var(--db-radius, 8px);
  }
  nav button[aria-current='page'] { background: var(--db-surface-2, #eef0f4); border-color: var(--db-accent, #1f5fd1); font-weight: 600; }
  .content { min-width: 0; }
  h2 { margin: 0 0 0.75rem; font-size: 1.15rem; }
  @media (max-width: 700px) {
    .area { grid-template-columns: 1fr; }
    nav { display: flex; overflow-x: auto; }
    nav button { white-space: nowrap; }
  }
</style>
