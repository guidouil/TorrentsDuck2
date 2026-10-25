<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/client.js';
  import { language, t } from '#lib/i18n.js';
  import Icon from '#lib/Icon.svelte';
  import Notification from '#lib/Notification.svelte';
  import Diagnostic from '#lib/Diagnostic.svelte';

  type Source = { id: string; name: string; url: string; description?: { fr: string; en: string }; installed: boolean; enabled: boolean; kind?: 'plugin' | 'url'; format?: 'json' | 'rss' | 'html'; hasAuth?: boolean; available?: boolean };
  type SourceResponse = { ok: boolean; source?: Source; diagnostic?: string };
  type AuthType = 'none' | 'basic' | 'bearer' | 'apiKey';
  let { data } = $props();
  let sources = $state<Source[]>([]);
  let loading = $state(true);
  let busy = $state('');
  let error = $state('');
  let canManage = $derived(data.user?.role === 'admin' || !!data.user?.canManageSources);
  let name = $state('');
  let url = $state('');
  let authType = $state<AuthType>('none');
  let username = $state('');
  let password = $state('');
  let token = $state('');
  let diagnostic = $state('');
  let notice = $state('');
  let disposed = false;

  async function load() {
    try {
      const value = await api<{ sources: Source[]; canManage: boolean }>('/api/search/sources');
      if (disposed) return;
      sources = value.sources;
      canManage = value.canManage;
    } catch (cause) { if (!disposed) failure(cause, 'list'); }
    finally { if (!disposed) loading = false; }
  }

  function failure(cause: unknown, operation: string) {
    const value = cause as Error & { diagnostic?: string };
    error = value?.message || $t.sourceRequestFailed;
    diagnostic = typeof value?.diagnostic === 'string' ? value.diagnostic : JSON.stringify({ version: 1, phase: 'client', operation, code: 'SOURCE_REQUEST_FAILED' }, null, 2);
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !canManage || !name.trim() || !url.trim()) return;
    busy = 'add'; error = ''; notice = ''; diagnostic = '';
    try {
      const auth = authType === 'basic' ? { type: authType, username, password } : authType === 'none' ? { type: authType } : { type: authType, token };
      const value = await api<SourceResponse>('/api/search/sources', { method: 'POST', body: JSON.stringify({ action: 'add', name: name.trim(), url: url.trim(), auth }) });
      if (disposed) return;
      name = ''; url = ''; username = ''; password = ''; token = ''; authType = 'none';
      diagnostic = value.diagnostic ?? '';
      notice = $t.sourceAdded;
      await load();
    } catch (cause) { if (!disposed) failure(cause, 'add'); }
    finally { if (!disposed) busy = ''; }
  }

  async function update(id: string, action: 'install' | 'enable' | 'disable' | 'uninstall' | 'test') {
    if (busy || !canManage || sources.some((source) => source.id === id && source.kind !== 'url' && source.available === false)) return;
    busy = id;
    error = ''; notice = ''; diagnostic = '';
    try {
      const value = await api<SourceResponse>('/api/search/sources', { method: 'POST', body: JSON.stringify({ id, action }) });
      if (disposed) return;
      diagnostic = value.diagnostic ?? '';
      if (action === 'test') notice = $t.sourceTestPassed;
      else await load();
    } catch (cause) { if (!disposed) failure(cause, action); }
    finally { if (!disposed) busy = ''; }
  }

  onMount(() => { void load(); return () => { disposed = true; }; });
</script>

