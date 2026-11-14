<script lang="ts">
  import { control } from './control.js';
  if (control.throwTile) throw new Error('tile exploded');
</script>

<div data-testid="recovered">recovered</div>
