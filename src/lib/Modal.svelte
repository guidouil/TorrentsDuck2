<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n.js';
  let { open = $bindable(false), title, wide = false, children }: { open?: boolean; title: string; wide?: boolean; children: import('svelte').Snippet } = $props();
  let dialog = $state<HTMLDialogElement>();
  $effect(() => { if (open && dialog && !dialog.open) dialog.showModal(); else if (!open && dialog?.open) dialog.close(); });
</script>
<dialog bind:this={dialog} class={{ 'video-dialog': wide }} oncancel={() => { open = false; }} onclose={() => { open = false; }} aria-label={title}>
  <div class="dialog-heading"><h2>{title}</h2><button type="button" class="icon-button" aria-label={$t.close} onclick={() => { open = false; }}><Icon name="x" /></button></div>
  {@render children()}
</dialog>
