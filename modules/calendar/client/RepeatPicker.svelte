<script lang="ts">
  // Repeat rule editor: none / daily / weekly on days / monthly / yearly / custom interval; ends never / on a date /
  // after n times. Reads and writes an RRULE string (null = no repeat).
  import type { Translate } from '@dash/contract';
  import { weekdayNames } from './format.js';

  let {
    value = $bindable(),
    allDay,
    startDate,
    weekStart = 'mon',
    t,
    locale,
  }: { value: string | null; allDay: boolean; startDate: string; weekStart?: 'mon' | 'sun'; t: Translate; locale: string } = $props();

  type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
  const order = $derived(weekStart === 'mon' ? DAYS : (['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const));
  const names = $derived(weekdayNames(locale, weekStart));

  function parse(rule: string | null) {
    const parts = new Map((rule ?? '').replace(/^RRULE:/i, '').split(';').filter(Boolean).map((p) => p.split('=') as [string, string]));
    const freq = (parts.get('FREQ') ?? '') as Freq | '';
    const interval = Number(parts.get('INTERVAL') ?? '1') || 1;
    const until = parts.get('UNTIL');
    const count = parts.get('COUNT');
    return {
      kind: !freq ? 'none' : interval > 1 ? 'custom' : freq,
      freq: (freq || 'WEEKLY') as Freq,
      interval,
      byday: (parts.get('BYDAY') ?? '').split(',').filter((d) => (DAYS as readonly string[]).includes(d)),
      end: until ? 'until' : count ? 'count' : 'never',
      until: until ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` : '',
      count: Number(count ?? '10') || 10,
    };
  }

  const initial = parse(value);
  let kind = $state<string>(initial.kind);
  let freq = $state<Freq>(initial.freq);
  let interval = $state(initial.interval);
  let byday = $state<string[]>(initial.byday);
  let end = $state<string>(initial.end);
  let until = $state(initial.until);
  let count = $state(initial.count);

  function build(): string | null {
    if (kind === 'none') return null;
    const f: Freq = kind === 'custom' ? freq : (kind as Freq);
    const parts = [`FREQ=${f}`];
    if (kind === 'custom' && interval > 1) parts.push(`INTERVAL=${Math.min(999, Math.floor(interval))}`);
    if (f === 'WEEKLY' && byday.length > 0) parts.push(`BYDAY=${DAYS.filter((d) => byday.includes(d)).join(',')}`);
    if (end === 'until' && until) parts.push(`UNTIL=${until.replace(/-/g, '')}${allDay ? '' : 'T235959Z'}`);
    if (end === 'count') parts.push(`COUNT=${Math.max(1, Math.min(999, Math.floor(count)))}`);
    return parts.join(';');
  }

  $effect(() => {
    const next = build();
    if (next !== value) value = next;
  });

  const toggleDay = (d: string): void => {
    byday = byday.includes(d) ? byday.filter((x) => x !== d) : [...byday, d];
  };
</script>

<fieldset class="repeat">
  <legend>{t('m.calendar.repeat', 'Repeat')}</legend>
  <select bind:value={kind} aria-label={t('m.calendar.repeat', 'Repeat')}>
    <option value="none">{t('m.calendar.repeat.none', 'Does not repeat')}</option>
    <option value="DAILY">{t('m.calendar.repeat.daily', 'Daily')}</option>
    <option value="WEEKLY">{t('m.calendar.repeat.weekly', 'Weekly')}</option>
    <option value="MONTHLY">{t('m.calendar.repeat.monthly', 'Monthly')}</option>
    <option value="YEARLY">{t('m.calendar.repeat.yearly', 'Yearly')}</option>
    <option value="custom">{t('m.calendar.repeat.custom', 'Custom')}</option>
  </select>
  {#if kind === 'custom'}
    <label>{t('m.calendar.repeat.every', 'Every')}
      <input type="number" min="1" max="999" bind:value={interval} />
      <select bind:value={freq} aria-label={t('m.calendar.repeat.unit', 'Unit')}>
        <option value="DAILY">{t('m.calendar.repeat.days', 'days')}</option>
        <option value="WEEKLY">{t('m.calendar.repeat.weeks', 'weeks')}</option>
        <option value="MONTHLY">{t('m.calendar.repeat.months', 'months')}</option>
        <option value="YEARLY">{t('m.calendar.repeat.years', 'years')}</option>
      </select>
    </label>
  {/if}
  {#if kind === 'WEEKLY' || (kind === 'custom' && freq === 'WEEKLY')}
    <div class="days" role="group" aria-label={t('m.calendar.repeat.onDays', 'On days')}>
      {#each order as d, i (d)}
        <label class="day"><input type="checkbox" checked={byday.includes(d)} onchange={() => toggleDay(d)} /><span data-value>{names[i]}</span></label>
      {/each}
    </div>
  {/if}
  {#if kind !== 'none'}
    <div class="end">
      <select bind:value={end} aria-label={t('m.calendar.repeat.ends', 'Ends')}>
        <option value="never">{t('m.calendar.repeat.never', 'Never ends')}</option>
        <option value="until">{t('m.calendar.repeat.until', 'Ends on date')}</option>
        <option value="count">{t('m.calendar.repeat.count', 'Ends after a number of times')}</option>
      </select>
      {#if end === 'until'}<input type="date" min={startDate} bind:value={until} aria-label={t('m.calendar.repeat.untilDate', 'End date')} />{/if}
      {#if end === 'count'}<input type="number" min="1" max="999" bind:value={count} aria-label={t('m.calendar.repeat.times', 'Times')} />{/if}
    </div>
  {/if}
</fieldset>

<style>
  .repeat { display: grid; gap: 0.4rem; border: 0; padding: 0; margin: 0; }
  legend { font-weight: 600; padding: 0; margin-bottom: 0.25rem; }
  .days { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .day { display: inline-flex; gap: 0.2rem; align-items: center; }
  .end { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  input[type='number'] { width: 5em; }
</style>
