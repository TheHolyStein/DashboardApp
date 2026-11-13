<script lang="ts">
  import { GRID_ROW_PX } from '@dash/contract';
  import { clientModules } from '../generated/modules.js';
  import { detectSwipe, sortForMobile, SWIPE_IGNORE_SELECTOR, type ModuleRegistry } from '../lib/grid.js';
  import { pages, type Page } from '../lib/pages.svelte.js';
  import TileSlot from './TileSlot.svelte';

  let { page, modules = clientModules }: { page: Page; modules?: ModuleRegistry } = $props();

  const MIN_TILE_PX = GRID_ROW_PX;
  const ordered = $derived(sortForMobile(page.instances));

  let start: { x: number; y: number; id: number } | null = null;

  function down(e: PointerEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    start = target?.closest(SWIPE_IGNORE_SELECTOR) ? null : { x: e.clientX, y: e.clientY, id: e.pointerId };
  }
  function up(e: PointerEvent): void {
    const s = start;
    start = null;
    if (!s) return;
    const dir = detectSwipe(e.clientX - s.x, e.clientY - s.y);
    if (dir === 'next') pages.next();
    else if (dir === 'prev') pages.prev();
  }
  function cancel(): void {
    start = null;
  }
</script>

<div class="stack" role="presentation" onpointerdown={down} onpointerup={up} onpointercancel={cancel}>
  {#each ordered as inst (inst.id)}
    <div class="cell" data-item-id={inst.id} style:height="{Math.max(MIN_TILE_PX, inst.layout.h * GRID_ROW_PX)}px">
      <TileSlot instance={inst} {page} {modules} />
    </div>
  {/each}
</div>

<style>
  .stack { display: flex; flex-direction: column; gap: var(--db-gap, 8px); touch-action: pan-y; min-height: 60vh; }
  .cell { flex: none; }
</style>
