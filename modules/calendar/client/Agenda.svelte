<script lang="ts" generics="T extends OccLike">
  // Events grouped by local start date with Today / Tomorrow labels; all-day events first in each day.
  import type { Translate } from '@dash/contract';
  import { dayLabel, formatClock, groupByDay, viewerWall, type OccLike } from './format.js';

  let {
    items,
    today,
    t,
    locale,
    timeZone,
    onselect,
  }: {
    items: T[];
    today: string;
    t: Translate;
    locale: string;
    timeZone: string;
    onselect?: (o: T) => void;
  } = $props();

  const groups = $derived(groupByDay(items, timeZone));
</script>

{#snippet row(o: T)}
              <span class="dot" style:background={o.color} aria-hidden="true"></span>
              <span class="when">
                {#if o.allDay}{t('m.calendar.allDay', 'All day')}{:else}<span data-value>{formatClock(viewerWall(o, 'start', timeZone), locale)}</span>{/if}
              </span>
              <span class="title" data-user>{o.displayTitle}</span>
              {#if o.mentions.length + o.tags.length > 0}
                <span class="chips" data-user>
                  {#each o.mentions as m (m)}<span class="chip">@{m}</span>{/each}
                  {#each o.tags as tag (tag)}<span class="chip tag">#{tag}</span>{/each}
                </span>
              {/if}
{/snippet}

<div class="agenda">
  {#each groups as g (g.date)}
    {@const label = dayLabel(g.date, today, { locale, t })}
    <section aria-label={label.text}>
      <h4 class="day">{#if label.isWord}{label.text}{:else}<span data-value>{label.text}</span>{/if}</h4>
      <ul>
        {#each g.items as o (`${o.calendarId}|${o.uid}|${o.startUtc}`)}
          <li>
            {#if onselect}
              <button type="button" class="row" onclick={() => onselect(o)}>{@render row(o)}</button>
            {:else}
              <div class="row">{@render row(o)}</div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>

<style>
  .agenda { display: grid; gap: 0.5rem; }
  .day { margin: 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--db-muted); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.15rem; }
  .row { display: flex; align-items: baseline; gap: 0.5rem; width: 100%; padding: 0.15rem 0; font: inherit; color: inherit; background: none; border: 0; text-align: start; }
  button.row { cursor: pointer; border-radius: var(--db-radius, 6px); }
  button.row:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
  .dot { flex: none; width: 0.6rem; height: 0.6rem; border-radius: 50%; align-self: center; }
  .when { flex: none; min-width: 4.5em; color: var(--db-muted); font-variant-numeric: tabular-nums; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chips { display: flex; gap: 0.25rem; flex-wrap: wrap; }
  .chip { font-size: 0.75rem; padding: 0 0.4em; border-radius: 999px; background: var(--db-surface-2, rgba(127, 127, 127, 0.15)); }
</style>
