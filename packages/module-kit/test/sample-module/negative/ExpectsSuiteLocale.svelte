<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { t, locale, timeZone }: TileProps<{ label: string }> = $props();
  // Throws unless the suite supplied its explicit values: proves they reach the component.
  if (locale !== 'de-DE' || timeZone !== 'Asia/Kolkata') throw new Error(`got ${locale} / ${timeZone}`);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(new Date('2026-01-01T12:00:00Z'));
</script>

<p>{t('m.sample.label', 'Label')}</p>
<p><span data-value>{time}</span></p>
