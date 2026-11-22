<script lang="ts">
  import type { Condition } from '../manifest.js';

  // Plain line icons that inherit the text colour; the size follows the surrounding font size.
  let { condition, label }: { condition: Condition; label: string } = $props();
</script>

<svg
  class="icon"
  viewBox="0 0 24 24"
  width="1em"
  height="1em"
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  role="img"
  aria-label={label}
>
  {#if condition === 'clear'}
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  {:else}
    <path d="M7 18h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.5 4.25 4.25 0 0 0 7 18z" />
    {#if condition === 'fog'}
      <path d="M5 21h14" />
    {:else if condition === 'drizzle'}
      <path d="M9 21v.01M13 21v.01M17 21v.01" />
    {:else if condition === 'rain'}
      <path d="M9 20.5l-.8 1.5M13 20.5l-.8 1.5M17 20.5l-.8 1.5" />
    {:else if condition === 'snow'}
      <path d="M9 21v.01M13 21v.01M17 21v.01M11 22.5v.01M15 22.5v.01" />
    {:else if condition === 'storm'}
      <path d="M12.5 15l-2.5 4h3l-2 3" />
    {/if}
  {/if}
</svg>

<style>
  .icon {
    display: inline-block;
    vertical-align: -0.125em;
    flex: none;
  }
</style>
