<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto, invalidateAll } from '$app/navigation';
  import qrcode from 'qrcode-generator';
  import { t } from '#lib/i18n.js';
  import { api, duration } from '#lib/client.js';
  import QuackLogo from '#lib/QuackLogo.svelte';
  import Notification from '#lib/Notification.svelte';

  let identifier = $state(''); let password = $state(''); let error = $state(''); let busy = $state(false); let reset = $state(false); let email = $state(''); let sent = $state(false);
  let phone = $state(false); let phoneBusy = $state(false); let qrImage = $state(''); let userCode = $state(''); let remaining = $state(0);
  let deviceStatus = $state<'waiting' | 'expired' | 'denied' | 'error'>('waiting'); let reconnecting = $state(false);
  let generation = 0;
  let controller: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  const returnCode = $derived(page.url.searchParams.get('user_code') ?? '');

  onMount(() => stopDevice);

  function stopDevice() {
    generation++;
    controller?.abort();
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
  }

  function cancelDevice() { stopDevice(); phone = false; phoneBusy = false; qrImage = ''; }

  async function startDevice() {
    stopDevice();
    const current = generation;
    controller = new AbortController();
    const signal = controller.signal;
    phone = true; phoneBusy = true; qrImage = ''; userCode = ''; error = ''; reconnecting = false; deviceStatus = 'waiting';
    try {
      const device = await api<{ device_code: string; user_code: string; expires_in: number; interval: number }>('/api/auth/device/code', { method: 'POST', body: JSON.stringify({ client_id: 'torrents-duck-tv' }), signal });
      if (current !== generation) return;
      const verificationUrl = new URL('/login/device', window.location.origin);
      verificationUrl.searchParams.set('user_code', device.user_code);
      const qr = qrcode(0, 'M');
      qr.addData(verificationUrl.href); qr.make();
      qrImage = `data:image/svg+xml,${encodeURIComponent(qr.createSvgTag({ cellSize: 6, margin: 24, scalable: true }))}`;
      userCode = device.user_code;
      const expires = Date.now() + device.expires_in * 1000;
      let interval = Math.max(5, device.interval) * 1000;
      remaining = device.expires_in;
      clockTimer = setInterval(() => {
        remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
        if (!remaining) { stopDevice(); deviceStatus = 'expired'; }
      }, 1000);
      async function poll() {
        try {
          const response = await fetch('/api/auth/device/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'torrents-duck-tv', device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }), signal });
          const result = await response.json();
          if (current !== generation) return;
          reconnecting = false;
          if (response.ok) { stopDevice(); await goto('/', { refreshAll: true, replace: true }); return; }
          if (result.error === 'slow_down') interval += 5000;
          else if (result.error !== 'authorization_pending') {
            if (response.status >= 500 || response.status === 429) reconnecting = true;
            else { stopDevice(); deviceStatus = result.error === 'expired_token' ? 'expired' : result.error === 'access_denied' ? 'denied' : 'error'; return; }
          }
        } catch {
          if (current !== generation) return;
          reconnecting = true;
        }
        if (current === generation) pollTimer = setTimeout(poll, interval);
      }
      pollTimer = setTimeout(poll, interval);
    } catch (e) {
      if (current !== generation) return;
      error = (e as Error).message; deviceStatus = 'error';
    } finally { if (current === generation) phoneBusy = false; }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault(); busy = true; error = '';
    try {
      if (reset) { await api('/api/auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email, redirectTo: `${window.location.origin}/reset-password` }) }); sent = true; }
      else {
        await api('/api/auth/sign-in/identifier', { method: 'POST', body: JSON.stringify({ identifier, password }) });
        await invalidateAll();
        await goto(/^[A-Za-z0-9-]{4,32}$/.test(returnCode) ? `/login/device?user_code=${encodeURIComponent(returnCode)}` : '/');
      }
    } catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
</script>

<svelte:head><title>{$t.login} · TorrentsDuck2</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class={['auth-page', { 'device-page': phone && qrImage && deviceStatus === 'waiting' }]}>
  {#if phone && qrImage && deviceStatus === 'waiting'}
    <img class="qr-code" src={qrImage} alt={$t.deviceQrAlt} width="256" height="256" />
  {/if}
  <section class="auth-card">
    <QuackLogo />
    <h1>{phone ? $t.deviceLogin : reset ? $t.resetPassword : $t.login}</h1>
    <Notification bind:message={error} kind="error" />
    {#if phone}
      <div class="device-login">
        {#if phoneBusy}<p role="status">{$t.creating}</p>
        {:else if deviceStatus === 'waiting'}
          <p>{$t.deviceScan}</p>
          <span class="device-code">{userCode}</span>
          <p class="device-status" role="status">{reconnecting ? $t.connecting : $t.deviceWaiting}<br />{$t.deviceExpires} {duration(remaining)}</p>
        {:else}
          <p role="status">{deviceStatus === 'expired' ? $t.deviceExpired : deviceStatus === 'denied' ? $t.deviceDenied : $t.deviceUnavailable}</p>
          <button class="primary" onclick={startDevice}>{$t.deviceNewCode}</button>
        {/if}
        <button class="secondary" onclick={cancelDevice}>{$t.backLogin}</button>
      </div>
    {:else}
      {#if returnCode && !reset}<p class="subtitle">{$t.deviceSignInFirst}</p>{/if}
      <Notification message={sent ? $t.resetSent : ''} kind="success" />
      {#if !sent}
        <form class="form-stack" onsubmit={submit}>
          {#if reset}<label>{$t.email}<input type="email" required bind:value={email} autocomplete="email" /></label>
          {:else}<label>{$t.identifier}<input required bind:value={identifier} autocomplete="username" /></label><label>{$t.password}<input type="password" required bind:value={password} autocomplete="current-password" maxlength={1024} /></label>{/if}
          <button class="primary" disabled={busy}>{busy ? $t.signingIn : reset ? $t.receiveLink : $t.login}</button>
        </form>
      {/if}
      {#if !reset && !returnCode}<button class="secondary phone-button" disabled={busy} onclick={startDevice}>{$t.deviceLogin}</button>{/if}
      <div class="auth-links"><a href="/register">{$t.register}</a><button onclick={() => { reset = !reset; error = ''; sent = false; }}>{reset ? $t.backLogin : $t.forgotPassword}</button></div>
    {/if}
  </section>
</div>

<style>
  .phone-button { width: 100%; margin-top: 16px; }
  .device-page { grid-template-columns: minmax(0, calc(100dvh - 32px)) minmax(280px, 380px); justify-content: center; gap: 32px; padding: 16px 24px; }
  .device-page .auth-card { width: 100%; }
  .device-login { display: grid; justify-items: center; gap: 16px; text-align: center; }
  .device-login p { margin: 0; font-size: 14px; line-height: 1.6; color: var(--muted); }
  .device-login > button { width: 100%; }
  .qr-code { display: block; width: 100%; height: auto; background: white; border-radius: var(--shape-lg); }
  .device-code { padding: 8px 16px; background: var(--secondary-container); color: var(--on-secondary-container); border-radius: var(--shape-md); font-size: 28px; font-weight: 600; letter-spacing: 3px; overflow-wrap: anywhere; }
  .device-status { min-height: 3em; }
  @media (max-width: 700px) {
    .device-page { grid-template-columns: minmax(0, 460px); gap: 24px; padding: 88px 24px 32px; }
    .qr-code { max-width: calc(100dvh - 120px); }
  }
</style>
