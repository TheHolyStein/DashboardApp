<script lang="ts">
  import { untrack } from 'svelte';
  import { DashError, InstanceDto, type ModuleClient } from '@dash/contract';
  import { Button, Pane } from '@dash/ui';
  import { clientModules } from '../generated/modules.js';
  import { moduleApi, api } from '../lib/api.js';
  import { userFormat } from '../lib/host.js';
  import { t } from '../lib/i18n.js';
  import { settingsUi } from '../lib/ui-state.svelte.js';
  import { pages } from '../lib/pages.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { coerce, describeSchema, fillForm, getAt, hasField, issuesToErrors, secretPaths, setAt, type EditRegistry, type FieldSpec } from '../lib/schema-form.js';
  import SchemaForm from './SchemaForm.svelte';

  let { modules = clientModules }: { modules?: EditRegistry } = $props();

  type Rec = Record<string, unknown>;
  type Phase = 'loading' | 'form' | 'custom' | 'unsupported' | 'failed';

  const iid = $derived(settingsUi.instanceId);
  const instance = $derived(iid ? (pages.list.flatMap((p) => p.instances).find((i) => i.id === iid) ?? null) : null);
  // Same rule as the tile host: the page's owner owns its instances.
  const isOwner = $derived(!!iid && pages.list.some((p) => p.ownerId === session.me?.id && p.instances.some((i) => i.id === iid)));
  const entry = $derived(instance ? modules[instance.moduleId] : undefined);
  const name = $derived(entry ? t(`module.${entry.manifest.id}.name`, entry.manifest.name) : '');

  let phase = $state<Phase>('loading');
  let fields = $state.raw<FieldSpec[]>([]);
  let form = $state<Rec>({});
  let custom = $state.raw<ModuleClient['Settings'] | null>(null);
  let customValue = $state.raw<unknown>({});
  let secretsSet = $state.raw(new Set<string>());
  let errors = $state.raw<Record<string, string>>({});
  let general = $state('');
  let saving = $state(false);
  let stored: Rec = {};

  $effect(() => {
    const id = iid;
    let live = true;
    untrack(() => {
      phase = 'loading';
      errors = {};
      general = '';
      saving = false;
      custom = null;
      const inst = id ? pages.list.flatMap((p) => p.instances).find((i) => i.id === id) : undefined;
      const e = inst ? modules[inst.moduleId] : undefined;
      if (!inst || !e) return;
      stored = inst.settings && typeof inst.settings === 'object' ? structuredClone($state.snapshot(inst.settings) as Rec) : {};
      if (!e.load) {
        phase = 'failed';
        return;
      }
      e.load().then(
        ({ default: client }) => {
          if (!live) return;
          if (client.Settings) {
            custom = client.Settings;
            customValue = structuredClone(stored);
            phase = 'custom';
            return;
          }
          try {
            fields = describeSchema(e.manifest.settings as never);
          } catch (err) {
            console.error(`Settings for module "${e.manifest.id}" cannot be generated`, err);
            phase = 'unsupported';
            return;
          }
          const f = fillForm(fields, stored);
          const sp = secretPaths(fields);
          secretsSet = new Set(sp.filter((p) => typeof getAt(stored, p) === 'string' && getAt(stored, p) !== ''));
          for (const p of sp) setAt(f, p, ''); // stored secrets never reach the DOM
          form = f;
          phase = 'form';
        },
        () => {
          if (live) phase = 'failed';
        },
      );
    });
    return () => {
      live = false;
    };
  });

  // The instance vanished (removed elsewhere): close.
  $effect(() => {
    if (iid && pages.status === 'ready' && !instance) settingsUi.instanceId = null;
  });

  function close(): void {
    settingsUi.instanceId = null;
  }

  function showIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): void {
    errors = issuesToErrors(issues);
    // Issues that match no rendered field (root issues, unknown paths, anything in a custom form) go to the general line.
    const loose = Object.entries(errors).filter(([k]) => k === '' || phase === 'custom' || !hasField(fields, k));
    general = loose.map(([k, m]) => (k ? `${k}: ${m}` : m)).join(' ');
  }

  async function save(): Promise<void> {
    if (!instance || !entry || saving) return;
    errors = {};
    general = '';
    let candidate: unknown;
    if (phase === 'custom') candidate = customValue;
    else {
      const c = coerce(fields, form);
      for (const p of secretPaths(fields)) {
        const typed = getAt(c, p);
        if (typed === undefined || typed === '') {
          const old = getAt(stored, p);
          if (old !== undefined) setAt(c, p, old); // the user's own stored secret, sent back unchanged
        }
      }
      candidate = c;
    }
    const parsed = entry.manifest.settings.safeParse(candidate);
    if (!parsed.success) {
      showIssues(parsed.error.issues);
      return;
    }
    saving = true;
    const id = instance.id;
    try {
      const updated = await api.patch(`/instances/${encodeURIComponent(id)}`, { settings: parsed.data }, InstanceDto);
      pages.replaceInstance(updated);
      if (settingsUi.instanceId === id) close();
    } catch (e) {
      if (e instanceof DashError && e.code === 'invalid' && Array.isArray(e.details)) {
        showIssues(e.details as { path: PropertyKey[]; message: string }[]);
        if (Object.keys(errors).length === 0) general = t('settings.invalid', 'Some settings are invalid.');
      } else if (e instanceof DashError && e.code === 'forbidden') {
        general = t('settings.forbidden', 'You are not allowed to change this tile.');
      } else {
        general = t('settings.saveFailed', 'Could not save the settings. Try again.');
      }
    } finally {
      saving = false;
    }
  }
</script>

{#if instance && entry}
  <Pane title={t('settings.title', 'Settings: {name}', { name })} onClose={close}>
    {#if phase === 'loading'}
      <p role="status">{t('settings.loading', 'Loading…')}</p>
    {:else if phase === 'unsupported'}
      <p role="alert" data-testid="settings-unsupported">{t('settings.unsupported', 'This module’s settings cannot be edited here.')}</p>
      <div class="actions"><Button onclick={close}>{t('settings.close', 'Close')}</Button></div>
    {:else if phase === 'failed'}
      <p role="alert">{t('settings.loadFailed', 'Could not load this module’s settings.')}</p>
      <div class="actions"><Button onclick={close}>{t('settings.close', 'Close')}</Button></div>
    {:else}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {#if phase === 'custom' && custom}
          {@const Custom = custom}
          <Custom value={customValue} onChange={(v: unknown) => (customValue = v)} api={moduleApi(instance.moduleId)} {t} {isOwner} {...userFormat()} />
        {:else}
          <SchemaForm {fields} value={form} {errors} onChange={(v) => (form = v)} {t} moduleId={instance.moduleId} {secretsSet} />
        {/if}
        {#if general}<p class="error" role="alert">{general}</p>{/if}
        <div class="actions">
          <Button onclick={close}>{t('settings.cancel', 'Cancel')}</Button>
          <Button type="submit" variant="primary" data-edit disabled={saving}>{t('settings.save', 'Save')}</Button>
        </div>
      </form>
    {/if}
  </Pane>
{/if}

<style>
  .actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }
  .error { color: var(--db-fg); border-left: 3px solid var(--db-crit); padding-left: 0.5em; }
</style>
