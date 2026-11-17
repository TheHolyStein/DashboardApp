<script lang="ts">
  import type { BackgroundProps } from '@dash/contract';

  let { mode, intensity }: BackgroundProps = $props();
</script>

<div class="base" data-mode={mode} aria-hidden="true">
  <div class="wash" class:drift={intensity === 'full'}></div>
</div>

<style>
  .base {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--db-bg);
  }
  .wash {
    position: absolute;
    inset: -20%;
    background:
      radial-gradient(60% 60% at 20% 20%, color-mix(in srgb, var(--db-accent) 18%, transparent), transparent),
      radial-gradient(50% 50% at 80% 85%, color-mix(in srgb, var(--db-accent-2) 12%, transparent), transparent);
  }
  .drift {
    animation: gradient-drift 120s ease-in-out infinite alternate;
  }
  @keyframes gradient-drift {
    from {
      transform: translate(-3%, -2%) rotate(0deg);
    }
    to {
      transform: translate(3%, 2%) rotate(8deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .drift {
      animation: none;
    }
  }
</style>
