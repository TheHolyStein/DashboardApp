<script lang="ts">
  // Picks an icon: one of the theme's icons (by key) or a single emoji. Emits `null` for "no icon".
  import type { Translate } from '@dash/contract';
  import { Icon } from '@dash/ui';
  import { isIconKey } from './model.js';

  type Props = { value: string | null; t: Translate; onchange: (v: string | null) => void };
  let { value, t, onchange }: Props = $props();

  const KEYS = ['todo', 'note', 'calendar', 'clock', 'bell', 'user', 'warn', 'ok', 'link', 'timer', 'habit', 'weather'];
  const EMOJI = ['🛒', '🥛', '🧹', '🗑️', '📞', '✉️', '💊', '🔧', '🎁', '🐕'];

  let custom = $state('');
  const segments = (s: string): string[] => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);

  function pickCustom(): void {
    const g = segments(custom.trim());
    if (g.length === 1 && /\p{Extended_Pictographic}/u.test(g[0] ?? '')) {
      onchange(g[0] ?? null);
      custom = '';
    }
  }
</script>

<fieldset class="picker">
  <legend>{t('m.todo.icon', 'Icon')}</legend>
  <div class="grid" role="group">
    <button type="button" data-edit class="cell" aria-pressed={value === null} aria-label={t('m.todo.noIcon', 'No icon')} onclick={() => onchange(null)}>
      <span aria-hidden="true">∅</span>
    </button>
    {#each KEYS as key (key)}
      <button type="button" data-edit class="cell" aria-pressed={value === key} aria-label={key} onclick={() => onchange(key)}>
        <Icon name={key} size={18} />
      </button>
    {/each}
    {#each EMOJI as emoji (emoji)}
      <button type="button" data-edit class="cell" aria-pressed={value === emoji} aria-label={emoji} onclick={() => onchange(emoji)}>
        <span aria-hidden="true">{emoji}</span>
      </button>
    {/each}
  </div>
  <label class="custom">
    <span>{t('m.todo.emoji', 'Other emoji')}</span>
    <input data-edit bind:value={custom} maxlength="8" oninput={pickCustom} />
  </label>
  {#if value && !isIconKey(value) && !EMOJI.includes(value)}
    <p class="current"><span aria-hidden="true">{value}</span></p>
  {/if}
</fieldset>

<style>
  .picker { border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); padding: 0.5rem; margin: 0 0 var(--db-gap, 8px); }
  .grid { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .cell { min-width: 2.25rem; min-height: 2.25rem; font: inherit; color: var(--db-fg); background: transparent; border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); cursor: pointer; }
  .cell[aria-pressed='true'] { border: 2px solid var(--db-accent); }
  .cell:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
  .custom { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; }
  .custom input { width: 4rem; font: inherit; padding: 0.25rem 0.5rem; }
  .current { margin: 0.25rem 0 0; }
</style>
