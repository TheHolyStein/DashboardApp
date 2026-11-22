<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '@dash/ui';
  import { AppPassword, CreatedAppPassword, isCode, isWrongPassword, TotpSetup } from '../../lib/admin-api.js';
  import { api } from '../../lib/api.js';
  import { t } from '../../lib/i18n.js';
  import { savePrefs } from '../../lib/prefs.js';
  import { session } from '../../lib/session.svelte.js';
  import { z } from 'zod';
  import Confirm from '../Confirm.svelte';

  const MIN = 12;
  const MAX = 256;

  // ---- password ----
  let current = $state('');
  let next = $state('');
  let again = $state('');
  let pwError = $state('');
  let pwOk = $state(false);
  let pwBusy = $state(false);

  async function changePassword(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    pwError = '';
    pwOk = false;
    if (next.length < MIN || next.length > MAX) {
      pwError = t('account.pwLength', 'The new password must be {min} to {max} characters long.', { min: MIN, max: MAX });
      return;
    }
    if (next !== again) {
      pwError = t('account.pwMismatch', 'The new passwords do not match.');
      return;
    }
    pwBusy = true;
    try {
      await api.post('/me/password', { current, next });
      pwOk = true;
      current = next = again = '';
    } catch (err) {
      pwError = isWrongPassword(err)
        ? t('account.pwWrong', 'The current password is incorrect.')
        : isCode(err, 'rate_limited')
          ? t('account.rateLimited', 'Too many attempts. Try again later.')
          : t('account.pwFailed', 'Could not change the password. Try again.');
    } finally {
      pwBusy = false;
    }
  }

  // ---- two-factor ----
  let setup = $state<{ secret: string; otpauthUrl: string } | null>(null);
  let qr = $state<{ d: string; side: number } | null>(null);
  let qrNote = $state(false);
  let code = $state('');
  let totpMsg = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
  let totpBusy = $state(false);
  let offPassword = $state('');
  const totpOn = $derived(session.me?.totpEnabled ?? false);
  function setTotpOn(on: boolean): void {
    if (session.me) session.me = { ...session.me, totpEnabled: on };
  }

  async function startSetup(): Promise<void> {
    totpMsg = null;
    totpBusy = true;
    try {
      const s = await api.post('/me/totp/setup', undefined, TotpSetup);
      setup = s;
      qr = null;
      qrNote = false;
      try {
        // The encoder is its own chunk, loaded when two-factor setup starts.
        const { encodeQr, qrPath } = await import('../../lib/qr.js');
        qr = qrPath(encodeQr(s.otpauthUrl));
      } catch {
        qrNote = true; // too long for the compact encoder: the secret and URL below still work
      }
    } catch (err) {
      if (isCode(err, 'conflict')) setTotpOn(true);
      totpMsg = {
        kind: 'err',
        text: isCode(err, 'conflict')
          ? t('account.totpAlready', 'Two-factor sign-in is already on. Turn it off first to set it up again.')
          : t('account.totpSetupFailed', 'Could not start two-factor setup.'),
      };
    } finally {
      totpBusy = false;
    }
  }
  async function enableTotp(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    totpMsg = null;
    totpBusy = true;
    try {
      await api.post('/me/totp/enable', { code: code.trim() });
      setup = null;
      qr = null;
      code = '';
      setTotpOn(true);
      totpMsg = { kind: 'ok', text: t('account.totpOn', 'Two-factor sign-in is on.') };
    } catch (err) {
      totpMsg = {
        kind: 'err',
        text: isCode(err, 'invalid') ? t('account.totpBadCode', 'That code is not valid. Try the next one.') : t('account.totpEnableFailed', 'Could not turn on two-factor sign-in.'),
      };
    } finally {
      totpBusy = false;
    }
  }
  async function disableTotp(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    totpMsg = null;
    totpBusy = true;
    try {
      await api.post('/me/totp/disable', { password: offPassword });
      offPassword = '';
      setup = null;
      setTotpOn(false);
      totpMsg = { kind: 'ok', text: t('account.totpOff', 'Two-factor sign-in is off.') };
    } catch (err) {
      totpMsg = {
        kind: 'err',
        text: isWrongPassword(err) ? t('account.pwWrong', 'The current password is incorrect.') : t('account.totpDisableFailed', 'Could not turn off two-factor sign-in.'),
      };
    } finally {
      totpBusy = false;
    }
  }

  // ---- app passwords ----
  type AppPw = z.infer<typeof AppPassword>;
  let appPws = $state<AppPw[]>([]);
  let appLoaded = $state(false);
  let appError = $state('');
  let label = $state('');
  /** The just-created password. It exists only here, until dismissed; the list never contains it. */
  let created = $state<{ label: string; password: string } | null>(null);
  let copied = $state<'' | 'ok' | 'fail'>('');
  let removing = $state<AppPw | null>(null);
  const caldav = `${location.origin}/dav/`;

  async function loadAppPws(): Promise<void> {
    try {
      appPws = await api.get('/me/app-passwords', z.array(AppPassword));
      appLoaded = true;
    } catch {
      appError = t('account.appLoadFailed', 'Could not load your app passwords.');
    }
  }
  onMount(() => void loadAppPws());

  async function createAppPw(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    appError = '';
    try {
      const r = await api.post('/me/app-passwords', { label: label.trim() }, CreatedAppPassword);
      created = { label: r.label, password: r.password };
      copied = '';
      label = '';
      await loadAppPws();
    } catch {
      appError = t('account.appCreateFailed', 'Could not create the app password.');
    }
  }
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(created?.password ?? '');
      copied = 'ok';
    } catch {
      copied = 'fail'; // the password stays selectable in the field
    }
  }
  async function removeAppPw(): Promise<void> {
    const target = removing;
    if (!target) return;
    try {
      await api.delete(`/me/app-passwords/${encodeURIComponent(target.id)}`);
      appPws = appPws.filter((p) => p.id !== target.id);
      removing = null;
    } catch {
      removing = null;
      appError = t('account.appDeleteFailed', 'Could not delete the app password.');
    }
  }

  // ---- locale and time zone ----
  const zones = (() => {
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return list.includes('UTC') ? list : ['UTC', ...list];
  })();
  const LOCALES = ['en'];
  let locale = $state(session.me?.prefs.locale ?? 'en');
  let timeZone = $state(session.me?.prefs.timeZone ?? 'UTC');
  let prefMsg = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const localeOptions = $derived(LOCALES.includes(locale) ? LOCALES : [locale, ...LOCALES]);
  const zoneOptions = $derived(zones.includes(timeZone) ? zones : [timeZone, ...zones]);

  async function savePreferences(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    prefMsg = null;
    try {
      await savePrefs({ locale, timeZone });
      prefMsg = { kind: 'ok', text: t('account.prefsSaved', 'Saved.') };
    } catch {
      prefMsg = { kind: 'err', text: t('account.prefsFailed', 'Could not save the preferences.') };
    }
  }
