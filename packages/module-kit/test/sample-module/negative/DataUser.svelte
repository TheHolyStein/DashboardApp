<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { t }: TileProps<{ label: string }> = $props();
</script>

<p>{t('m.sample.label', 'Label')}</p>
<p><span data-user>Dentist appointment</span></p>
<p><span data-user><b>Buy oat milk tomorrow</b></span></p>
