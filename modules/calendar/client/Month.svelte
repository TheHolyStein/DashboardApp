<script lang="ts">
  // Six-row month grid starting on the configured week start. A day number opens the day view.
  import type { Translate } from '@dash/contract';
  import { byStart, monthGrid, touches, weekdayNames, type OccLike } from './format.js';

  let {
    month,
    weekStart,
    events,
    today,
    timeZone,
    locale,
    t,
    onday,
    onselect,
  }: {
    month: string;
    weekStart: 'mon' | 'sun';
    events: OccLike[];
    today: string;
    timeZone: string;
    locale: string;
    t: Translate;
    onday: (date: string) => void;
    onselect: (o: OccLike) => void;
  } = $props();

  const days = $derived(monthGrid(month, weekStart));
  const names = $derived(weekdayNames(locale, weekStart));
  const sorted = $derived([...events].sort(byStart));
  const MAX = 3;
</script>

<div class="month" role="grid" aria-label={t('m.calendar.view.month', 'Month')} data-testid="month">
  <div class="row head" role="row">
    {#each names as n, i (i)}<div role="columnheader" class="name"><span data-value>{n}</span></div>{/each}
  </div>
  {#each [0, 1, 2, 3, 4, 5] as r (r)}
    <div class="row" role="row">
      {#each days.slice(r * 7, r * 7 + 7) as d (d)}
        {@const list = sorted.filter((o) => touches(o, d, timeZone))}
        <div role="gridcell" class="cell" class:other={!d.startsWith(month)} class:today={d === today} data-date={d}>
          <button type="button" class="num" onclick={() => onday(d)}><span data-value>{Number(d.slice(8, 10))}</span></button>
          {#each list.slice(0, MAX) as o (`${o.uid}|${o.startUtc}`)}
            <button type="button" class="ev" style:border-color={o.color} onclick={() => onselect(o)}><span data-user>{o.displayTitle}</span></button>
          {/each}
          {#if list.length > MAX}<span class="more">{t('m.calendar.more', '+{n} more', { n: list.length - MAX })}</span>{/if}
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .month { display: grid; grid-template-rows: auto repeat(6, minmax(4.5rem, 1fr)); gap: 1px; background: var(--db-line, rgba(127, 127, 127, 0.25)); }
  .row { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px; }
  .name { padding: 0.2rem; text-align: center; font-size: 0.8rem; color: var(--db-muted); background: var(--db-bg, transparent); }
  .cell { display: flex; flex-direction: column; gap: 0.1rem; padding: 0.15rem; min-width: 0; background: var(--db-surface, transparent); }
  .cell.other { opacity: 0.6; }
  .cell.today .num { font-weight: 700; text-decoration: underline; }
  .num, .ev { font: inherit; color: inherit; background: none; border: 0; padding: 0; text-align: start; cursor: pointer; }
  .ev { font-size: 0.75rem; border-left: 3px solid; padding-left: 0.25rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .more { font-size: 0.7rem; color: var(--db-muted); }
  button:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 1px; }
</style>
