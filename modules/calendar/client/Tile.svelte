<script lang="ts">
  // Calendar tile: today's remaining events, then the next days grouped by date. At min size only the next event.
  // Without `data` a loading line; with no events an empty state. "+" (edit, owner) opens the detail in create mode.
  import type { TileProps } from '@dash/contract';
  import { Button, Empty } from '@dash/ui';
  import type { Settings } from '../manifest.js';
  import type { Snapshot } from '../server/reminders.js';
  import Agenda from './Agenda.svelte';
  import { byStart, dayLabel, formatClock, localDay, startDay, viewerWall } from './format.js';

  let { data, level, isOwner, size, t, locale, timeZone, openDetail }: TileProps<Snapshot, Settings> = $props();

  const items = $derived([...(data?.today ?? []), ...(data?.next ?? [])].sort(byStart));
  const compact = $derived(size.w <= 2 || size.h <= 2);
  const today = $derived(localDay(Date.now(), timeZone));
  const first = $derived(items.find((o) => !o.allDay) ?? items[0]);
  const canEdit = $derived(level === 'edit' && isOwner);
</script>

<div class="cal-tile">
  {#if !data}
    <p class="muted">{t('m.calendar.loading', 'Loading…')}</p>
  {:else if items.length === 0}
    <Empty text={t('m.calendar.empty', 'No upcoming events.')} />
  {:else if compact && first}
    {@const label = dayLabel(startDay(first, timeZone), today, { locale, t })}
    <div class="next" data-testid="next-event">
      <span class="dot" style:background={first.color} aria-hidden="true"></span>
      <span class="title" data-user>{first.displayTitle}</span>
      <span class="when">
        {#if label.isWord}{label.text}{:else}<span data-value>{label.text}</span>{/if}
        {#if !first.allDay}<span data-value>{formatClock(viewerWall(first, 'start', timeZone), locale)}</span>{/if}
      </span>
    </div>
  {:else}
    <Agenda {items} {today} {t} {locale} {timeZone} />
  {/if}
  {#if canEdit && !compact}
    <div class="add">
      <Button data-edit onclick={() => openDetail({ mode: 'create' })} aria-label={t('m.calendar.newEvent', 'New event')}>+</Button>
    </div>
  {/if}
</div>

<style>
  .cal-tile { position: relative; display: grid; align-content: start; gap: 0.5rem; width: 100%; height: 100%; overflow: auto; color: var(--db-fg); }
  .muted { margin: 0; color: var(--db-muted); }
  .next { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.5rem; align-items: center; }
  .next .when { grid-column: 2; color: var(--db-muted); display: flex; gap: 0.4em; }
  .next .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; }
  .add { position: sticky; bottom: 0; justify-self: end; }
</style>
