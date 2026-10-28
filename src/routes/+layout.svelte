<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import Notifications from '#lib/Notifications.svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { language, t } from '#lib/i18n.js';
  import { light, skin, restoreTheme, toggleTheme } from '#lib/theme.js';
  import './styles.css';
  let { children } = $props();
  onMount(() => {
    restoreTheme();
    try { language.set(localStorage.getItem('language') === 'en' ? 'en' : 'fr'); } catch { /* Keep the default language. */ }
  });
  $effect(() => { document.documentElement.lang = $language; });
  $effect(() => { document.documentElement.dataset.theme = $light ? 'light' : 'dark'; });
  $effect(() => { document.documentElement.dataset.skin = $skin; });
  function toggleLanguage() { language.update((value) => { const next = value === 'fr' ? 'en' : 'fr'; localStorage.setItem('language', next); return next; }); }
</script>
<Notifications />
{#if page.error || ['/login', '/login/device', '/register', '/reset-password', '/waiting'].includes(page.url.pathname)}<div class="auth-preferences"><button class="quiet-button" onclick={toggleLanguage} aria-label={$t.language}>{$language === 'fr' ? 'FR' : 'EN'}</button><button class="icon-button" onclick={toggleTheme} aria-label={$t.theme}><Icon name={$light ? 'moon' : 'sun'} /></button></div>{/if}
{@render children()}
