<script lang="ts">
  import { t } from '#lib/i18n.js';
  import { api } from '#lib/client.js';
  let currentPassword = $state(''); let password = $state(''); let confirmation = $state(''); let busy = $state(false); let error = $state(''); let success = $state(false);
  async function submit(event: SubmitEvent) { event.preventDefault(); error = ''; success = false; if (password !== confirmation) { error = $t.passwordMismatch; return; } busy = true; try { await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword: password, revokeOtherSessions: true }) }); currentPassword = ''; password = ''; confirmation = ''; success = true; } catch (e) { error = (e as Error).message; } finally { busy = false; } }
</script>
<svelte:head><title>{$t.account} · Torrents Duck</title></svelte:head>
<div class="page-heading"><h1>{$t.account}</h1></div>
<section class="stat-card" style="max-width:520px"><h2>{$t.changePassword}</h2><p class="subtitle">{$t.ftpsDisconnect}</p>{#if error}<div class="notice error" role="alert">{error}</div>{/if}{#if success}<div class="notice success" role="status">{$t.passwordChanged}</div>{/if}<form onsubmit={submit} class="form-stack"><label>{$t.currentPassword}<input type="password" bind:value={currentPassword} autocomplete="current-password" required maxlength={1024} /></label><label>{$t.newPassword}<input type="password" bind:value={password} autocomplete="new-password" required minlength={12} maxlength={128} /></label><label>{$t.confirmPassword}<input type="password" bind:value={confirmation} autocomplete="new-password" required minlength={12} maxlength={128} /></label><button class="primary" disabled={busy}>{$t.save}</button></form></section>
