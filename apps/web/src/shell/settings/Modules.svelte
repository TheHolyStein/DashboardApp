<script lang="ts">
  import { onMount } from 'svelte';
  import { DashError, type ModuleManifest } from '@dash/contract';
  import { Button } from '@dash/ui';
  import { z } from 'zod';
  import { clientModules } from '../../generated/modules.js';
  import { AdminModule, isForbidden, type AdminModuleT } from '../../lib/admin-api.js';
  import { api } from '../../lib/api.js';
  import { t } from '../../lib/i18n.js';
  import {
    coerce,
    describeSchema,
    fillForm,
    getAt,
    issuesToErrors,
    secretPaths,
    setAt,
    type FieldSpec,
  } from '../../lib/schema-form.js';
  import { session } from '../../lib/session.svelte.js';
  import SchemaForm from '../SchemaForm.svelte';

  type Rec = Record<string, unknown>;
  let { modules = clientModules }: { modules?: Record<string, { manifest: Pick<ModuleManifest, 'config'> }> } = $props();

  const admin = $derived(session.me?.role === 'admin');
  let list = $state<AdminModuleT[]>([]);
  let status = $state<'loading' | 'ready' | 'denied' | 'error'>('loading');
  let error = $state('');

  async function load(): Promise<void> {
    if (!admin) return; // members never reach an admin route
    try {
      list = await api.get('/admin/modules', z.array(AdminModule));
      status = 'ready';
    } catch (e) {
      status = isForbidden(e) ? 'denied' : 'error';
    }
  }
  onMount(() => void load());

  async function toggle(m: AdminModuleT): Promise<void> {
    error = '';
    const enabled = !m.enabled;
    try {
      await api.put(`/admin/modules/${encodeURIComponent(m.id)}/enabled`, { enabled });
      list = list.map((x) => (x.id === m.id ? { ...x, enabled } : x));
    } catch (e) {
      error = isForbidden(e) ? t('admin.denied', 'You are not allowed to do this.') : t('modules.toggleFailed', 'Could not change the module.');
    }
  }

  // ---- module-wide configuration (generated form from manifest.config) ----
  let configFor = $state<string | null>(null);
  let fields = $state.raw<FieldSpec[]>([]);
  let form = $state<Rec>({});
  let stored: Rec = {};
  let secretsSet = $state.raw(new Set<string>());
  let errors = $state.raw<Record<string, string>>({});
  let general = $state('');
  let saving = $state(false);
  let cfgLoading = $state(false);

  const hasForm = (m: AdminModuleT): boolean => m.hasConfig && !m.failed && Object.hasOwn(modules, m.id);

  async function openConfig(m: AdminModuleT): Promise<void> {
    if (configFor === m.id) {
      configFor = null;
      return;
    }
    general = '';
    errors = {};
    cfgLoading = true;
    configFor = m.id;
    try {
      fields = describeSchema(modules[m.id]!.manifest.config as never);
      const raw = await api.get<unknown>(`/admin/modules/${encodeURIComponent(m.id)}/config`);
      stored = raw && typeof raw === 'object' ? structuredClone(raw as Rec) : {};
      const f = fillForm(fields, stored);
      const sp = secretPaths(fields);
      secretsSet = new Set(sp.filter((p) => typeof getAt(stored, p) === 'string' && getAt(stored, p) !== ''));
      for (const p of sp) setAt(f, p, ''); // stored secrets never reach the DOM
      form = f;
    } catch (e) {
      configFor = null;
      error = isForbidden(e) ? t('admin.denied', 'You are not allowed to do this.') : t('modules.configFailed', 'Could not load the configuration.');
    } finally {
      cfgLoading = false;
    }
  }

  async function saveConfig(m: AdminModuleT): Promise<void> {
    if (saving) return;
    errors = {};
    general = '';
    const c = coerce(fields, form);
    for (const p of secretPaths(fields)) {
      const typed = getAt(c, p);
      if (typed === undefined || typed === '') {
        const old = getAt(stored, p);
        if (old !== undefined) setAt(c, p, old); // keep the stored secret
      }
    }
    const parsed = modules[m.id]!.manifest.config.safeParse(c);
    if (!parsed.success) {
      errors = issuesToErrors(parsed.error.issues);
      general = t('modules.invalid', 'Some values are not valid.');
      return;
    }
    saving = true;
    try {
      await api.put(`/admin/modules/${encodeURIComponent(m.id)}/config`, parsed.data);
      configFor = null;
    } catch (e) {
      general =
        e instanceof DashError && e.code === 'invalid'
          ? t('modules.invalid', 'Some values are not valid.')
          : isForbidden(e)
            ? t('admin.denied', 'You are not allowed to do this.')
            : t('modules.saveFailed', 'Could not save the configuration.');
    } finally {
      saving = false;
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
      {#if list.length === 0}<p class="muted">{t('grants.noModules', 'No modules installed.')}</p>{/if}
      <ul class="plain">
        {#each list as m (m.id)}
          <li class="card" data-module-id={m.id}>
            <div class="row">
              <strong>{t(`module.${m.id}.name`, m.name)}</strong>
              <span class="muted">{m.version}</span>
              {#if m.failed}<span class="err">{t('modules.failed', 'failed to load')}</span>{/if}
            </div>
            {#if m.description}<p class="muted">{m.description}</p>{/if}
            <div class="row">
              <label class="row">
                <input type="checkbox" role="switch" checked={m.enabled} disabled={m.failed} onchange={() => void toggle(m)} />
                {t('modules.enabled', 'Enabled')}
              </label>
              {#if hasForm(m)}
                <Button aria-expanded={configFor === m.id} onclick={() => void openConfig(m)}>{t('modules.configure', 'Configure')}</Button>
              {/if}
            </div>
            {#if configFor === m.id}
              {#if cfgLoading}
                <p role="status">{t('settings.loading', 'Loading…')}</p>
              {:else}
                <form onsubmit={(e) => { e.preventDefault(); void saveConfig(m); }}>
                  <SchemaForm {fields} value={form} {errors} onChange={(v) => (form = v)} {t} moduleId={m.id} {secretsSet} />
                  {#if general}<p class="err" role="alert">{general}</p>{/if}
                  <div class="row">
                    <Button onclick={() => (configFor = null)}>{t('settings.cancel', 'Cancel')}</Button>
                    <Button type="submit" variant="primary" disabled={saving}>{t('settings.save', 'Save')}</Button>
                  </div>
                </form>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
