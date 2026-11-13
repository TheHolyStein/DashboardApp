<script lang="ts">
  import { DashError } from '@dash/contract';
  import { session } from '../lib/session.svelte.js';
  import { t } from '../lib/i18n.js';

  let { failed = false }: { failed?: boolean } = $props();

  let name = $state('');
  let password = $state('');
  let totp = $state('');
  let needTotp = $state(false);
  let busy = $state(false);
  let error = $state('');

  const generic = () => t('login.error', 'Something went wrong. Please try again.');

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = '';
    try {
      await session.login(name, password, needTotp ? totp : undefined);
    } catch (err) {
      password = '';
      if (err instanceof DashError) {
        const d = err.details as { totpRequired?: boolean; retryAfterSec?: number } | undefined;
        if (err.code === 'invalid' && d?.totpRequired === true) {
          needTotp = true;
        } else if (err.code === 'rate_limited') {
          const n = Math.max(1, Math.ceil((d?.retryAfterSec ?? 60) / 60));
          error = t('login.rateLimited', 'Too many attempts, try again in {n} minutes', { n });
        } else if (err.code === 'unauthenticated') {
          error = t('login.failed', 'Sign-in failed. Check your name and password.');
        } else {
          error = generic();
        }
      } else {
        error = generic();
      }
    } finally {
      busy = false;
    }
  }
</script>

<main class="login">
  <form onsubmit={submit}>
    <h1>{t('login.title', 'Sign in')}</h1>
    <label>
      {t('login.name', 'Name')}
      <input name="name" type="text" autocomplete="username" required bind:value={name} />
    </label>
    <label>
      {t('login.password', 'Password')}
      <input name="password" type="password" autocomplete="current-password" required bind:value={password} />
    </label>
    {#if needTotp}
      <label>
        {t('login.totp', 'Authentication code')}
        <input name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" required bind:value={totp} />
      </label>
    {/if}
    <div role="alert" class="error">{error || (failed ? generic() : '')}</div>
    <button type="submit" disabled={busy}>{t('login.submit', 'Sign in')}</button>
  </form>
</main>

<style>
  .login { min-height: 100vh; display: grid; place-items: center; padding: 1rem; }
  form {
    width: min(22rem, 100%); display: grid; gap: 1rem; padding: 1.5rem;
    background: var(--db-surface, #fff); border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px);
  }
  h1 { margin: 0; font-size: 1.4rem; }
  label { display: grid; gap: 0.25rem; }
  input, button {
    font: inherit; padding: 0.55rem 0.7rem; color: var(--db-fg, #15181d); background: var(--db-bg, #f6f7f9);
    border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px);
  }
  button { background: var(--db-accent, #1f5fd1); color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: progress; }
  .error { color: var(--db-crit, #b3261e); min-height: 1.4em; }
</style>
