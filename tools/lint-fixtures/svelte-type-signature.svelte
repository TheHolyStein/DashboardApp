<script lang="ts">
  // A parameter name inside a function type is documentation, not a variable.
  type Handler = (id: string, count: number) => void;
  let { onPick }: { onPick: (id: string, count: number) => void } = $props();
  const h: Handler = onPick;
</script>

<button type="button" onclick={() => h('a', 1)}>go</button>
