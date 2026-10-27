<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/client.js';
  import { t } from '#lib/i18n.js';
  import QuackLogo from '#lib/QuackLogo.svelte';
  import Notification from '#lib/Notification.svelte';
  let { data } = $props();
  let busy = $state(false); let ready = $state(false); let error = $state(''); let result = $state<'approved' | 'denied' | ''>('');
  let stopped = false;
  const eligible = $derived(data.user?.enabled && data.user.approved);

  onMount(() => {
    if (data.userCode && eligible) void verifyCode();
    return () => { stopped = true; };
  });

  async function verifyCode() {
    busy = true; error = '';
    try {
      const device = await api<{ user_code: string; status: string; client_id?: string }>(`/api/auth/device?user_code=${encodeURIComponent(data.userCode)}`);
      if (stopped) return;
      ready = device.user_code === data.userCode && device.status === 'pending' && device.client_id === 'torrents-duck-tv';
      if (!ready) error = $t.deviceUnavailable;
    } catch { if (!stopped) error = $t.deviceUnavailable; }
    finally { if (!stopped) busy = false; }
  }

  async function decide(approve: boolean) {
    busy = true; error = '';
    try {
      await api(`/api/auth/device/${approve ? 'approve' : 'deny'}`, { method: 'POST', body: JSON.stringify({ userCode: data.userCode }) });
      if (!stopped) { result = approve ? 'approved' : 'denied'; ready = false; }
    } catch { if (!stopped) { error = $t.deviceUnavailable; ready = false; } }
    finally { if (!stopped) busy = false; }
  }
</script>

<svelte:head><title>{$t.deviceApprove} · TorrentsDuck2</title><meta name="robots" content="noindex,nofollow" /><meta name="referrer" content="no-referrer" /></svelte:head>
<div class="auth-page">
  <section class="auth-card">
    <QuackLogo />
    <h1>{$t.deviceApprove}</h1>
    {#if !data.userCode}<p class="notice error" role="alert">{$t.deviceUnavailable}</p>
    {:else if !eligible}
      <p class="subtitle">{$t.deviceAccountRequired}</p>
      <a class="button primary" href={data.user?.enabled ? '/waiting' : `/login?user_code=${encodeURIComponent(data.userCode)}`}>{data.user?.enabled ? $t.waiting : $t.login}</a>
    {:else if result}
      <p class="notice success" role="status">{result === 'approved' ? $t.deviceApproved : $t.deviceDenied}</p>
      <a class="button secondary" href="/">{$t.library}</a>
    {:else}
      <p class="subtitle">{$t.deviceAccount} <strong>{data.user?.username}</strong></p>
      <div class="device-code">{data.userCode}</div>
      <p class="security-help">{$t.deviceSecurity}</p>
      <Notification bind:message={error} kind="error" />
      <div class="form-stack">
        {#if ready}
          <button class="primary" disabled={busy} onclick={() => decide(true)}>{busy ? $t.signingIn : $t.deviceApprove}</button>
          <button class="secondary" disabled={busy} onclick={() => decide(false)}>{$t.deviceReject}</button>
        {:else if busy}<p role="status">{$t.loadingPage}</p>
        {:else}<button class="secondary" onclick={verifyCode}>{$t.deviceRetry}</button>{/if}
      </div>
    {/if}
  </section>
</div>

<style>
  .device-code { text-align: center; padding: 20px 16px; background: var(--secondary-container); color: var(--on-secondary-container); border-radius: var(--shape-lg); font-size: 30px; font-weight: 600; letter-spacing: 3px; overflow-wrap: anywhere; }
  .security-help { color: var(--muted); font-size: 14px; line-height: 1.6; margin: 24px 0; }
</style>