</script>

<div class="st">
  <section aria-labelledby="acc-pw">
    <h3 id="acc-pw">{t('account.password', 'Change password')}</h3>
    <form onsubmit={changePassword}>
      <label>{t('account.current', 'Current password')}<input type="password" autocomplete="current-password" required bind:value={current} /></label>
      <label>{t('account.new', 'New password')}<input type="password" autocomplete="new-password" required minlength={MIN} maxlength={MAX} bind:value={next} /></label>
      <label>{t('account.newAgain', 'New password again')}<input type="password" autocomplete="new-password" required bind:value={again} /></label>
      <p class="muted">{t('account.pwHelp', '{min} to {max} characters. Changing it signs you out on all other devices.', { min: MIN, max: MAX })}</p>
      {#if pwError}<p class="err" role="alert">{pwError}</p>{/if}
      {#if pwOk}<p class="ok" role="status">{t('account.pwChanged', 'Password changed. Your other sessions were signed out.')}</p>{/if}
      <div class="row"><Button type="submit" variant="primary" disabled={pwBusy}>{t('account.pwSubmit', 'Change password')}</Button></div>
    </form>
  </section>

  <section aria-labelledby="acc-2fa">
    <h3 id="acc-2fa">{t('account.totp', 'Two-factor sign-in')}</h3>
    {#if totpMsg}<p class={totpMsg.kind} role={totpMsg.kind === 'err' ? 'alert' : 'status'}>{totpMsg.text}</p>{/if}
    {#if setup}
      <div class="stack">
        <p>{t('account.totpScan', 'Scan the code with your authenticator app, or enter the secret by hand.')}</p>
        {#if qr}
          <svg viewBox="0 0 {qr.side} {qr.side}" width="200" height="200" role="img" aria-label={t('account.qrLabel', 'QR code for two-factor setup')} shape-rendering="crispEdges">
            <rect width={qr.side} height={qr.side} fill="#fff" />
            <path d={qr.d} fill="#000" />
          </svg>
        {:else if qrNote}
          <p class="muted">{t('account.qrTooLong', 'The QR code could not be drawn. Use the secret or the address below.')}</p>
        {/if}
        <p>{t('account.secret', 'Secret')}: <code data-testid="totp-secret">{setup.secret}</code></p>
        <p>{t('account.otpUrl', 'Setup address')}: <code data-testid="totp-url">{setup.otpauthUrl}</code></p>
        <form onsubmit={enableTotp}>
          <label>{t('account.code', 'Code from the app')}<input inputmode="numeric" autocomplete="one-time-code" required bind:value={code} /></label>
          <div class="row">
            <Button type="submit" variant="primary" disabled={totpBusy}>{t('account.totpEnable', 'Turn on')}</Button>
            <Button onclick={() => { setup = null; qr = null; }}>{t('settings.cancel', 'Cancel')}</Button>
          </div>
        </form>
      </div>
    {:else if totpOn}
      <form onsubmit={disableTotp}>
        <label>{t('account.totpOffPassword', 'Password (to turn it off)')}<input type="password" autocomplete="current-password" required bind:value={offPassword} /></label>
        <div class="row"><Button type="submit" busy={totpBusy}>{t('account.totpDisable', 'Turn off')}</Button></div>
      </form>
    {:else}
      <div class="row"><Button onclick={() => void startSetup()} busy={totpBusy}>{t('account.totpSetup', 'Set up two-factor sign-in')}</Button></div>
    {/if}
  </section>

  <section aria-labelledby="acc-app">
    <h3 id="acc-app">{t('account.apps', 'App passwords')}</h3>
    <p class="muted">{t('account.appsHelp', 'For calendar apps (CalDAV). Server address:')} <code>{caldav}</code></p>
    {#if appError}<p class="err" role="alert">{appError}</p>{/if}
    {#if created}
      <div class="card" role="status" data-testid="app-pw-created">
        <p><strong>{created.label}</strong>: {t('account.appOnce', 'Copy this password now. It is shown only once.')}</p>
        <input readonly value={created.password} aria-label={t('account.appPassword', 'App password')} onfocus={(e) => e.currentTarget.select()} />
        <div class="row">
          <Button onclick={() => void copy()}>{t('account.copy', 'Copy')}</Button>
          <Button variant="primary" onclick={() => (created = null)}>{t('account.appDone', 'Done')}</Button>
          {#if copied === 'ok'}<span class="ok" role="status">{t('account.copied', 'Copied.')}</span>{/if}
          {#if copied === 'fail'}<span class="muted" role="status">{t('account.copyFailed', 'Copy failed. Select the password and copy it by hand.')}</span>{/if}
        </div>
      </div>
    {/if}
    {#if appLoaded && appPws.length === 0}<p class="muted">{t('account.appsNone', 'No app passwords yet.')}</p>{/if}
    <ul class="plain">
      {#each appPws as p (p.id)}
        <li class="card">
          <span><strong>{p.label}</strong> <span class="muted">{p.lastUsedAt ? t('account.lastUsed', 'last used {when}', { when: p.lastUsedAt }) : t('account.neverUsed', 'never used')}</span></span>
          <div class="row"><Button variant="danger" onclick={() => (removing = p)}>{t('account.appDelete', 'Delete')}</Button></div>
        </li>
      {/each}
    </ul>
    <form onsubmit={createAppPw}>
      <label>{t('account.appLabel', 'Label')}<input required maxlength="60" bind:value={label} /></label>
      <div class="row"><Button type="submit" variant="primary">{t('account.appCreate', 'Create app password')}</Button></div>
    </form>
  </section>

  <section aria-labelledby="acc-prefs">
    <h3 id="acc-prefs">{t('account.prefs', 'Language and time zone')}</h3>
    <form onsubmit={savePreferences}>
      <label>{t('account.locale', 'Language')}
        <select bind:value={locale}>{#each localeOptions as l (l)}<option value={l}>{l}</option>{/each}</select>
      </label>
      <label>{t('account.timeZone', 'Time zone')}
        <select bind:value={timeZone}>{#each zoneOptions as z (z)}<option value={z}>{z}</option>{/each}</select>
      </label>
      {#if prefMsg}<p class={prefMsg.kind} role={prefMsg.kind === 'err' ? 'alert' : 'status'}>{prefMsg.text}</p>{/if}
      <div class="row"><Button type="submit" variant="primary">{t('settings.save', 'Save')}</Button></div>
    </form>
  </section>
</div>

{#if removing}
  <Confirm
    title={t('account.appDeleteTitle', 'Delete app password')}
    message={t('account.appDeleteMsg', 'Delete “{label}”? Apps using it will stop working.', { label: removing.label })}
    confirmLabel={t('account.appDelete', 'Delete')}
    onConfirm={() => void removeAppPw()}
    onCancel={() => (removing = null)}
  />
{/if}
