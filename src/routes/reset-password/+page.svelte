<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import Notification from '#lib/Notification.svelte';
  import { t } from '#lib/i18n.js';
  import { page } from '$app/state';
  import { api } from '#lib/client.js';
  let password = $state(''); let confirmation = $state(''); let error = $state(''); let busy = $state(false); let done = $state(false);
  const token = $derived(page.url.searchParams.get('token'));
  async function submit(event: SubmitEvent) { event.preventDefault(); if (password !== confirmation) { error = $t.passwordMismatch; return; } busy = true; error = ''; try { await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword: password }) }); done = true; } catch (e) { error = (e as Error).message; } finally { busy = false; } }
</script>
<svelte:head><title>{$t.newPassword} · TorrentsDuck2</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class="auth-page"><section class="auth-card"><a class="brand" href="/login"><span class="duck-mark" aria-hidden="true"><Icon name="duck" size={28} /></span><span>Torrents<span class="brand-light">Duck2</span></span></a><h1>{$t.newPassword}</h1><p class="subtitle">{$t.passwordLength}</p><p class="subtitle">{$t.ftpsDisconnect}</p><Notification bind:message={error} kind="error" />{#if done}<div class="notice success">{$t.passwordSaved}</div><a class="button primary" href="/login">{$t.signIn}</a>{:else if token}<form onsubmit={submit} class="form-stack"><label>{$t.password}<input type="password" bind:value={password} required minlength={12} maxlength={128} autocomplete="new-password" /></label><label>{$t.confirmation}<input type="password" bind:value={confirmation} required minlength={12} maxlength={128} autocomplete="new-password" /></label><button class="primary" disabled={busy}>{$t.save}</button></form>{:else}<div class="notice error">{$t.invalidReset}</div><a href="/login">{$t.requestNewLink}</a>{/if}</section></div>
