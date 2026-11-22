<script lang="ts">
  import { getContext } from 'svelte';
  import { THEME_KEY, type ThemeSeam } from '../../../src/lib/host.js';

  const seam = getContext<ThemeSeam>(THEME_KEY);
</script>

<p data-testid="seam">{seam.id}|{seam.mode}|{seam.icon?.('bell') ?? 'none'}</p>
