<script lang="ts">
  import type { DetailProps } from '@dash/contract';
  import { control } from './control.js';
  let { params, close, locale, timeZone, isOwner }: DetailProps = $props();
  if (control.throwDetail) throw new Error('detail exploded');
</script>

<div data-testid="detail">
  <span data-testid="tab">{params.tab ?? 'none'}</span>
  <span data-testid="owner">{isOwner}</span>
  <span data-testid="format">{locale}|{timeZone}</span>
  <button type="button" onclick={close}>done</button>
</div>
