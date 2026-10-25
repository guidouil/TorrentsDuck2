<script lang="ts">
  import { onMount } from 'svelte';
  import { api, bytes } from '#lib/client.js';
  import { language, t } from '#lib/i18n.js';
  import Icon from '#lib/Icon.svelte';
  import Notification from '#lib/Notification.svelte';
  import Diagnostic from '#lib/Diagnostic.svelte';

  type Source = { id: string; name: string; installed: boolean; enabled: boolean };
  type Result = { name: string; size: number; seeders: number; leechers: number; url: string; descriptionUrl: string; source: string; publishedAt: number | null };
  type Filters = { sort: string; minSeeders?: number; minSize?: number; maxSize?: number };
  let { data } = $props();
  let sources = $state<Source[]>([]);
  let canManage = $derived(data.user?.role === 'admin' || !!data.user?.canManageSources);
  let sourcesLoading = $state(true);
  let query = $state('');
  let source = $state('');
  let searchId = $state('');
  let results = $state<Result[]>([]);
  let total = $state(0);
  let running = $state(false);
  let starting = $state(false);
  let fetching = $state(false);
  let interrupted = $state(false);
  let searched = $state(false);
  let currentPage = $state(1);
  let sort = $state('seeders');
  let minSeeders = $state<number | undefined>();
  let minSize = $state<number | undefined>();
  let maxSize = $state<number | undefined>();
  let filters = $state<Filters>({ sort: 'seeders' });
  let truncated = $state(false);
  let adding = $state('');
  let added = $state<string[]>([]);
  let error = $state('');
  let notice = $state('');
  let diagnostic = $state('');
  let sourceDiagnostics = $state<{ source: string; message: string; diagnostic: string }[]>([]);
  let version = 0;
  let requestVersion = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const enabledSources = $derived(sources.filter((item) => item.installed && item.enabled));
  const pages = $derived(Math.max(1, Math.ceil(total / 100)));

  async function loadSources() {
    sourcesLoading = true;
    error = '';
    try {
      const value = await api<{ sources: Source[]; canManage: boolean }>('/api/search/sources');
      if (disposed) return;
      sources = value.sources;
      canManage = value.canManage;
    } catch (cause) { if (!disposed) error = (cause as Error).message; }
    finally { if (!disposed) sourcesLoading = false; }
  }

  function removeSearch(id: string) {
    return api('/api/search', { method: 'DELETE', body: JSON.stringify({ id }), keepalive: true }).catch(() => {});
  }

  async function poll(id: string, run: number) {
    const request = ++requestVersion;
    fetching = true;
    try {
      const params = new URLSearchParams({ id, offset: String((currentPage - 1) * 100), sort: filters.sort });
      if (filters.minSeeders !== undefined) params.set('minSeeders', String(filters.minSeeders));
      if (filters.minSize !== undefined) params.set('minSize', String(filters.minSize));
      if (filters.maxSize !== undefined) params.set('maxSize', String(filters.maxSize));
      const value = await api<{ results: Result[]; total: number; running: boolean; truncated: boolean; diagnostics?: { source: string; message: string; diagnostic: string }[] }>(`/api/search?${params}`);
      if (disposed || run !== version || request !== requestVersion) return;
      results = value.results;
      total = value.total;
      running = value.running;
      truncated = value.truncated;
      sourceDiagnostics = value.diagnostics ?? [];
      interrupted = false;
      error = '';
      if (running) timer = setTimeout(() => { void poll(id, run); }, 1500);
    } catch (cause) {
      if (disposed || run !== version || request !== requestVersion) return;
      running = false;
      interrupted = true;
      error = (cause as Error).message;
      diagnostic = failureReport(cause, 'search-results');
    } finally {
      if (!disposed && run === version && request === requestVersion) fetching = false;
    }
  }

  async function startSearch(event: SubmitEvent) {
    event.preventDefault();
    if (starting || !query.trim() || !enabledSources.length) return;
    const run = ++version;
    clearTimeout(timer);
    requestVersion++;
    const previous = searchId;
    searchId = '';
    starting = true;
    running = false;
    fetching = false;
    searched = true;
    interrupted = false;
    results = [];
    total = 0;
    truncated = false;
    currentPage = 1;
    error = '';
    notice = '';
    diagnostic = ''; sourceDiagnostics = [];
    try {
      if (previous) await removeSearch(previous);
      if (disposed || run !== version) return;
      const value = await api<{ id: string }>('/api/search', { method: 'POST', body: JSON.stringify({ query: query.trim(), ...(source ? { source } : {}) }) });
      if (disposed || run !== version) { void removeSearch(value.id); return; }
      searchId = value.id;
      running = true;
      await poll(value.id, run);
    } catch (cause) { if (!disposed && run === version) { interrupted = true; error = (cause as Error).message; diagnostic = failureReport(cause, 'search-start'); } }
    finally { if (!disposed && run === version) starting = false; }
  }

  function changePage(next: number) {
    if (!searchId || next < 1 || next > pages || fetching) return;
    clearTimeout(timer);
    currentPage = next;
    results = [];
    return poll(searchId, version);
  }

  function applyFilters(event?: SubmitEvent) {
    event?.preventDefault();
    if (minSize !== undefined && maxSize !== undefined && minSize > maxSize) { error = $t.searchSizeRange; return; }
    filters = { sort, minSeeders, minSize: minSize === undefined ? undefined : Math.round(minSize * 1024 ** 3), maxSize: maxSize === undefined ? undefined : Math.round(maxSize * 1024 ** 3) };
    currentPage = 1;
    if (!searchId) return;
    clearTimeout(timer);
    results = [];
    return poll(searchId, version);
  }

  async function add(result: Result) {
    if (adding || added.includes(result.url)) return;
    adding = result.url;
    error = '';
    notice = '';
    diagnostic = '';
    try {
      await api('/api/torrents', { method: 'POST', body: JSON.stringify({ source: result.url }) });
      if (disposed) return;
      added = [...added, result.url];
      notice = $t.torrentAdded;
    } catch (cause) { if (!disposed) { error = (cause as Error).message; diagnostic = failureReport(cause, 'torrent-add'); } }
    finally { if (!disposed) adding = ''; }
  }

  function failureReport(cause: unknown, operation: string) {
    const report = (cause as Error & { diagnostic?: string })?.diagnostic;
    return typeof report === 'string' ? report : JSON.stringify({ version: 1, phase: 'client', operation, code: 'SOURCE_REQUEST_FAILED' }, null, 2);
  }

  onMount(() => {
    void loadSources();
    return () => {
      disposed = true;
      version++;
      clearTimeout(timer);
      if (searchId) void removeSearch(searchId);
    };
  });
