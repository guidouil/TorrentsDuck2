<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { api } from '#lib/client.js';
  import { t } from '#lib/i18n.js';
  import QuackLogo from '#lib/QuackLogo.svelte';
  import Notification from '#lib/Notification.svelte';
  let { data } = $props();
  let error = $state(''); let busy = $state(false); let sent = $state(false);
  const verificationRequired = $derived(data.user?.role === 'admin' && !data.user.emailVerified);
  const verificationError = $derived(verificationRequired && page.url.searchParams.has('error') && !sent ? $t.invalidVerification : '');
  onMount(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function checkApproval() {
      try {
        const session = await api('/api/auth/get-session?disableCookieCache=true');
        if (stopped) return;
        if (!session?.user?.enabled || session.user.approved) {
          await goto(session?.user?.enabled ? '/' : '/login', { refreshAll: true, replace: true });
          return;
        }
      } catch { /* Keep the waiting screen while the connection is unavailable. */ }
      if (!stopped) timer = setTimeout(checkApproval, 2000);
    }
    void checkApproval();
    return () => { stopped = true; clearTimeout(timer); };
  });
  async function resendVerification() {
    busy = true; error = ''; sent = false;
    try {
      await api('/api/auth/send-verification-email', { method: 'POST', body: JSON.stringify({ email: data.user?.email, callbackURL: '/waiting' }) });
      sent = true;
    } catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
  async function logout() {
    busy = true; error = '';
    try { await api('/api/auth/sign-out', { method: 'POST', body: '{}' }); await goto('/login', { invalidateAll: true }); }
    catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
</script>
<svelte:head><title>{verificationRequired ? $t.verifyEmail : $t.waiting} · TorrentsDuck2</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<main class="auth-page">
  <section class="auth-card waiting-card">
    <QuackLogo />
    <h1>{verificationRequired ? $t.verifyEmail : $t.waiting}</h1>
    {#if verificationRequired}
      <p class="subtitle">{$t.verificationHelp}<br /><strong>{data.user?.email}</strong></p>
      <Notification message={sent ? $t.verificationSent : ''} kind="success" />
      <button class="primary" disabled={busy} onclick={resendVerification}>{$t.resendVerification}</button>
    {/if}
    <Notification message={error || verificationError} kind="error" />
    <button class="secondary" disabled={busy} onclick={logout}>{$t.logout}</button>
  </section>
</main>

<style>
  .waiting-card { text-align: center; }
  .waiting-card :global(.brand) { margin-inline: auto; }
  .waiting-card strong { overflow-wrap: anywhere; }
  .waiting-card > button { width: 100%; margin-top: 16px; }
</style>
