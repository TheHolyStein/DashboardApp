<script lang="ts">
  import type { DetailProps } from '@dash/contract';
  import { control } from './control.js';
  let { params, close }: DetailProps = $props();
  if (control.throwDetail) throw new Error('detail exploded');
</script>

<div data-testid="detail">
  <span data-testid="tab">{params.tab ?? 'none'}</span>
  <button type="button" onclick={close}>done</button>
</div>
