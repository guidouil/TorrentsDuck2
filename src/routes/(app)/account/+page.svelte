<script lang="ts">
  import Notification from '#lib/Notification.svelte';
  import { t } from '#lib/i18n.js';
  import { api } from '#lib/client.js';
  let currentPassword = $state(''); let password = $state(''); let confirmation = $state(''); let busy = $state(false); let error = $state(''); let success = $state(false);
  async function submit(event: SubmitEvent) { event.preventDefault(); error = ''; success = false; if (password !== confirmation) { error = $t.passwordMismatch; return; } busy = true; try { await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword: password, revokeOtherSessions: true }) }); currentPassword = ''; password = ''; confirmation = ''; success = true; } catch (e) { error = (e as Error).message; } finally { busy = false; } }
</script>
<svelte:head><title>{$t.account} · Torrents Duck</title></svelte:head>
<h1 class="sr-only">{$t.account}</h1>
<section class="stat-card account-card"><h2>{$t.changePassword}</h2><p class="subtitle">{$t.ftpsDisconnect}</p><Notification bind:message={error} kind="error" /><Notification message={success ? $t.passwordChanged : ''} kind="success" /><form onsubmit={submit} class="form-stack"><label>{$t.currentPassword}<input type="password" bind:value={currentPassword} autocomplete="current-password" required maxlength={1024} /></label><label>{$t.newPassword}<input type="password" bind:value={password} autocomplete="new-password" required minlength={12} maxlength={128} /></label><label>{$t.confirmPassword}<input type="password" bind:value={confirmation} autocomplete="new-password" required minlength={12} maxlength={128} /></label><button class="primary" disabled={busy}>{$t.save}</button></form></section>

<style>
  .account-card { max-width: 640px; }
  h2 { margin-bottom: 8px; font-size: 24px; }
  .subtitle { margin-bottom: 24px; }
  .form-stack > button { justify-self: start; }
  @media(max-width: 480px) { .form-stack > button { width: 100%; } }
</style>
