<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { t } from '../lib/i18n.js';
  import { nextMode, savePrefs, type ModePolicy } from '../lib/prefs.js';
  import { session } from '../lib/session.svelte.js';
  import { settingsArea } from '../lib/ui-state.svelte.js';
  import { theme, type ThemeEngine } from '../theme/engine.svelte.js';
  import EditBar from './EditBar.svelte';
  import Notifications from './Notifications.svelte';

  let {
    children,
    engine = theme,
  }: { children?: Snippet; engine?: Pick<ThemeEngine, 'setPolicy'> } = $props();

  const title = $derived(t('app.title', 'Dashboard'));
  $effect(() => {
    document.title = title;
  });

  const policy = $derived(session.me?.prefs.modePolicy ?? 'system');
  const LABEL: Record<ModePolicy, () => string> = {
    day: () => t('mode.day', 'Day'),
    night: () => t('mode.night', 'Night'),
    system: () => t('mode.system', 'System'),
    sun: () => t('mode.sun', 'Sun'),
  };
  const GLYPH: Record<ModePolicy, string> = { day: '☀', night: '☾', system: '◐', sun: '🌅' };
  let modeError = $state(false);

  async function cycle(): Promise<void> {
    const before = policy;
    const next = nextMode(before);
    modeError = false;
    engine.setPolicy(next); // instant; the saved preference confirms it
    try {
      await savePrefs({ modePolicy: next });
    } catch {
      engine.setPolicy(before);
      modeError = true;
    }
  }

  let menuOpen = $state(false);
  let menuButton = $state<HTMLButtonElement | null>(null);
  let menuRoot = $state<HTMLElement | null>(null);

  function closeMenu(returnFocus = false): void {
    menuOpen = false;
    if (returnFocus) void tick().then(() => menuButton?.focus());
  }
  function onMenuKey(e: KeyboardEvent): void {
    if (menuOpen && e.key === 'Escape') {
      e.stopPropagation();
      closeMenu(true);
    }
  }
  function onDocClick(e: MouseEvent): void {
    if (menuOpen && menuRoot && e.target instanceof Node && !menuRoot.contains(e.target)) closeMenu();
  }
  function openSettings(): void {
    closeMenu();
    settingsArea.show('account');
  }
  function signOut(): void {
    closeMenu();
    void session.logout();
  }
</script>

<svelte:document onclick={onDocClick} />

<header class="top">
  <h1 class="title">{title}</h1>
  <div class="tabs">{@render children?.()}</div>
  <div class="actions">
    <EditBar />
    <button
      type="button"
      class="icon"
      aria-label={t('topbar.mode', 'Colour mode: {mode}. Switch to {next}', { mode: LABEL[policy](), next: LABEL[nextMode(policy)]() })}
      onclick={() => void cycle()}
    >
      <span aria-hidden="true">{GLYPH[policy]}</span>
    </button>
    {#if modeError}<span role="alert" class="err">{t('topbar.modeFailed', 'Could not save the colour mode.')}</span>{/if}
    <Notifications />
    <div class="user" bind:this={menuRoot} onkeydown={onMenuKey} role="presentation">
      <button
        bind:this={menuButton}
        type="button"
        class="icon"
        aria-expanded={menuOpen}
        aria-controls="user-menu"
        aria-haspopup="true"
        aria-label={t('topbar.user', 'Account menu for {name}', { name: session.me?.name ?? '' })}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <span aria-hidden="true">👤</span><span class="name">{session.me?.name}</span>
      </button>
      {#if menuOpen}
        <ul id="user-menu" class="menu">
          <li class="who">{session.me?.name}</li>
          <li><button type="button" onclick={openSettings}>{t('topbar.settings', 'Settings')}</button></li>
          <li><button type="button" onclick={signOut}>{t('shell.signOut', 'Sign out')}</button></li>
        </ul>
      {/if}
    </div>
  </div>
</header>

<style>
  .top { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.5rem var(--db-gap, 8px); }
  .title { margin: 0; font-size: 1.15rem; }
  .tabs { flex: 1 1 auto; min-width: 0; }
  .actions { display: flex; align-items: center; gap: 0.5rem; margin-left: auto; }
  .icon, .menu button {
    font: inherit; color: var(--db-fg, #15181d); background: transparent; cursor: pointer; padding: 0.4rem 0.6rem;
    border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px);
  }
  .name { margin-left: 0.4rem; }
  .err { color: var(--db-fg); font-size: 0.85em; border-left: 3px solid var(--db-crit); padding-left: 0.5em; }
  .user { position: relative; }
  .menu {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; min-width: 11rem; margin: 0; padding: 0.25rem; list-style: none;
    background: var(--db-surface, #fff); border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2);
  }
  .menu button { width: 100%; text-align: left; border: 0; }
  .who { padding: 0.4rem 0.6rem; font-weight: 600; color: var(--db-muted, #4a5260); }
  @media (max-width: 700px) {
    .tabs { order: 3; flex: 1 1 100%; overflow-x: auto; }
    .name { display: none; }
  }
</style>