<svelte:head><title>{$t.searchManageSources} · Torrents Duck</title></svelte:head>
<header class="sources-heading"><a class="quiet-button" href="/search"><Icon name="chevron-left" size={18} />{$t.searchPage}</a><h1>{$t.searchManageSources}</h1><p class="subtitle">{$t.searchSourcesHelp}</p></header>
<Notification bind:message={error} kind="error" />
<Notification bind:message={notice} kind="success" />
<section class="panel source-add" aria-label={$t.sourceAddUrl}>
  <h2>{$t.sourceAddUrl}</h2>
  <p class="subtitle">{$t.sourceUrlHelp}</p>
  <form onsubmit={add}>
    <fieldset disabled={!!busy || !canManage}>
      <label>{$t.name}<input bind:value={name} required maxlength={100} autocomplete="off" /></label>
      <label>{$t.sourceSearchUrl}<input type="url" bind:value={url} required maxlength={4096} placeholder={'https://example.org/search?q={query}'} autocomplete="off" aria-describedby="source-url-help" /></label>
      <small id="source-url-help">{$t.sourceQueryHelp}</small>
      <label>{$t.sourceAuthentication}<select bind:value={authType}><option value="none">{$t.sourceAuthNone}</option><option value="basic">{$t.sourceAuthBasic}</option><option value="bearer">{$t.sourceAuthBearer}</option><option value="apiKey">{$t.sourceAuthApiKey}</option></select></label>
      {#if authType === 'basic'}
        <div class="source-credentials"><label>{$t.sourceLogin}<input bind:value={username} required maxlength={1024} autocomplete="off" /></label><label>{$t.password}<input type="password" bind:value={password} required maxlength={1024} autocomplete="new-password" /></label></div>
      {:else if authType === 'bearer' || authType === 'apiKey'}
        <label>{authType === 'bearer' ? $t.sourceAuthBearer : $t.sourceAuthApiKey}<input type="password" bind:value={token} required maxlength={2048} autocomplete="new-password" /></label>
      {/if}
      <p class="subtitle">{$t.sourceAuthHelp}</p>
      <button class="primary" disabled={!!busy || !canManage || !name.trim() || !url.trim()} aria-busy={busy === 'add'}><Icon name="plus" size={18} />{busy === 'add' ? $t.sourceAnalyzing : $t.sourceAnalyzeAdd}</button>
    </fieldset>
  </form>
</section>
{#if diagnostic}
  <Diagnostic text={diagnostic} />
{/if}
<section class="panel sources-panel" aria-label={$t.searchManageSources} aria-busy={loading || !!busy}>
  {#if loading}
    <div class="empty" role="status"><p>{$t.loading}</p></div>
  {:else if !sources.length}
    <div class="empty"><p>{$t.searchSourcesEmpty}</p><button class="secondary" onclick={() => { loading = true; error = ''; void load(); }}>{$t.deviceRetry}</button></div>
  {:else}
    {#each sources as source (source.id)}
      {@const unavailable = source.kind !== 'url' && source.available === false}
      <article class="source-row">
        <div class="source-detail"><h2><a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}<Icon name="share" size={14} /></a></h2>{#if source.description}<p>{source.description[$language]}</p>{/if}<div class="source-badges"><span class={['badge', { good: !unavailable && source.installed && source.enabled }]}>{unavailable ? $t.engineUnavailable : !source.installed ? $t.sourceMissing : source.enabled ? $t.sourceActive : $t.sourceInactive}</span>{#if source.format}<span class="badge">{source.format.toUpperCase()}</span>{/if}{#if source.hasAuth}<span class="badge">{$t.sourceAuthenticated}</span>{/if}</div></div>
        <div class="source-actions">
          {#if source.installed}
            {#if source.kind === 'url'}<button class="secondary" disabled={!!busy || !canManage} onclick={() => update(source.id, 'test')}>{$t.sourceTest}</button>{/if}
            <button class="secondary" disabled={!!busy || !canManage || unavailable} onclick={() => update(source.id, source.enabled ? 'disable' : 'enable')}>{source.enabled ? $t.disable : $t.allow}</button>
            <button class="quiet-button" disabled={!!busy || !canManage || unavailable} onclick={() => update(source.id, 'uninstall')}>{source.kind === 'url' ? $t.sourceRemove : $t.sourceUninstall}</button>
          {:else}
            <button class="primary" disabled={!!busy || !canManage || unavailable} onclick={() => update(source.id, 'install')}><Icon name="plus" size={18} />{$t.sourceInstall}</button>
          {/if}
        </div>
      </article>
    {/each}
  {/if}
</section>

<style>
  .sources-heading{margin-bottom:20px}
  .sources-heading>a{padding-left:0;margin-bottom:8px}
  .sources-heading .subtitle{margin-top:12px;max-width:720px}
  .source-add{padding:20px;margin-bottom:20px}
  .source-add h2{font-size:20px}
  .source-add form{margin-top:20px}
  fieldset{border:0;padding:0;margin:0;display:grid;gap:16px;min-width:0}
  .source-credentials{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  fieldset>button{justify-self:start}
  small{color:var(--muted)}
  .source-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:20px}
  .source-row+.source-row{border-top:1px solid var(--line)}
  .source-detail{min-width:0}
  h2{font-size:18px;margin-bottom:6px}
  h2 a:hover{color:var(--accent-ink);text-decoration:underline}
  h2 :global(svg){margin-left:6px}
  .source-detail p{color:var(--muted);margin:0 0 12px;overflow-wrap:anywhere}
  .source-actions{display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap}
  .source-badges{display:flex;gap:8px;flex-wrap:wrap}
  @media(max-width:700px){
    .source-row{align-items:start;flex-direction:column;gap:16px;padding:20px 0}
    .source-actions{width:100%}
    .source-add{padding:20px 0}
    .source-credentials{grid-template-columns:1fr}
  }
</style>
