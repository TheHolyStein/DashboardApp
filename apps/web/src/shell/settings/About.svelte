<script lang="ts">
  import { onMount } from 'svelte';
  import { Health } from '../../lib/admin-api.js';
  import { api } from '../../lib/api.js';
  import { t } from '../../lib/i18n.js';
  import type { z } from 'zod';

  let info = $state<z.infer<typeof Health> | null>(null);
  let failed = $state(false);
  onMount(() => {
    api.get('/health', Health).then(
      (h) => (info = h),
      () => (failed = true),
    );
  });
</script>

<div class="st">
  {#if info}
    <p>{t('about.version', 'App version {v}', { v: info.version })}</p>
    <p>{t('about.contract', 'Contract version {v}', { v: String(info.contract) })}</p>
  {:else if failed}
    <p class="err" role="alert">{t('about.failed', 'Could not read the version.')}</p>
  {:else}
    <p role="status">{t('settings.loading', 'Loading…')}</p>
  {/if}
  <p class="muted">
    {t('about.licences', 'Home Dashboard runs entirely on your own server. It is built with open-source software under MIT, ISC, BSD, Apache-2.0 and MPL-2.0 licences.')}
  </p>
</div>
