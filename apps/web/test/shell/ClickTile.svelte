<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { openDetail }: TileProps = $props();
</script>

<div data-testid="click-tile">
  <p data-testid="sel-text">Select this sentence</p>
  <label data-testid="lbl"><span data-testid="lbl-text">Label text</span><input type="checkbox" /></label>
  <span data-testid="plain-area">plain</span>
  <button type="button" onclick={() => openDetail()}>open plain</button>
</div>
