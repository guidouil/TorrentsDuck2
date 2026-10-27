<script lang="ts">
  import { onMount } from 'svelte';
  import Notification from '#lib/Notification.svelte';
  import { t } from '#lib/i18n.js';

  let keys: string[] = [];
  let message = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => () => clearTimeout(timer));

  function keydown(event: KeyboardEvent) {
    const target = event.target;
    if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey
      || (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"], [role="dialog"], dialog')))) {
      keys = [];
      return;
    }
    keys = [...keys, event.key.toLowerCase()].slice(-10);
    let found = '';
    if (keys.join(' ') === 'arrowup arrowup arrowdown arrowdown arrowleft arrowright arrowleft arrowright b a') found = $t.konamiFound;
    else if (keys.slice(-5).join('') === 'iddqd') found = $t.doomFound;
    if (!found) return;
    keys = [];
    message = found;
    clearTimeout(timer);
    timer = setTimeout(() => { message = ''; }, 4200);
  }
</script>

<svelte:window onkeydown={keydown} />
<Notification bind:message />