</script>

<svelte:head><title>{$t.searchTorrents} · Torrents Duck</title></svelte:head>
<header class="search-heading"><div><h1>{$t.searchTorrents}</h1><p class="subtitle">{$t.searchHelp}</p></div>{#if canManage}<a class="button secondary" href="/search/sources"><Icon name="settings" size={18} />{$t.searchManageSources}</a>{/if}</header>
<Notification bind:message={error} kind="error" />
<Notification bind:message={notice} kind="success" />
{#if diagnostic}<Diagnostic text={diagnostic} />{/if}
{#each sourceDiagnostics as issue, index (`${issue.source}:${index}`)}<Diagnostic title={issue.source} message={issue.message} text={issue.diagnostic} />{/each}
<section class="panel" aria-label={$t.searchTorrents}>
  <form class="search-form" onsubmit={startSearch}>
    <label class="query-field">{$t.searchQuery}<input type="search" bind:value={query} placeholder={$t.searchQuery} maxlength={200} required disabled={sourcesLoading || starting || !enabledSources.length} /></label>
    <label>{$t.searchSource}<select bind:value={source} disabled={sourcesLoading || starting || !enabledSources.length}><option value="">{$t.searchAllSources}</option>{#each enabledSources as item (item.id)}<option value={item.id}>{item.name}</option>{/each}</select></label>
    <button class="primary" disabled={sourcesLoading || starting || !query.trim() || !enabledSources.length} aria-busy={starting}><Icon name="search" size={18} />{$t.searchSubmit}</button>
  </form>
  {#if sourcesLoading}
    <div class="empty" role="status"><p>{$t.loading}</p></div>
  {:else if !enabledSources.length}
    <div class="empty"><p>{$t.searchNoSources}</p><button class="secondary" onclick={loadSources}>{$t.deviceRetry}</button>{#if canManage}<a class="button primary" href="/search/sources">{$t.searchManageSources}</a>{/if}</div>
  {:else if !searched}
    <div class="empty"><Icon name="search" size={40} /><p>{$t.searchInitial}</p></div>
  {:else}
    <form class="toolbar result-filters" onsubmit={applyFilters}>
      <label>{$t.sort}<select bind:value={sort} onchange={() => applyFilters()}><option value="seeders">{$t.searchMostSeeders}</option><option value="leechers">{$t.searchMostLeechers}</option><option value="date">{$t.searchRecent}</option><option value="size">{$t.searchLargest}</option><option value="name">{$t.name}</option></select></label>
      <label>{$t.searchMinSeeders}<input type="number" min="0" max="1000000000" step="1" bind:value={minSeeders} /></label>
      <label>{$t.searchMinSize}<input type="number" min="0" max="1000000" step="any" bind:value={minSize} /></label>
      <label>{$t.searchMaxSize}<input type="number" min="0" max="1000000" step="any" bind:value={maxSize} /></label>
      <button class="secondary" disabled={starting}>{$t.searchApplyFilters}</button>
      <span class="spacer"></span><a class="quiet-button" href="/"><Icon name="transfer" size={18} />{$t.searchViewTransfers}</a>
    </form>
    {#if truncated}<p class="search-limit">{$t.searchTruncated}</p>{/if}
    {#if !results.length}
      <div class="empty" role="status"><p>{starting || running || fetching ? $t.searchRunning : interrupted ? $t.searchFailed : $t.noResults}</p></div>
    {:else}
      <div class="table-wrap">
        <!-- Preserve table semantics when CSS displays rows as cards. -->
        <!-- svelte-ignore a11y_no_redundant_roles -->
        <table role="table" aria-label={$t.searchResults}>
          <thead role="rowgroup"><tr role="row"><th scope="col">{$t.name}</th><th scope="col">{$t.size}</th><th scope="col">{$t.date}</th><th scope="col">{$t.searchSeeders} / {$t.searchLeechers}</th><th scope="col"><span class="sr-only">{$t.actions}</span></th></tr></thead>
          <tbody role="rowgroup">{#each results as result, index (`${result.url}:${index}`)}
            <tr role="row">
              <td class="result-name" role="cell">{#if result.descriptionUrl}<a href={result.descriptionUrl} target="_blank" rel="noopener noreferrer" title={result.name}>{result.name}<Icon name="share" size={14} /></a>{:else}<strong>{result.name}</strong>{/if}<small>{result.source}</small></td>
              <td class="result-size" role="cell"><span class="mobile-label" aria-hidden="true">{$t.size}</span>{result.size < 0 ? '—' : bytes(result.size)}</td>
              <td class="result-date" role="cell"><span class="mobile-label" aria-hidden="true">{$t.date}</span>{result.publishedAt == null ? $t.searchDateUnknown : new Date(result.publishedAt).toLocaleDateString($language)}</td>
              <td class="result-peers" role="cell"><span class="mobile-label" aria-hidden="true">{$t.searchSeeders} / {$t.searchLeechers}</span><span class="accent">{result.seeders < 0 ? '—' : result.seeders}</span> / {result.leechers < 0 ? '—' : result.leechers}</td>
              <td class="result-actions" role="cell"><button class={['secondary', { added: added.includes(result.url) }]} disabled={!!adding || added.includes(result.url)} aria-busy={adding === result.url} aria-label={`${added.includes(result.url) ? $t.searchAdded : $t.searchAdd} : ${result.name}`} onclick={() => add(result)}><Icon name={added.includes(result.url) ? 'check' : 'plus'} size={18} />{added.includes(result.url) ? $t.searchAdded : $t.searchAdd}</button></td>
            </tr>
          {/each}</tbody>
        </table>
      </div>
    {/if}
    <div class="panel-bottom"><span role="status">{total} {$t.searchResults.toLocaleLowerCase()} · {starting || running ? $t.searchRunning : interrupted ? $t.searchFailed : $t.searchFinished}</span><div class="pagination"><button aria-label={$t.previousPage} disabled={!searchId || currentPage <= 1 || fetching || starting} onclick={() => changePage(currentPage - 1)}><Icon name="chevron-left" size={18} /></button><span>{currentPage} / {pages}</span><button aria-label={$t.nextPage} disabled={!searchId || currentPage >= pages || fetching || starting} onclick={() => changePage(currentPage + 1)}><Icon name="chevron-right" size={18} /></button></div></div>
  {/if}
</section>

<style>
  .search-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap}
  .search-heading .subtitle{margin-top:8px}
  .search-form{display:flex;gap:12px;align-items:end;flex-wrap:wrap;padding:20px;border-bottom:1px solid var(--line)}
  .query-field{flex:1;min-width:180px}
  .search-form input{width:100%}
  .search-form .primary{min-height:44px}
  .result-filters{align-items:end}
  .result-filters label{font-size:12px;gap:4px}
  .result-filters input{width:120px;min-height:40px;font-size:14px;padding:8px 10px}
  .search-limit{padding:12px 16px;margin:0;color:var(--muted);border-bottom:1px solid var(--line)}
  .result-name{max-width:480px;overflow-wrap:anywhere}
  .result-name a,.result-name strong{font-weight:500}
  .result-name a:hover{color:var(--accent-ink);text-decoration:underline}
  .result-name a :global(svg){margin-left:6px}
  .result-name small{display:block;color:var(--muted);margin-top:4px}
  .result-size,.result-peers,.result-date{white-space:nowrap}
  .result-actions{text-align:right}
  .result-actions button{white-space:nowrap}
  .added{color:var(--success)}
  .empty{color:var(--muted)}
  .empty .button{margin-left:8px}
  .mobile-label{display:none}
  @media(max-width:700px){
    .search-form{padding:0 0 16px;gap:12px}
    .query-field{flex-basis:100%}
    .search-form>label:not(.query-field){flex:1}
    .search-form select{width:100%}
    .search-heading{align-items:start;margin-bottom:16px}
    .result-filters label{flex:1;min-width:130px}
    .result-filters input,.result-filters select{width:100%;font-size:16px}
    .search-limit{padding-inline:0}
    .table-wrap{overflow:visible}
    table,tbody{display:block}
    thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    tr{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:16px 0;border-top:1px solid var(--line)}
    td{border:0;padding:0}
    .result-name,.result-actions{grid-column:1 / -1;max-width:none}
    .result-name{font-size:15px}
    .result-actions{text-align:left}
    .mobile-label{display:block;color:var(--muted);font-size:12px;margin-bottom:4px}
  }
</style>
