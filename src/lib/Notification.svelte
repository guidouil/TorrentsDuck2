<script lang="ts">
  import { notifications, type Notification } from '#lib/notifications.js';

  let { message = $bindable(''), kind = 'info' }: { message?: string; kind?: Notification['kind'] } = $props();
  const id = Symbol();

  $effect(() => {
    if (!message) return;
    notifications.update((items) => [...items, { id, message, kind, dismiss: () => { message = ''; } }]);
    return () => notifications.update((items) => items.filter((item) => item.id !== id));
  });
</script>
