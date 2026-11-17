<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { t }: TileProps<{ label: string }> = $props();
</script>

<p>{t('m.sample.label', 'Label')}</p>
<p><span data-value>Dentist appointment</span></p>
