<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { api } from '#lib/client.js';
  import { t } from '#lib/i18n.js';
  let username = $state(''); let email = $state(''); let password = $state(''); let confirmation = $state(''); let error = $state(''); let busy = $state(false);
  async function submit(event: SubmitEvent) {
    event.preventDefault(); error = '';
    if (password !== confirmation) { error = $t.passwordMismatch; return; }
    busy = true;
    try {
      await api('/api/registration', { method: 'POST', body: JSON.stringify({ username, email, password }) });
      await api('/api/auth/sign-in/identifier', { method: 'POST', body: JSON.stringify({ identifier: username, password }) });
      await invalidateAll();
      await goto('/waiting');
    } catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
</script>
<svelte:head><title>{$t.registration} · Torrents Duck</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class="auth-page"><section class="auth-card"><a class="brand" href="/login"><span class="duck-mark" aria-hidden="true"><Icon name="duck" size={28} /></span><span>Torrents<span class="brand-light">Duck</span></span></a><h1>{$t.registration}</h1>{#if error}<div class="notice error" role="alert">{error}</div>{/if}<form onsubmit={submit} class="form-stack"><label>{$t.username}<input bind:value={username} required maxlength={128} autocomplete="username" /></label><label>{$t.email}<input type="email" bind:value={email} required autocomplete="email" /></label><label>{$t.password}<input type="password" bind:value={password} required minlength={12} maxlength={128} autocomplete="new-password" aria-describedby="password-length" /><small id="password-length">{$t.passwordLength}</small></label><label>{$t.confirmPassword}<input type="password" bind:value={confirmation} required minlength={12} maxlength={128} autocomplete="new-password" /></label><button class="primary" disabled={busy}>{busy ? $t.creating : $t.register}</button></form><div class="auth-links"><a href="/login">{$t.login}</a></div></section></div>
