<script lang="ts">
  import type { Translate } from '@dash/contract';
  import { ICON_KEYS } from '@dash/contract';
  import { Button, Field } from '@dash/ui';
  import { emptyValue, humanize, type FieldSpec, type FormChange, type Setter } from '../lib/schema-form.js';

  type Rec = Record<string, unknown>;

  let {
    fields,
    value,
    errors,
    onChange,
    t,
    moduleId,
    secretsSet = new Set<string>(),
  }: {
    fields: FieldSpec[];
    value: Rec;
    errors: Record<string, string>;
    onChange: FormChange;
    t: Translate;
    moduleId: string;
    /** Dotted paths of secret fields that already have a stored value (shown empty with a placeholder). */
    secretsSet?: Set<string>;
  } = $props();

  const zones: string[] = (() => {
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return list.includes('UTC') ? list : ['UTC', ...list];
  })();

  /** Translation key path without list indices. */
  const tpath = (path: string): string => path.replace(/\.\d+(?=\.|$)/g, '');
  const tk = (path: string, suffix = ''): string => `settings.${moduleId}.${tpath(path)}${suffix}`;
  const asRec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
  const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

  function addItem(spec: Extract<FieldSpec, { kind: 'list' }>, list: unknown[], set: Setter): void {
    const item = spec.of.kind === 'group' ? emptyValue(spec.of.fields) : spec.of.kind === 'boolean' ? false : '';
    set([...list, item]);
  }
  function removeItem(list: unknown[], i: number, set: Setter): void {
    set(list.filter((_, j) => j !== i));
  }
  function move(list: unknown[], i: number, d: number, set: Setter): void {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j] as unknown, next[i] as unknown];
    set(next);
  }
</script>

