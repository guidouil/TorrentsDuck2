<script lang="ts">
  import Notification from '#lib/Notification.svelte';
  import { onMount } from 'svelte';
  import { api } from '#lib/client.js';
  import { language, t } from '#lib/i18n.js';
  import Modal from '#lib/Modal.svelte';
  let { data } = $props();
  let users = $state<any[]>([]); let backup = $state<any>(null); let error = $state(''); let busy = $state(false); let loading = $state(true); let query = $state('');
  type UserChange = { user: any; approved?: boolean; enabled?: boolean; role?: string; canManageSources?: boolean; delete?: boolean };
  let changeOpen = $state(false); let change = $state<UserChange | null>(null);
  const filtered = $derived(users.filter((u) => `${u.username} ${u.email}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  async function load() { try { const [members, backups] = await Promise.all([api('/api/admin/users'), api('/api/admin/backup')]); users = members.users; backup = backups.backup; } catch (e) { error = (e as Error).message; } finally { loading = false; } }
  onMount(() => { void load(); });
  function ask(user: any, update: Omit<UserChange, 'user'>) { error = ''; change = { user, ...update }; changeOpen = true; }
  async function updateUser(update = change) { if (!update) return; busy = true; error = ''; try { if (update.delete) { await api(`/api/admin/users/${encodeURIComponent(update.user.id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }); } else { await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ id: update.user.id, ...(update.approved !== undefined ? { approved: update.approved } : {}), ...(update.enabled !== undefined ? { enabled: update.enabled } : {}), ...(update.role ? { role: update.role } : {}), ...(update.canManageSources !== undefined ? { canManageSources: update.canManageSources } : {}) }) }); } changeOpen = false; await load(); } catch (e) { error = (e as Error).message; } finally { busy = false; } }
