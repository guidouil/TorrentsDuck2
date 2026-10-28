<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { api, duration } from '#lib/client.js';
  import { t, language } from '#lib/i18n.js';
  import { studioDuration, type StudioProject } from '#lib/studio.js';
  import Notification from '#lib/Notification.svelte';
  import Icon from '#lib/Icon.svelte';
  let projects = $state<StudioProject[]>([]);
  let loading = $state(true), busy = $state(false), error = $state(''), name = $state('');
  async function load() {
    loading = true; error = '';
    try { projects = (await api<{ projects: StudioProject[] }>('/api/studio')).projects; }
    catch (e) { error = (e as Error).message; }
    finally { loading = false; }
  }
  async function create(source?: { space: string; path: string }) {
    if (busy) return;
    busy = true; error = '';
    try {
      const result = await api<{ project: StudioProject }>('/api/studio', { method: 'POST', body: JSON.stringify({ name: (source?.path.split('/').at(-1) || name || $t.studio.newProject).slice(0, 100) }) });
      await goto(`/studio/${result.project.id}${source ? `?${new URLSearchParams(source)}` : ''}`);
    } catch (e) { error = (e as Error).message; busy = false; }
  }
  onMount(() => {
    const path = page.url.searchParams.get('path'), space = page.url.searchParams.get('space');
    if (path && (space === 'downloads' || space === 'share')) { loading = false; void create({ space, path }); }
    else void load();
  });
</script>

<svelte:head><title>{$t.studio.title} · TorrentsDuck2</title></svelte:head>
<div class="page-heading"><div><h1>{$t.studio.title}</h1><p>{$t.studio.intro}</p></div><span class="badge">{$t.studio.limit}</span></div>
<Notification bind:message={error} kind="error" />
<section class="panel">
  <form class="toolbar" onsubmit={(event) => { event.preventDefault(); void create(); }}>
    <label>{$t.name}<input bind:value={name} maxlength="100" placeholder={$t.studio.newProject} disabled={busy} /></label>
    <button class="primary" disabled={busy}><Icon name="edit" />{busy ? $t.creating : $t.studio.newProject}</button>
    <button type="button" class="secondary" disabled={busy || loading} onclick={load}>{$t.studio.refresh}</button>
  </form>
  {#if loading}<p class="empty">{$t.loadingPage}</p>
  {:else if !projects.length}<p class="empty">{$t.studio.empty}</p>
  {:else}<ul class="project-list">{#each projects as project (project.id)}
    <li><a href={`/studio/${project.id}`}><span><strong>{project.name}</strong><small>{$t.studio.private} · {duration(studioDuration(project.clips))}</small></span><time datetime={project.updatedAt}>{new Date(project.updatedAt).toLocaleDateString($language)}</time><Icon name="chevron-right" /></a></li>
  {/each}</ul>{/if}
</section>

<style>
  .page-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:24px}
  h1{margin:0}p{color:var(--muted)}.toolbar{align-items:end}.toolbar label{flex:1;min-width:180px}.project-list{list-style:none;margin:16px 0 0;padding:0}.project-list li+li{border-top:1px solid var(--line)}.project-list a{display:flex;align-items:center;gap:16px;padding:18px 8px;border-radius:var(--shape-sm)}.project-list a:hover{background:var(--panel-hover)}.project-list span{display:grid;gap:4px;flex:1;min-width:0}.project-list strong{overflow-wrap:anywhere}.project-list small,.project-list time{color:var(--muted)}.empty{padding:32px 8px}
  @media(max-width:700px){.project-list time{display:none}.toolbar{align-items:stretch}.toolbar label{flex-basis:100%}.toolbar button{flex:1}.page-heading{margin-bottom:16px}}
</style>
