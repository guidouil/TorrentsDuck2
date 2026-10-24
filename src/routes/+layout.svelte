<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { language, t } from '#lib/i18n.js';
  import './styles.css';
  let { children } = $props();
  let light = $state(false);
  onMount(() => { language.set(localStorage.getItem('language') === 'en' ? 'en' : 'fr'); light = localStorage.getItem('theme') === 'light'; document.documentElement.dataset.theme = light ? 'light' : 'dark'; });
  $effect(() => { document.documentElement.lang = $language; });
  function toggleLanguage() { language.update((value) => { const next = value === 'fr' ? 'en' : 'fr'; localStorage.setItem('language', next); return next; }); }
  function toggleTheme() { light = !light; localStorage.setItem('theme', light ? 'light' : 'dark'); document.documentElement.dataset.theme = light ? 'light' : 'dark'; }
</script>
{#if ['/login', '/login/device', '/register', '/reset-password', '/waiting'].includes(page.url.pathname)}<div class="auth-preferences"><button class="quiet-button" onclick={toggleLanguage} aria-label={$t.language}>{$language === 'fr' ? 'FR' : 'EN'}</button><button class="icon-button" onclick={toggleTheme} aria-label={$t.theme}><Icon name={light ? 'moon' : 'sun'} /></button></div>{/if}
{@render children()}
