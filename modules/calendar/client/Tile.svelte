<script lang="ts">
  import type { TileProps } from '@dash/contract';

  // The shell opens the detail view when the tile frame (or its title) is activated; no open button needed.
  // Set `detail: false` in client/index.ts for a tile without a detail view.
  let { data, updatedAt, stale, level, isOwner, t, locale, timeZone }: TileProps<{ value: number; label: string }> = $props();

  // Format with the user's saved locale and time zone from props; never the browser's or the server's default.
  const number = $derived(new Intl.NumberFormat(locale));
  const time = $derived(
    updatedAt ? new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(new Date(updatedAt)) : '',
  );
</script>

<section class:stale>
  <h3>{t('m.calendar.title', 'Calendar')}</h3>
  {#if data}
    <p>{data.label}</p>
    <!-- Formatted numbers, times and dates are data, not words: mark them with data-value instead of wrapping in t(). -->
    <p><span data-value>{number.format(data.value)}</span></p>
    {#if time}<p><span data-value>{time}</span></p>{/if}
  {:else}
    <p>{t('m.calendar.loading', 'Loading')}</p>
  {/if}
  <!-- The frame already shows a stale badge; do not re-implement it. Just do not invent progress from stale data. -->
  <!-- User-written text (names, titles, notes) is exempt from t(): wrap it, e.g. <span data-user>{item.title}</span>. -->
  {#if level === 'edit' && isOwner}
    <button type="button" data-edit>{t('m.calendar.edit', 'Edit')}</button>
  {/if}
</section>
