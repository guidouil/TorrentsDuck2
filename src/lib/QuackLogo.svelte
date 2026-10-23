<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n.js';
  let audio: HTMLAudioElement;
  function quack() {
    audio.currentTime = 0;
    void audio.play().catch(() => { /* Sound can be unavailable in the browser. */ });
  }
</script>

<audio bind:this={audio} src="/quack.mp3" preload="auto"></audio>
<button type="button" class="brand" onclick={quack} aria-label={`Torrents Duck · ${$t.quack}`} title={$t.quack}>
  <span class="duck-mark" aria-hidden="true"><Icon name="duck" size={28} /></span><span>Torrents<span class="brand-light">Duck</span></span>
</button>

<style>
  button { background: transparent; color: inherit; padding: 0; }
</style>
