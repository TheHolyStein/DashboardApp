<script lang="ts">
  import { useIcons } from './context.js';

  let { name, size = 20, label }: { name: string; size?: number; label?: string | undefined } = $props();

  const icons = useIcons();
  // SVG strings come only from themes/modules bundled with the app, never from the network.
  const svg = $derived(icons?.(name));
</script>

<span
  class="icon"
  style:width="{size}px"
  style:height="{size}px"
  aria-hidden={label ? undefined : 'true'}
  role={label ? 'img' : undefined}
  aria-label={label}
  data-icon={name}
>
  {#if svg}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- svg strings come only from bundled themes/modules, never from the network -->
    {@html svg}
  {:else}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" data-placeholder="true">
      <circle cx="12" cy="12" r="8" />
    </svg>
  {/if}
</span>

<style>
  .icon { display: inline-flex; flex: none; align-items: center; justify-content: center; color: inherit; }
  .icon :global(svg) { width: 100%; height: 100%; }
</style>
