<script lang="ts">
  // Day columns with an all-day strip and a 24-hour time grid. With edit rights events can be dragged to move them
  // and their bottom edge dragged to resize them (15-minute steps); a click on an empty slot creates an event there.
  import type { Translate } from '@dash/contract';
  import { PX_PER_MIN, byStart, dayLabel, formatClock, minuteOfDay, touches, viewerWall, type OccLike } from './format.js';

  const SNAP = 15;

  let {
    days,
    events,
    today,
    timeZone,
    locale,
    t,
    canEdit,
    onselect,
    oncreate,
    onmove,
  }: {
    days: string[];
    events: Array<OccLike & { editable?: boolean }>;
    today: string;
    timeZone: string;
    locale: string;
    t: Translate;
    canEdit: boolean;
    onselect: (o: OccLike) => void;
    oncreate: (date: string, minute: number) => void;
    onmove: (o: OccLike, deltaMin: number, resizeMin: number) => void;
  } = $props();

  const hours = Array.from({ length: 24 }, (_, h) => h);
  const sorted = $derived([...events].sort(byStart));
  const snap = (px: number): number => Math.round(px / PX_PER_MIN / SNAP) * SNAP;

  let drag = $state<{ key: string; mode: 'move' | 'resize'; y0: number; delta: number } | null>(null);
  const keyOf = (o: OccLike): string => `${o.calendarId}|${o.uid}|${o.startUtc}`;

  function block(o: OccLike, date: string): { top: number; height: number } {
    const s = viewerWall(o, 'start', timeZone);
    const e = viewerWall(o, 'end', timeZone);
    const startMin = s.slice(0, 10) < date ? 0 : minuteOfDay(s);
    const endMin = e.slice(0, 10) > date ? 1440 : minuteOfDay(e);
    return { top: startMin * PX_PER_MIN, height: Math.max(12, (endMin - startMin) * PX_PER_MIN) };
  }

  function down(e: PointerEvent, o: OccLike & { editable?: boolean }, mode: 'move' | 'resize'): void {
    e.stopPropagation();
    if (!canEdit || !o.editable) {
      if (mode === 'move') onselect(o);
      return;
    }
    e.preventDefault();
    drag = { key: keyOf(o), mode, y0: e.clientY, delta: 0 };
    const move = (ev: PointerEvent): void => {
      if (drag) drag.delta = snap(ev.clientY - drag.y0);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const d = drag;
      drag = null;
      if (!d || d.delta === 0) {
        if (d?.mode !== 'resize') onselect(o);
        return;
      }
      if (d.mode === 'move') onmove(o, d.delta, 0);
      else onmove(o, 0, d.delta);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function slotClick(e: MouseEvent, date: string): void {
    if (!canEdit) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const minute = Math.min(1440 - SNAP, Math.max(0, Math.floor((e.clientY - rect.top) / PX_PER_MIN / SNAP) * SNAP));
    oncreate(date, minute);
  }
</script>

<div class="grid" style:--cols={days.length} data-testid="timegrid">
  <div class="corner"></div>
  {#each days as d (d)}
    {@const label = dayLabel(d, today, { locale, t })}
    <div class="dayhead" class:today={d === today}>{#if label.isWord}{label.text}{:else}<span data-value>{label.text}</span>{/if}</div>
  {/each}

  <div class="corner allday-label">{t('m.calendar.allDay', 'All day')}</div>
  {#each days as d (d)}
    <div class="allday">
      {#each sorted.filter((o) => o.allDay && touches(o, d, timeZone)) as o (keyOf(o))}
        <button type="button" class="chip" style:border-color={o.color} onclick={() => onselect(o)}><span data-user>{o.displayTitle}</span></button>
      {/each}
    </div>
  {/each}

  <div class="hours">
    {#each hours as h (h)}<div class="hour" style:height={`${60 * PX_PER_MIN}px`}><span data-value>{formatClock(`2000-01-01T${String(h).padStart(2, '0')}:00:00`, locale)}</span></div>{/each}
  </div>
  {#each days as d (d)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="col" style:height={`${1440 * PX_PER_MIN}px`} data-date={d} onclick={(e) => slotClick(e, d)}>
      {#each sorted.filter((o) => !o.allDay && touches(o, d, timeZone)) as o (keyOf(o))}
        {@const b = block(o, d)}
        {@const live = drag && drag.key === keyOf(o) ? drag : null}
        <div
          class="ev"
          class:dragging={live}
          role="button"
          tabindex="0"
          data-uid={o.uid}
          style:top={`${b.top + (live?.mode === 'move' ? live.delta * PX_PER_MIN : 0)}px`}
          style:height={`${b.height + (live?.mode === 'resize' ? live.delta * PX_PER_MIN : 0)}px`}
          style:border-color={o.color}
          onpointerdown={(e) => down(e, o, 'move')}
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onselect(o);
            }
          }}
        >
          <span class="time" data-value>{formatClock(viewerWall(o, 'start', timeZone), locale)}</span>
          <span data-user>{o.displayTitle}</span>
          {#if canEdit && o.editable}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="resize" data-testid="resize" onpointerdown={(e) => down(e, o, 'resize')}></div>
          {/if}
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .grid { display: grid; grid-template-columns: 3.5rem repeat(var(--cols), minmax(0, 1fr)); overflow: auto; max-height: 70vh; }
  .dayhead, .corner { position: sticky; top: 0; z-index: 2; background: var(--db-bg, var(--db-surface)); padding: 0.2rem; font-size: 0.8rem; text-align: center; }
  .dayhead.today { font-weight: 700; }
  .allday-label { font-size: 0.7rem; color: var(--db-muted); text-align: end; }
  .allday { display: grid; gap: 1px; padding: 1px; border-bottom: 1px solid var(--db-line, rgba(127, 127, 127, 0.3)); }
  .chip { font: inherit; font-size: 0.75rem; color: inherit; background: var(--db-surface-2, rgba(127, 127, 127, 0.15)); border: 0; border-left: 3px solid; text-align: start; cursor: pointer; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .hours { display: grid; }
  .hour { font-size: 0.7rem; color: var(--db-muted); text-align: end; padding-right: 0.3rem; border-top: 1px solid var(--db-line, rgba(127, 127, 127, 0.2)); box-sizing: border-box; }
  .col { position: relative; border-left: 1px solid var(--db-line, rgba(127, 127, 127, 0.25)); background-image: linear-gradient(var(--db-line, rgba(127, 127, 127, 0.2)) 1px, transparent 1px); background-size: 100% 48px; cursor: cell; }
  .ev { position: absolute; left: 2px; right: 2px; overflow: hidden; font-size: 0.75rem; padding: 0.1rem 0.25rem; border-left: 3px solid; border-radius: 4px; background: var(--db-surface-2, rgba(127, 127, 127, 0.2)); cursor: pointer; touch-action: none; box-sizing: border-box; }
  .ev.dragging { opacity: 0.8; z-index: 3; }
  .ev:focus-visible, .chip:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 1px; }
  .time { display: block; color: var(--db-muted); }
  .resize { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; cursor: ns-resize; }
  @media (prefers-reduced-motion: no-preference) { .ev { transition: opacity 120ms; } }
</style>
