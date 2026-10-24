<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto, invalidateAll } from '$app/navigation';
  import { api } from '#lib/client.js';
  import { language, t } from '#lib/i18n.js';
  import Icon, { type IconName } from '#lib/Icon.svelte';
  let { data, children } = $props();
  let light = $state(false);
  let error = $state('');
  onMount(() => { light = localStorage.getItem('theme') === 'light'; });
  $effect(() => { document.documentElement.dataset.theme = light ? 'light' : 'dark'; });
  function toggleTheme() { light = !light; localStorage.setItem('theme', light ? 'light' : 'dark'); }
  function toggleLanguage() { language.update((l) => { const next = l === 'fr' ? 'en' : 'fr'; localStorage.setItem('language', next); document.documentElement.lang = next; return next; }); }
  async function logout() { try { await api('/api/auth/sign-out', { method: 'POST', body: '{}' }); await invalidateAll(); await goto('/login'); } catch (e) { error = (e as Error).message; } }
</script>

<div class="app-shell">
  <aside class="sidebar">
    <a class="brand" href="/" aria-label="Torrents Duck"><span class="duck-mark"><Icon name="duck" size={28} /></span><span>Torrents<span class="brand-light">Duck</span></span></a>
    <nav aria-label={$t.mainNavigation}>
      {#each [{ href: '/', label: $t.transfers, icon: 'transfer' }, { href: '/files', label: $t.files, icon: 'files' }, { href: '/chat', label: $t.chat, icon: 'chat' }, ...(data.user?.role === 'admin' ? [{ href: '/admin', label: $t.admin, icon: 'settings' }] : [])] as item (item.href)}
        <a href={item.href} class={{ active: page.url.pathname === item.href }} aria-label={item.label} aria-current={page.url.pathname === item.href ? 'page' : undefined}><span class="nav-icon"><Icon name={item.icon as IconName} size={24} /></span><span class={{ 'nav-full-label': item.href === '/admin' }}>{item.label}</span>{#if item.href === '/admin'}<span class="nav-compact-label">{$t.adminShort}</span>{/if}</a>
      {/each}
    </nav>
    <div class="sidebar-bottom">
      <div class="sidebar-preferences"><button class="icon-button" onclick={toggleLanguage} aria-label={$t.language} title={$t.language}><Icon name="language" /></button><button class="icon-button" onclick={toggleTheme} aria-label={$t.theme} title={$t.theme}><Icon name={light ? 'moon' : 'sun'} /></button></div>
      <div class="account"><span class="avatar">{(data.user?.username || 'D').slice(0, 1).toUpperCase()}</span><div><a href="/account" title={$t.account}><strong>{data.user?.username}</strong></a><small>{data.user?.role === 'admin' ? $t.administrator : $t.member}</small></div><button class="icon-button" onclick={logout} title={$t.logout} aria-label={$t.logout}><Icon name="logout" /></button></div>
    </div>
  </aside>
  <div class="main-shell"><header class="topbar"><div class="topbar-actions"><button class="icon-button" onclick={toggleLanguage} aria-label={$t.language} title={$t.language}><Icon name="language" /></button><button class="icon-button" onclick={toggleTheme} aria-label={$t.theme} title={$t.theme}><Icon name={light ? 'moon' : 'sun'} /></button><a class="quiet-button account-link" href="/account" aria-label={$t.account}><Icon name="user" /><span>{$t.account}</span></a><button class="quiet-button logout-button" onclick={logout} aria-label={$t.logout} title={$t.logout}><Icon name="logout" /><span>{$t.logout}</span></button></div></header>
    <main>{#if error}<div class="notice error" role="alert">{error}</div>{/if}{@render children()}</main>
  </div>
</div>
