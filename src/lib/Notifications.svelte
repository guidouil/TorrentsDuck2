<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n.js';
  import { notifications, notificationHosts } from '#lib/notifications.js';

  let { modal = false }: { modal?: boolean } = $props();
  const id = Symbol();

  $effect(() => {
    notificationHosts.update((hosts) => [...hosts, id]);
    return () => notificationHosts.update((hosts) => hosts.filter((host) => host !== id));
  });
</script>

{#if $notificationHosts.at(-1) === id && $notifications.length}
  <div class={['notifications', { modal }]}>
    {#each $notifications as notification (notification.id)}
      <div class={['notice', { error: notification.kind === 'error', success: notification.kind === 'success' }]} role={notification.kind === 'error' ? 'alert' : 'status'} aria-atomic="true">
        <span class="message">{notification.message}</span>
        <button type="button" class="icon-button" aria-label={$t.close} title={$t.close} onclick={notification.dismiss}><Icon name="x" size={18} /></button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .notifications { position: fixed; right: 20px; bottom: max(20px, env(safe-area-inset-bottom)); z-index: 100; width: min(440px, calc(100% - 32px)); max-height: calc(100dvh - 40px); padding: 4px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; pointer-events: none; }
  .notice { display: flex; align-items: flex-start; gap: 12px; margin: 0; padding: 12px 12px 12px 16px; box-shadow: var(--elevation-3); pointer-events: auto; animation: arrive 180ms ease-out; }
  .message { flex: 1; min-width: 0; align-self: center; }
  .icon-button { flex-shrink: 0; min-width: 44px; min-height: 44px; color: inherit; margin: -4px; }
  @keyframes arrive { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 900px) {
    .notifications { right: 12px; width: min(440px, calc(100% - 24px)); bottom: calc(12px + env(safe-area-inset-bottom)); }
    :global(body:has(.sidebar nav)) .notifications:not(.modal) { bottom: calc(88px + env(safe-area-inset-bottom)); max-height: calc(100dvh - 112px - env(safe-area-inset-bottom)); }
  }
  @media (prefers-reduced-motion: reduce) { .notice { animation: none; } }
</style>
