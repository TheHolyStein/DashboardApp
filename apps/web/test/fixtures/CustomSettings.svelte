<script lang="ts">
  import type { SettingsProps } from '@dash/contract';
  let { value, onChange, isOwner }: SettingsProps<{ text?: string }> = $props();
</script>

<label>
  Custom text
  <input data-testid="custom-settings" value={value.text ?? ''} oninput={(e) => onChange({ ...value, text: e.currentTarget.value })} />
</label>
<span data-testid="settings-owner">{isOwner}</span>
