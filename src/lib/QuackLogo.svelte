<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n.js';
  let { href }: { href?: string } = $props();
  let audio: HTMLAudioElement;
  function quack() {
    audio.currentTime = 0;
    void audio.play().catch(() => { /* Sound can be unavailable in the browser. */ });
  }
</script>

<audio bind:this={audio} src="/quack.mp3" preload="auto"></audio>
{#snippet brand()}
  <span class="duck-mark" aria-hidden="true"><Icon name="duck" size={28} /></span><span>Torrents<span class="brand-light">Duck2</span></span>
{/snippet}
{#if href}
  <a class="brand" {href} onclick={quack} aria-label={`TorrentsDuck2 · ${$t.quack}`} title={$t.quack}>{@render brand()}</a>
{:else}
  <button type="button" class="brand" onclick={quack} aria-label={`TorrentsDuck2 · ${$t.quack}`} title={$t.quack}>{@render brand()}</button>
{/if}

<style>
  button { background: transparent; color: inherit; padding: 0; }
</style>