</script>
<svelte:head><title>{$t.admin} · TorrentsDuck2</title></svelte:head>
<h1 class="sr-only">{$t.admin}</h1>
<Notification bind:message={error} kind="error" />
<section class="stat-card backup-card">
  <h2>{$t.backup}</h2>
  {#if loading}
    <p class="muted">{$t.loadingPage}</p>
  {:else if backup}
    <div>{new Date(backup.completedAt).toLocaleString($language)}</div>
    <p class="stat-foot">{$t.backupConfirmed}</p>
  {:else}
    <div class="notice error">{$t.noBackup}</div>
  {/if}
  <p class="subtitle backup-help">{$t.backupHelp}</p>
</section>
<section class="panel" aria-label={$t.members} aria-busy={loading}>
  <div class="toolbar">
    <input class="search" type="search" placeholder={$t.search} aria-label={$t.search} bind:value={query} />
    <div class="spacer"></div>
    <span class="badge">{users.length} {$t.members.toLocaleLowerCase()}</span>
  </div>
  {#if loading}
    <div class="empty"><p>{$t.loadingPage}</p></div>
  {:else if !filtered.length}
    <div class="empty" role="status"><p>{$t.noResults}</p></div>
  {:else}
    <div class="table-wrap members-wrap">
      <!-- Preserve table semantics in Safari when mobile CSS changes display. -->
      <!-- svelte-ignore a11y_no_redundant_roles -->
      <table class="members-table" role="table">
        <thead><tr><th scope="col">{$t.username}</th><th scope="col">{$t.email}</th><th scope="col">{$t.since}</th><th scope="col">{$t.role}</th><th scope="col">{$t.state}</th><th scope="col">{$t.actions}</th></tr></thead>
        <tbody>
          {#each filtered as user (user.id)}
            <tr>
              <td class="member-name" role="cell"><strong>{user.username}</strong></td>
              <td class="member-email muted" role="cell">{user.email}</td>
              <td class="member-since muted" role="cell"><span class="mobile-label" aria-hidden="true">{$t.since}</span>{new Date(user.createdAt).toLocaleDateString($language)}</td>
              <td class="member-role" role="cell"><span class="mobile-label" aria-hidden="true">{$t.role}</span><div>{user.role === 'admin' ? $t.administrator : $t.member}{#if user.role !== 'admin' && user.canManageSources}<small class="muted">{$t.sourceManager}</small>{/if}</div></td>
              <td class="member-state" role="cell"><span class={['badge', { good: user.enabled && user.approved }]}>{!user.enabled ? $t.disabled : !user.approved ? $t.pending : $t.enabled}</span></td>
              <td class="member-actions" role="cell">
                {#if user.id !== data.user?.id}
                  <div class="row-actions">
                    {#if !user.approved}<button class="quiet-button" disabled={busy} onclick={() => updateUser({ user, approved: true })}>{$t.approve}</button>{/if}
                    <button class="quiet-button" disabled={busy} onclick={() => ask(user, { enabled: !user.enabled })}>{user.enabled ? $t.disable : $t.allow}</button>
                    <button class="quiet-button" disabled={busy} onclick={() => ask(user, { role: user.role === 'admin' ? 'member' : 'admin' })}>{user.role === 'admin' ? $t.makeMember : $t.makeAdmin}</button>
                    {#if user.role !== 'admin'}<button class="quiet-button" disabled={busy} onclick={() => ask(user, { canManageSources: !user.canManageSources })}>{user.canManageSources ? $t.revokeSourceManagement : $t.grantSourceManagement}</button>{/if}
                    <button class="quiet-button danger" disabled={busy} onclick={() => ask(user, { delete: true })}>{$t.deleteAccount}</button>
                  </div>
                {:else}<span class="muted">{$t.you}</span>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
<Modal bind:open={changeOpen} title={change?.delete ? $t.deleteAccount : $t.changePermissions}>{#if change}<p>{change.delete ? $t.confirmDeleteAccount : $t.confirmPermissions} <strong>{change.user.username}</strong> ?</p>{#if change.delete}<p>{$t.deleteAccountHelp}</p>{:else if change.enabled === false}<p>{$t.revokeWeb}</p>{/if}{#if change.canManageSources !== undefined}<p>{$t.sourceManagementHelp}</p>{/if}{#if change.delete || change.enabled === false}<p>{$t.ftpsDisconnect}</p>{/if}<div class="dialog-actions"><button class="secondary" onclick={() => { changeOpen = false; }}>{$t.cancel}</button><button class={['primary', { destructive: change.delete || change.enabled === false }]} disabled={busy} onclick={() => updateUser()}>{change.delete ? $t.deletePermanently : $t.confirm}</button></div>{/if}</Modal>

<style>
  .backup-card{margin-bottom:16px}
  .backup-help{margin-top:16px}
  .members-table{table-layout:fixed}
  .members-table th,.members-table td{padding:8px 12px}
  .members-table th:nth-child(1){width:15%}
  .members-table th:nth-child(2){width:22%}
  .members-table th:nth-child(3){width:12%}
  .members-table th:nth-child(4){width:13%}
  .members-table th:nth-child(5){width:12%}
  .members-table th:nth-child(6){width:26%}
  .members-table td{overflow-wrap:anywhere}
  .row-actions{flex-wrap:wrap;justify-content:flex-start;gap:4px}
  .row-actions button{font-size:12px;text-align:left}
  .mobile-label{display:none}
  @media(max-width:1100px){
    .members-wrap{padding:12px;overflow:visible}
    .members-table,.members-table tbody{display:block}
    .members-table thead{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
    .members-table tbody{display:grid;gap:12px}
    .members-table tbody tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 12px;padding:12px;background:var(--surface-container);border:0;border-radius:var(--shape-lg)}
    .members-table td{display:block;min-width:0;padding:0;border:0;font-size:13px}
    .members-table .member-name{grid-column:1;grid-row:1;align-self:center;font-size:15px}
    .members-table .member-state{grid-column:2;grid-row:1;align-self:center;text-align:right}
    .members-table .member-email{grid-column:1/-1}
    .members-table .member-since,.members-table .member-role{display:grid;gap:5px}
    .mobile-label{display:block;font-size:12px;color:var(--muted)}
    .member-state .badge{white-space:normal;text-align:center;max-width:120px}
    .members-table .member-actions{grid-column:1/-1;border-top:1px solid var(--line);padding-top:12px}
    .row-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .row-actions button{min-height:44px;padding:10px 14px;text-align:center;font-size:13px;overflow-wrap:anywhere}
  }
  @media(max-width:700px){
    .members-wrap{padding:0}
    .members-table tbody{gap:0}
    .members-table tbody tr{padding:12px 0;background:transparent;border-bottom:1px solid var(--line);border-radius:0}
  }
</style>
