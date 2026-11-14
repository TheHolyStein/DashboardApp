<script lang="ts">
  import DetailHost from '../../src/shell/DetailHost.svelte';
  import TileHost from '../../src/shell/TileHost.svelte';
  import type { Instance } from '../../src/lib/grid.js';
  import type { HostRegistry } from '../../src/lib/host.js';
  import type { Page } from '../../src/lib/pages.svelte.js';

  let { instances, page, modules }: { instances: Instance[]; page: Page; modules: HostRegistry } = $props();
</script>

<button type="button" data-testid="opener">opener</button>
{#each instances as instance (instance.id)}
  <div data-testid={`slot-${instance.id}`}><TileHost {instance} {page} {modules} /></div>
{/each}
<DetailHost {modules} />
