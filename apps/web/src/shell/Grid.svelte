<script module lang="ts">
  import { GRID_COLUMNS, GRID_ROW_PX } from '@dash/contract';
  import type { GridFactory, GridItem } from '../lib/grid.js';

  /** Loads gridstack (and its bundled CSS) on first use; kept lazy so it is a separate chunk and never loaded by tests with a fake grid. */
  export async function loadGridstack(): Promise<GridFactory> {
    const [{ GridStack }] = await Promise.all([import('gridstack'), import('gridstack/dist/gridstack.min.css')]);
    return (root) => {
      const gs = GridStack.init(
        { column: GRID_COLUMNS, cellHeight: GRID_ROW_PX, margin: 8, staticGrid: true, animate: false },
        root,
      );
      if (!gs) throw new Error('gridstack failed to initialise');
      return {
        setStatic: (v) => void gs.setStatic(v),
        makeWidget: (el) => void gs.makeWidget(el),
        removeWidget: (el) => void gs.removeWidget(el, false, false),
        update: (el, item) => void gs.update(el, item),
        onChange: (cb) => {
          gs.on('change', (_e, nodes) => {
            cb(
              nodes.flatMap((n) => {
                const id = (n.el as HTMLElement | undefined)?.dataset.itemId ?? String(n.id ?? '');
                return id && n.x !== undefined && n.y !== undefined && n.w !== undefined && n.h !== undefined
                  ? [{ id, x: n.x, y: n.y, w: n.w, h: n.h } satisfies Pick<GridItem, 'id' | 'x' | 'y' | 'w' | 'h'>]
                  : [];
              }),
            );
          });
        },
        destroy: () => void gs.destroy(false),
      };
    };
  }
</script>

<script lang="ts">
  import { clientModules } from '../generated/modules.js';
  import { createGridController, toGridItems, type Layout, type ModuleRegistry } from '../lib/grid.js';
  import { t } from '../lib/i18n.js';
  import { pages, type Page } from '../lib/pages.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import TileSlot from './TileSlot.svelte';

  type Controller = ReturnType<typeof createGridController>;

  let {
    page,
    modules = clientModules,
    gridFactory,
    loadGrid = loadGridstack,
  }: {
    page: Page;
    modules?: ModuleRegistry;
    gridFactory?: GridFactory | undefined;
    loadGrid?: () => Promise<GridFactory>;
  } = $props();

  let root = $state<HTMLElement | null>(null);
  let ctl = $state<Controller | null>(null);
  let loadFailed = $state(false);
  let attempt = $state(0);

  const items = $derived(toGridItems(page.instances, modules));
  const editable = $derived(pages.editing && session.me?.id === page.ownerId);

  function onLayout(changes: { id: string; layout: Layout }[]): void {
    if (!editable) return; // change events also fire on init/compaction; only an owner in edit mode may save
    const byId = new Map(changes.map((c) => [c.id, c.layout]));
    pages.saveLayout(
      page.id,
      page.instances.map((i) => ({ id: i.id, layout: byId.get(i.id) ?? i.layout, mobileOrder: i.mobileOrder })),
    );
  }

  $effect(() => {
    const el = root;
    void attempt;
    if (!el) return;
    let cancelled = false;
    let made: Controller | null = null;
    loadFailed = false;
    void (async () => {
      try {
        const factory = gridFactory ?? (await loadGrid());
        if (cancelled) return;
        made = createGridController(factory, el, onLayout);
        ctl = made;
      } catch {
        if (!cancelled) loadFailed = true;
      }
    })();
    return () => {
      cancelled = true;
      made?.destroy();
      ctl = null;
    };
  });

  $effect(() => {
    ctl?.setEditable(editable);
  });

  $effect(() => {
    const el = root;
    if (!ctl || !el) return;
    const entries = items.flatMap((item) => {
      const node = el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(item.id)}"]`);
      return node ? [{ item, el: node }] : [];
    });
    ctl.sync(entries);
  });
</script>

{#if loadFailed}
  <div class="load-error" role="alert">
    <p>{t('grid.loadFailed', 'The page layout could not be loaded.')}</p>
    <button type="button" onclick={() => attempt++}>{t('grid.retry', 'Retry')}</button>
  </div>
{/if}
<div class="grid-stack grid" class:editable bind:this={root} data-editable={editable}>
  {#each items as item (item.id)}
    {@const inst = page.instances.find((i) => i.id === item.id)}
    <div
      class="grid-stack-item"
      data-item-id={item.id}
      {...{
        'gs-id': item.id,
        'gs-x': item.x,
        'gs-y': item.y,
        'gs-w': item.w,
        'gs-h': item.h,
        'gs-min-w': item.minW,
        'gs-max-w': item.maxW,
        'gs-min-h': item.minH,
        'gs-max-h': item.maxH,
      }}
    >
      <div class="grid-stack-item-content">
        {#if inst}<TileSlot instance={inst} {page} {modules} />{/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .load-error { padding: 1rem; color: var(--db-crit, #b3261e); }
    .grid :global(.grid-stack-item-content) { inset: 0; overflow: hidden; border-radius: var(--db-radius, 8px); }
  .editable :global(.grid-stack-item-content) { outline: 2px dashed var(--db-focus, #1f5fd1); outline-offset: -2px; cursor: grab; }
</style>
