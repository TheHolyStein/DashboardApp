<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { data, level, size, mode, settings, openDetail, locale, timeZone, isOwner }: TileProps<{ text?: string }, { label?: string }> = $props();
</script>

<div data-testid="good">
  <span data-testid="text">{data?.text ?? 'no data'}</span>
  <span data-testid="level">{level}</span>
  <span data-testid="size">{size.w}x{size.h}</span>
  <span data-testid="owner">{isOwner}</span>
  <span data-testid="mode">{mode}</span>
  <span data-testid="format">{locale}|{timeZone}</span>
  <span data-testid="label">{settings.label ?? ''}</span>
  <button type="button" onclick={() => openDetail({ tab: 'week' })}>open week</button>
  <button type="button" onclick={() => openDetail()}>open plain</button>
  <button type="button" data-testid="noop">noop</button>
  <span data-no-open data-testid="no-open">keep</span>
  <span data-testid="plain-area">plain</span>
</div>
