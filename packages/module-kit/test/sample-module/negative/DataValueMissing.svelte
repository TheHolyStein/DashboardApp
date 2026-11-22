<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { t }: TileProps<{ label: string }> = $props();
  const formatted = 'Thu 12:30 PM';
</script>

<p>{t('m.sample.label', 'Label')}</p>
<p><span>{formatted}</span></p>