{#snippet control(spec: FieldSpec, path: string, val: unknown, set: Setter, label: string, help: string | undefined)}
  {#if spec.kind === 'list'}
    {@const list = Array.isArray(val) ? val : []}
    <fieldset class="box" data-field={path}>
      <legend>{label}</legend>
      {#if help}<p class="help">{help}</p>{/if}
      {#each list as item, i (i)}
        <div class="item" data-item={`${path}.${i}`}>
          {@render control(
            spec.of,
            `${path}.${i}`,
            item,
            (v) => set(list.map((x, j) => (j === i ? v : x))),
            t('settings.item', 'Item {n}', { n: i + 1 }),
            undefined,
          )}
          <div class="row">
            <Button data-edit aria-label={t('settings.moveUp', 'Move up')} disabled={i === 0} onclick={() => move(list, i, -1, set)}>↑</Button>
            <Button data-edit aria-label={t('settings.moveDown', 'Move down')} disabled={i === list.length - 1} onclick={() => move(list, i, 1, set)}>↓</Button>
            <Button data-edit aria-label={t('settings.remove', 'Remove')} onclick={() => removeItem(list, i, set)}>✕</Button>
          </div>
        </div>
      {/each}
      <Button data-edit onclick={() => addItem(spec, list, set)}>{t('settings.add', 'Add')}</Button>
      {#if errors[path]}<p class="error" role="alert">{errors[path]}</p>{/if}
    </fieldset>
  {:else if spec.kind === 'group'}
    {@const rec = asRec(val)}
    <fieldset class="box" data-field={path}>
      <legend>{label}</legend>
      {#if help}<p class="help">{help}</p>{/if}
      {#each spec.fields as sub (sub.key)}
        {@render control(
          sub,
          `${path}.${sub.key}`,
          rec[sub.key],
          (v) => set({ ...rec, [sub.key]: v }),
          t(tk(`${path}.${sub.key}`), sub.label),
          sub.help === undefined ? undefined : t(tk(`${path}.${sub.key}`, '.help'), sub.help),
        )}
      {/each}
      {#if errors[path]}<p class="error" role="alert">{errors[path]}</p>{/if}
    </fieldset>
  {:else}
    <Field {label} {...help === undefined ? {} : { help }} {...errors[path] === undefined ? {} : { error: errors[path] }}>
      {#snippet children({ describedBy, invalid })}
        {#if spec.kind === 'boolean'}
          <input type="checkbox" data-edit checked={val === true} aria-describedby={describedBy} aria-invalid={invalid} onchange={(e) => set(e.currentTarget.checked)} />
        {:else if spec.kind === 'number'}
          <input
            type="number" data-edit inputmode="decimal" value={str(val)} min={spec.min} max={spec.max} step={spec.step ?? 'any'}
            aria-describedby={describedBy} aria-invalid={invalid} oninput={(e) => set(e.currentTarget.value)}
          />
        {:else if spec.kind === 'enum'}
          <select data-edit value={str(val)} aria-describedby={describedBy} aria-invalid={invalid} onchange={(e) => set(e.currentTarget.value)}>
            {#if !spec.required}<option value="">—</option>{/if}
            {#each spec.options as o (o)}
              <option value={o} selected={str(val) === o}>{t(tk(path, `.${o}`), humanize(o))}</option>
            {/each}
          </select>
        {:else if spec.widget === 'textarea'}
          <textarea data-edit rows="4" value={str(val)} aria-describedby={describedBy} aria-invalid={invalid} oninput={(e) => set(e.currentTarget.value)}></textarea>
        {:else if spec.widget === 'timezone' || spec.widget === 'icon'}
          {@const opts = spec.widget === 'icon' ? [...ICON_KEYS] : zones}
          <select data-edit value={str(val)} aria-describedby={describedBy} aria-invalid={invalid} onchange={(e) => set(e.currentTarget.value)}>
            {#if !spec.required}<option value="">—</option>{/if}
            {#each opts as o (o)}<option value={o} selected={str(val) === o}>{o}</option>{/each}
          </select>
        {:else if spec.widget === 'secret'}
          <input
            type="password" data-edit autocomplete="off" value={str(val)}
            placeholder={secretsSet.has(path) ? t('settings.secretSet', 'Saved — leave empty to keep') : undefined}
            aria-describedby={describedBy} aria-invalid={invalid} oninput={(e) => set(e.currentTarget.value)}
          />
        {:else}
          <input
            type={spec.widget === 'url' ? 'url' : spec.widget === 'color' ? 'color' : 'text'} data-edit value={str(val)}
            aria-describedby={describedBy} aria-invalid={invalid} oninput={(e) => set(e.currentTarget.value)}
          />
        {/if}
      {/snippet}
    </Field>
  {/if}
{/snippet}

<div class="form">
  {#each fields as spec (spec.key)}
    {@render control(
      spec,
      spec.key,
      value[spec.key],
      (v) => onChange({ ...value, [spec.key]: v }),
      t(tk(spec.key), spec.label),
      spec.help === undefined ? undefined : t(tk(spec.key, '.help'), spec.help),
    )}
  {/each}
</div>

<style>
  .form { display: grid; gap: var(--db-gap, 8px); }
  .box { margin: 0 0 var(--db-gap, 8px); padding: 0.5rem 0.75rem; border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); }
  legend { padding: 0 0.25rem; font-weight: 600; color: var(--db-fg, #15181d); }
  .item { display: grid; gap: 0.25rem; margin-bottom: var(--db-gap, 8px); padding-bottom: var(--db-gap, 8px); border-bottom: var(--db-border, 1px solid #c9ced6); }
  .row { display: flex; gap: 0.25rem; }
  .help { margin: 0 0 0.25rem; font-size: 0.85em; color: var(--db-muted, #4a5260); }
  .error { margin: 0.25rem 0 0; font-size: 0.85em; color: var(--db-danger, #b42318); }
  input, select, textarea {
    font: inherit; padding: 0.4rem 0.5rem; color: var(--db-fg, #15181d); background: var(--db-surface, #fff);
    border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px);
  }
  input[type='checkbox'] { justify-self: start; width: 1.25rem; height: 1.25rem; }
</style>
