<script lang="ts">
  let { text }: { text: string } = $props();
</script>

<p class="empty">{text}</p>

<style>
  .empty { margin: 0; padding: 1rem; text-align: center; color: var(--db-muted, #4a5260); }
</style>
