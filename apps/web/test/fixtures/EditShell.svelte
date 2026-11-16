<script lang="ts">
  import type { EditRegistry } from '../../src/lib/schema-form.js';
  import Catalog from '../../src/shell/Catalog.svelte';
  import EditBar from '../../src/shell/EditBar.svelte';
  import Pages from '../../src/shell/Pages.svelte';
  import SettingsDialog from '../../src/shell/SettingsDialog.svelte';

  let { modules }: { modules: EditRegistry } = $props();
  // Never matches: renders the mobile stack, which needs no grid library.
  const noMatch = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
</script>

<EditBar />
<Pages {modules} matchMedia={noMatch} />
<SettingsDialog {modules} />
<Catalog {modules} />
