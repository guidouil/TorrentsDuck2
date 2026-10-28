<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { beforeNavigate, goto } from '$app/navigation';
  import { api, bytes, duration } from '#lib/client.js';
  import { language, t } from '#lib/i18n.js';
  import { STUDIO_MAX_SECONDS, parseStudioSrt, studioDuration, type StudioClip, type StudioEdit, type StudioJob, type StudioJobKind, type StudioMedia, type StudioProject, type StudioSource } from '#lib/studio.js';
  import Notification from '#lib/Notification.svelte';
  import Modal from '#lib/Modal.svelte';
  import Icon from '#lib/Icon.svelte';

  type Entry = { name: string; path: string; directory: boolean; size: number };
  let project = $state<StudioProject | null>(null), jobs = $state<StudioJob[]>([]);
  let loading = $state(true), busy = $state(false), error = $state(''), notice = $state(''), baseline = $state('');
  let selectedIndex = $state(0), video = $state<HTMLVideoElement>(), playhead = $state(0), unsupported = $state(false);
  let sourceDuration = $state(0), previewingClip = $state(false);
  let browserOpen = $state(false), entries = $state<Entry[]>([]), filesLoading = $state(false), filesTotal = $state(0);
  let space = $state<'downloads' | 'share'>('downloads'), folder = $state(''), offset = $state(0), search = $state('');
  let selectedJob = $state(''), thumbnailJob = $state(''), thumbnailTime = $state(0);
  let confirmOpen = $state(false);
  let confirmation = $state<'project' | 'job' | 'publish' | 'leave' | null>(null), targetJob = $state<StudioJob | null>(null), sharedName = $state('');
  let allowNavigation = false, leaveHref = '', alive = true, polling = false, fileRequest = 0;
  const pendingProbes = new Set<string>();
  const id = $derived(page.params.id!);
  const selected = $derived(project?.clips[selectedIndex]);
  const total = $derived(project ? studioDuration(project.clips) : 0);
  const dirty = $derived(project ? JSON.stringify(edit(project)) !== baseline : false);
  const activeJobs = $derived(jobs.some((job) => job.status === 'queued' || job.status === 'running'));
  const importing = $derived(jobs.some((job) => job.kind === 'probe' && (job.status === 'queued' || job.status === 'running')));
  const currentRender = $derived(jobs.find((job) => (selectedJob ? job.id === selectedJob : job.kind === 'preview' || job.kind === 'export') && job.status === 'completed'));
  const thumbnail = $derived(jobs.find((job) => job.id === thumbnailJob && job.status === 'completed'));
  const srtError = $derived.by(() => {
    try { parseStudioSrt(project?.subtitles ?? '', total); return ''; }
    catch { return $t.studio.srtInvalid; }
  });
  const subtitle = $derived.by(() => {
    if (!project || srtError || !selected || playhead < selected.start || playhead >= selected.end) return '';
    const position = studioDuration(project.clips.slice(0, selectedIndex)) + playhead - selected.start;
    return parseStudioSrt(project.subtitles, total).filter((cue) => cue.start <= position && cue.end > position).map((cue) => cue.text).join('\n');
  });
  function edit(value: StudioProject): StudioEdit { return { name: value.name, aspect: value.aspect, clips: value.clips, subtitles: value.subtitles }; }
  const fileUrl = (source: StudioSource) => `/api/files/download?${new URLSearchParams({ space: source.space, path: source.path, inline: '1' })}`;
  const jobUrl = (job: StudioJob, inline = false) => `/api/studio/${id}/jobs/${job.id}/file${inline ? '?inline=1' : ''}`;
  const isVideo = (name: string) => /\.(mp4|m4v|webm|ogv|mkv|mov|avi|mpeg|mpg|wmv|flv|m2ts|mts|vob|3gp)$/i.test(name);
  const mediaFor = (clip: StudioClip) => jobs.find((job) => job.kind === 'probe' && job.status === 'completed' && job.result?.fingerprint === clip.fingerprint && job.result?.space === clip.space && job.result?.path === clip.path)?.result;
  const timecode = (seconds: number) => Number.isFinite(seconds) && seconds >= 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '—';

  async function refresh(initial = false) {
    if (polling) return;
    polling = true;
    try {
      const result = await api<{ project: StudioProject; jobs: StudioJob[] }>(`/api/studio/${id}`);
      if (!alive) return;
      // Polling only updates jobs; edits in the form remain local until explicitly saved.
      if (initial) { project = result.project; baseline = JSON.stringify(edit(result.project)); }
      jobs = result.jobs;
      for (const job of jobs) {
        if (!pendingProbes.has(job.id) || !['completed', 'failed', 'cancelled'].includes(job.status)) continue;
        pendingProbes.delete(job.id);
        if (job.status === 'completed' && job.result) addMedia(job.result);
      }
    } catch (e) { if (alive) error = (e as Error).message; }
    finally { polling = false; loading = false; }
  }
  function selectClip(index: number) {
    selectedIndex = index; unsupported = false; thumbnailJob = ''; previewingClip = false;
    thumbnailTime = project?.clips[index]?.start ?? 0;
    if (video) { video.pause(); video.currentTime = thumbnailTime; }
  }
  function seek(time: number) {
    if (!video || !Number.isFinite(time) || !Number.isFinite(sourceDuration) || sourceDuration <= 0) return;
    previewingClip = false;
    playhead = Math.max(0, Math.min(time, sourceDuration));
    video.currentTime = playhead;
  }
  function playClip() {
    if (!video || !selected) return;
    video.currentTime = selected.start;
    previewingClip = true;
    void video.play().catch(() => { previewingClip = false; unsupported = true; });
  }
  function updatePlayback() {
    if (video && selected && previewingClip && !video.seeking && video.currentTime >= selected.end) {
      previewingClip = false; video.pause();
    }
  }
  function finishSeeking() {
    if (video && selected && (video.currentTime < selected.start || video.currentTime >= selected.end)) previewingClip = false;
  }
  function setBoundary(boundary: 'start' | 'end') {
    if (!selected || !video || !Number.isFinite(video.currentTime)) return;
    previewingClip = false;
    const length = Math.max(0.001, selected.end - selected.start), position = Math.round(video.currentTime * 1000) / 1000;
    selected[boundary] = position;
    if (boundary === 'start' && selected.end <= position) selected.end = Math.min(sourceDuration, position + length);
    if (boundary === 'end' && selected.start >= position) selected.start = Math.max(0, position - length);
  }
  function addMedia(media: StudioMedia) {
    if (!project) return;
    if (project.clips.length >= 32) { error = $t.studio.clipsLimit; return; }
    const remaining = STUDIO_MAX_SECONDS - studioDuration(project.clips);
    if (remaining <= 0) { error = $t.studio.limitError; return; }
    project.clips.push({ space: media.space, path: media.path, fingerprint: media.fingerprint, start: 0, end: Math.min(media.duration, remaining, 30), x: 0.5, y: 0.5, audio: media.audio[0]?.index ?? null, title: '' });
    selectClip(project.clips.length - 1);
    browserOpen = false;
  }
  function moveClip(index: number, change: number) {
    if (!project || index + change < 0 || index + change >= project.clips.length) return;
    const [clip] = project.clips.splice(index, 1); project.clips.splice(index + change, 0, clip); selectClip(index + change);
  }
  function removeClip(index: number) { if (project) { project.clips.splice(index, 1); selectClip(Math.min(index, project.clips.length - 1)); } }
  function validate() {
    if (!project || !project.name.trim()) throw new Error($t.name);
    if (!Number.isFinite(total) || total < 0 || total > STUDIO_MAX_SECONDS || project.clips.some((clip) => !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start || (mediaFor(clip) && clip.end > mediaFor(clip)!.duration))) throw new Error($t.studio.limitError);
    if (srtError) throw new Error(srtError);
  }
  async function save() {
    if (!project || busy) return false;
    busy = true; error = ''; notice = '';
    try {
      validate();
      const result = await api<{ project: StudioProject }>(`/api/studio/${id}`, { method: 'PATCH', body: JSON.stringify(edit(project)) });
      project = result.project; baseline = JSON.stringify(edit(result.project)); notice = $t.studio.saved; return true;
    } catch (e) { error = (e as Error).message; return false; }
    finally { busy = false; }
  }
  async function createJob(kind: StudioJobKind, source?: StudioSource, time?: number) {
    if (busy) return;
    if ((kind === 'preview' || kind === 'export') && !(await save())) return;
    busy = true; error = ''; notice = '';
    try {
      const { job } = await api<{ job: StudioJob }>(`/api/studio/${id}/jobs`, { method: 'POST', body: JSON.stringify({ kind, ...(source ? { source } : {}), ...(time !== undefined ? { time } : {}) }) });
      jobs = [job, ...jobs];
      if (kind === 'probe') { pendingProbes.add(job.id); browserOpen = false; }
      if (kind === 'thumbnail') thumbnailJob = job.id;
      if (kind === 'preview' || kind === 'export') selectedJob = job.id;
    } catch (e) { error = (e as Error).message; }
    finally { busy = false; }
  }
  async function loadFiles(nextFolder = folder, nextOffset = offset) {
    folder = nextFolder; offset = nextOffset; filesLoading = true; const request = ++fileRequest;
    try {
      const result = await api<{ entries: Entry[]; total: number }>(`/api/files?${new URLSearchParams({ space, path: nextFolder, offset: String(nextOffset), limit: '50', search, sort: 'name' })}`);
      if (request === fileRequest) { entries = result.entries; filesTotal = result.total; }
    } catch (e) { if (request === fileRequest) error = (e as Error).message; }
    finally { if (request === fileRequest) filesLoading = false; }
  }
  function openLibrary() { browserOpen = true; void loadFiles(); }
  async function importSrt(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    try {
      const file = input.files?.[0]; if (!file || !project) return;
      if (file.size > 40000) throw new Error($t.studio.srtInvalid);
      const text = await file.text(); parseStudioSrt(text, total); project.subtitles = text; error = '';
    } catch { error = $t.studio.srtInvalid; }
    finally { input.value = ''; }
  }
  async function cancelJob(job: StudioJob) {
    busy = true; error = '';
    try { await api(`/api/studio/${id}/jobs/${job.id}`, { method: 'DELETE', body: '{}' }); await refresh(); }
    catch (e) { error = (e as Error).message; }
    finally { busy = false; }
  }
  function ask(kind: 'project' | 'job' | 'publish', job: StudioJob | null = null) {
    confirmation = kind; confirmOpen = true; targetJob = job; sharedName = `${(project?.name ?? 'clip').replace(/[\\/]/g, '-')}.mp4`;
  }
  async function confirm() {
    if (confirmation === 'leave') { allowNavigation = true; confirmation = null; confirmOpen = false; await goto(leaveHref); return; }
    busy = true; error = '';
    try {
      if (confirmation === 'project') {
        await api(`/api/studio/${id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }); allowNavigation = true; await goto('/studio');
      } else if (targetJob && confirmation === 'job') {
        await api(`/api/studio/${id}/jobs/${targetJob.id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }); await refresh();
      } else if (targetJob && confirmation === 'publish') {
        await api(`/api/studio/${id}/jobs/${targetJob.id}/publish`, { method: 'POST', body: JSON.stringify({ name: sharedName, confirm: true }) }); notice = $t.studio.published;
      }
      confirmation = null; confirmOpen = false;
    } catch (e) { error = (e as Error).message; }
    finally { busy = false; }
  }
  beforeNavigate(({ cancel, to, type }) => {
    if (!dirty || allowNavigation) return;
    cancel();
    if (type !== 'leave' && to) { leaveHref = to.url.href; confirmation = 'leave'; confirmOpen = true; }
  });
  onMount(() => {
    alive = true;
    void refresh(true).then(() => {
      const sourcePath = page.url.searchParams.get('path'), sourceSpace = page.url.searchParams.get('space');
      if (sourcePath && (sourceSpace === 'downloads' || sourceSpace === 'share')) void createJob('probe', { space: sourceSpace, path: sourcePath });
    });
    const timer = setInterval(() => { if (!document.hidden && activeJobs) void refresh(); }, 2000);
    return () => { alive = false; clearInterval(timer); };
  });
</script>

<svelte:head><title>{project?.name ?? $t.studio.title} · Duck Studio</title></svelte:head>
<h1 class="sr-only">{project?.name ?? $t.studio.title}</h1>
<Notification bind:message={error} kind="error" />
<Notification bind:message={notice} />
{#if loading}<p class="empty">{$t.loadingPage}</p>
{:else if project}
  <div class="studio-heading"><a class="quiet-button" href="/studio"><Icon name="chevron-left" />{$t.studio.projects}</a><span class="badge">{$t.studio.private}</span><span class={['badge', { bad: total > STUDIO_MAX_SECONDS }]}>{duration(total)} / 5 min</span></div>
  <section class="panel project-panel">
    <div class="toolbar">
      <label class="project-name">{$t.name}<input bind:value={project.name} maxlength="100" disabled={busy} /></label>
      <label>{$t.studio.aspect}<select bind:value={project.aspect} disabled={busy}><option value="16:9">{$t.studio.landscape}</option><option value="9:16">{$t.studio.portrait}</option></select></label>
      <button class="primary" disabled={busy || !dirty || !!srtError} onclick={save}>{$t.save}</button>
      <button class="icon-button danger" title={$t.deleteShort} aria-label={$t.deleteShort} disabled={busy} onclick={() => ask('project')}><Icon name="trash" /></button>
    </div>
    {#if dirty}<p class="unsaved">{$t.studio.unsaved}</p>{/if}
  </section>
  <section class="panel timeline-panel" aria-label={$t.studio.timeline}>
    <div class="toolbar"><h2 class="step-heading"><span>1</span>{$t.studio.addStep}</h2><span class="spacer"></span><button class="secondary" disabled={busy || total >= STUDIO_MAX_SECONDS || project.clips.length >= 32} onclick={openLibrary}>{$t.studio.library}</button></div>
    <p class="section-help help">{$t.studio.addHelp}</p>
    {#if importing}<p class="section-help help" role="status">{$t.studio.importing}</p>{/if}
    {#if !project.clips.length}<p class="empty">{$t.studio.noClips}</p>{/if}
    <ol class="timeline">{#each project.clips as clip, index (clip)}
      <li class={{ chosen: index === selectedIndex }}><button class="clip-select" aria-pressed={index === selectedIndex} onclick={() => selectClip(index)}><strong>{$t.studio.clip} {index + 1}</strong><span>{clip.path.split('/').at(-1)}</span><small>{Number.isFinite(clip.start) ? clip.start.toFixed(2) : '—'} → {Number.isFinite(clip.end) ? clip.end.toFixed(2) : '—'} s</small></button><div class="clip-actions"><button class="quiet-button" disabled={busy || index === 0} aria-label={`${$t.studio.moveUp} ${index + 1}`} onclick={() => moveClip(index, -1)}>←</button><button class="quiet-button" disabled={busy || index === project!.clips.length - 1} aria-label={`${$t.studio.moveDown} ${index + 1}`} onclick={() => moveClip(index, 1)}>→</button><button class="icon-button danger" disabled={busy} title={$t.studio.removeClip} aria-label={`${$t.studio.removeClip} ${index + 1}`} onclick={() => removeClip(index)}><Icon name="x" size={18} /></button></div></li>
    {/each}</ol>
  </section>
  {#if selected}
  <section class="panel editor-panel">
    <h2 class="step-heading"><span>2</span>{$t.studio.trimStep}</h2>
    <p class="help">{$t.studio.trimHelp}</p>
    <div class="editor-grid">
      <section class="source-view" aria-label={$t.studio.source}>
        <h3>{selected.path.split('/').at(-1)}</h3>
        {#key `${selected.space}:${selected.path}`}
          <div class={['crop-preview', { portrait: project.aspect === '9:16' }]} style:aspect-ratio={project.aspect === '9:16' ? '9 / 16' : '16 / 9'}>
            <video bind:this={video} bind:currentTime={playhead} bind:duration={sourceDuration} controls playsinline preload="metadata" src={fileUrl(selected)} style:object-position={`${selected.x * 100}% ${selected.y * 100}%`} onloadedmetadata={(event) => { event.currentTarget.currentTime = selected?.start ?? 0; unsupported = false; }} onerror={() => { unsupported = true; }} ontimeupdate={updatePlayback} onseeking={finishSeeking} onseeked={finishSeeking} onpause={() => { previewingClip = false; }}><track kind="captions" />{$t.browserUnsupported}</video>
            {#if selected.title}<span class="preview-title">{selected.title}</span>{/if}
            {#if subtitle}<span class="preview-subtitle">{subtitle}</span>{/if}
          </div>
        {/key}
        <div class="source-navigation">
          <label for="source-position">{$t.studio.seek}<output for="source-position">{timecode(playhead)} / {timecode(sourceDuration)}</output></label>
          <input id="source-position" type="range" min="0" max={Number.isFinite(sourceDuration) ? sourceDuration : 0} step="0.1" value={playhead} disabled={!video || unsupported || !Number.isFinite(sourceDuration) || sourceDuration <= 0} oninput={(event) => seek(event.currentTarget.valueAsNumber)} />
          <div class="clip-buttons">
            <button class="secondary" disabled={!video || unsupported || !Number.isFinite(sourceDuration) || sourceDuration <= 0} onclick={() => seek(playhead - 10)} aria-label={$t.studio.backTen}>−10 s</button>
            <button class="secondary" disabled={!video || unsupported || !Number.isFinite(sourceDuration) || sourceDuration <= 0} onclick={() => seek(playhead + 10)} aria-label={$t.studio.forwardTen}>+10 s</button>
            <button class="secondary" disabled={!video || unsupported || !Number.isFinite(selected.start) || !Number.isFinite(selected.end) || selected.start < 0 || selected.end <= selected.start} onclick={playClip}><Icon name="play" />{$t.studio.playClip}</button>
          </div>
        </div>
        <p class="help">{unsupported ? $t.studio.unsupported : $t.studio.nativeHelp}</p>
        <details class="thumbnail-details" open={!!thumbnailJob}>
          <summary>{$t.studio.thumbnail}</summary>
          <div class="thumbnail-tools"><label>{$t.studio.timecode}<input type="number" min="0" max={mediaFor(selected)?.duration} step="0.1" bind:value={thumbnailTime} disabled={busy} /></label><button class="secondary" disabled={busy || !Number.isFinite(thumbnailTime) || thumbnailTime < 0} onclick={() => selected && createJob('thumbnail', { space: selected.space, path: selected.path }, thumbnailTime)}>{$t.studio.makeThumbnail}</button></div>
          {#if thumbnail}<img class="thumbnail" src={jobUrl(thumbnail, true)} alt={`${$t.studio.thumbnail} · ${thumbnailTime} s`} />{/if}
        </details>
      </section>
      <section class="clip-settings" aria-label={$t.studio.clip}>
        <h3>{$t.studio.clip} {selectedIndex + 1}</h3>
        <fieldset disabled={busy}>
          <label>{$t.studio.start}<input type="number" min="0" max={mediaFor(selected)?.duration} step="0.001" bind:value={selected.start} /></label>
          <button class="secondary" disabled={!video || unsupported || !Number.isFinite(sourceDuration) || sourceDuration <= 0 || !Number.isFinite(playhead) || playhead >= sourceDuration} onclick={() => setBoundary('start')}>{$t.studio.useStart}</button>
          <label>{$t.studio.end}<input type="number" min="0" max={mediaFor(selected)?.duration} step="0.001" bind:value={selected.end} /></label>
          <button class="secondary" disabled={!video || unsupported || !Number.isFinite(sourceDuration) || sourceDuration <= 0 || !Number.isFinite(playhead) || playhead <= 0} onclick={() => setBoundary('end')}>{$t.studio.useEnd}</button>
          <p class="help">{$t.studio.selection}: {duration(selected.end - selected.start)}</p>
          <details class="advanced-settings">
            <summary>{$t.studio.advanced}</summary>
            <label>{$t.studio.audio}<select bind:value={selected.audio}><option value={null}>{$t.studio.silent}</option>{#each (mediaFor(selected)?.audio ?? (selected.audio !== null ? [{ index: selected.audio, label: `${$t.studio.audio} ${selected.audio}` }] : [])) as track (track.index)}<option value={track.index}>{track.label}</option>{/each}</select></label>
            <label>{$t.studio.cropX}<input type="range" min="0" max="1" step="0.01" bind:value={selected.x} /></label>
            <label>{$t.studio.cropY}<input type="range" min="0" max="1" step="0.01" bind:value={selected.y} /></label>
            <label>{$t.studio.clipTitle}<input bind:value={selected.title} maxlength="120" /></label>
          </details>
        </fieldset>
      </section>
    </div>
  </section>
  {/if}
  <details class="panel subtitle-panel" open={!!project.subtitles}>
    <summary>{$t.studio.subtitles}</summary><p class="help">{$t.studio.srtHelp}</p>
    <label>{$t.studio.srtImport}<input type="file" accept=".srt,application/x-subrip,text/plain" disabled={busy} onchange={importSrt} /></label>
    <label>{$t.studio.subtitles}<textarea rows="6" maxlength="10000" bind:value={project.subtitles} disabled={busy} spellcheck="false" aria-invalid={!!srtError} placeholder="1&#10;00:00:01,000 --> 00:00:03,000&#10;…"></textarea></label>
    {#if srtError}<p class="validation" role="alert">{srtError}</p>{/if}
  </details>
  <section class="panel render-panel">
    <h2 class="step-heading"><span>3</span>{$t.studio.exportStep}</h2>
    <div class="render-actions"><button class="secondary" disabled={busy || !project.clips.length || total > STUDIO_MAX_SECONDS || !!srtError} onclick={() => createJob('preview')}>{$t.studio.renderPreview}</button><button class="primary" disabled={busy || !project.clips.length || total > STUDIO_MAX_SECONDS || !!srtError} onclick={() => createJob('export')}>{$t.studio.renderExport}</button></div>
    <p class="help">{$t.studio.renderHelp}</p>
    {#if currentRender}
      <video class="render-video" controls playsinline preload="metadata" src={jobUrl(currentRender, true)}><track kind="captions" />{$t.browserUnsupported}</video>
      <div class="render-actions"><a class="button primary" href={jobUrl(currentRender)}><Icon name="download" />{$t.download}</a>{#if currentRender.kind === 'export'}<button class="secondary" disabled={busy} onclick={() => ask('publish', currentRender)}>{$t.studio.publish}</button>{/if}</div>
    {/if}
    <details class="job-history" open={activeJobs || jobs.some((job) => job.status === 'failed')}>
    <summary>{$t.studio.jobs}</summary>
    {#if !jobs.length}<p class="help">{$t.studio.noJobs}</p>{/if}
    <ul class="job-list">{#each jobs as job (job.id)}<li><div class="job-summary"><strong>{$t.studio[job.kind]}</strong><span class={['badge', { bad: job.status === 'failed' }]}>{$t.studio[job.status]}</span><time datetime={job.createdAt}>{new Date(job.createdAt).toLocaleString($language)}</time></div>
      {#if job.status === 'running'}<progress max="100" value={job.progress} aria-label={$t.studio[job.kind]}></progress>{/if}
      {#if job.error}<p class="validation">{job.error}</p>{/if}
      <div class="job-actions">
        {#if job.status === 'queued' || job.status === 'running'}<button class="quiet-button" disabled={busy} onclick={() => cancelJob(job)}>{$t.cancel}</button>
        {:else if job.status === 'completed'}
          {#if job.kind === 'probe' && job.result}<button class="quiet-button" disabled={busy || total >= STUDIO_MAX_SECONDS || project.clips.length >= 32} onclick={() => job.result && addMedia(job.result)}>{$t.studio.createClip}</button>
          {:else if job.kind === 'preview' || job.kind === 'export'}<button class="quiet-button" onclick={() => { selectedJob = job.id; }}>{$t.studio.watch}</button><a class="button secondary" href={jobUrl(job)}>{$t.download}</a>{#if job.kind === 'export'}<button class="quiet-button" disabled={busy} onclick={() => ask('publish', job)}>{$t.studio.publish}</button>{/if}
          {:else if job.kind === 'thumbnail'}<button class="quiet-button" onclick={() => { thumbnailJob = job.id; }}>{$t.studio.thumbnail}</button>{/if}
        {:else if job.kind === 'preview' || job.kind === 'export'}<button class="quiet-button" disabled={busy || !project.clips.length} onclick={() => createJob(job.kind)}>{$t.studio.retry}</button>{/if}
        {#if job.status !== 'queued' && job.status !== 'running'}<button class="icon-button danger" aria-label={$t.deleteShort} disabled={busy} onclick={() => ask('job', job)}><Icon name="trash" /></button>{/if}
      </div></li>{/each}</ul>
    </details>
  </section>
{:else}<button class="secondary" onclick={() => refresh(true)}>{$t.studio.retry}</button>{/if}

<Modal bind:open={browserOpen} title={$t.studio.library} wide>
  <p class="help">{$t.studio.sourceHelp}</p>
  <form class="library-toolbar" onsubmit={(event) => { event.preventDefault(); void loadFiles(folder, 0); }}>
    <label>{$t.studio.source}<select bind:value={space} onchange={() => { search = ''; void loadFiles('', 0); }}><option value="downloads">{$t.downloads}</option><option value="share">{$t.shared}</option></select></label>
    <label>{$t.search}<input bind:value={search} /></label><button class="secondary">{$t.searchSubmit}</button>
  </form>
  <div class="folder-path"><strong>/{folder}</strong>{#if folder}<button class="quiet-button" disabled={filesLoading} onclick={() => loadFiles(folder.split('/').slice(0, -1).join('/'), 0)}>{$t.studio.parent}</button>{/if}</div>
  {#if filesLoading}<p class="empty">{$t.loadingPage}</p>{:else}
    <ul class="library-list">{#each entries.filter((entry) => entry.directory || isVideo(entry.name)) as entry (entry.path)}<li><button class="library-entry" disabled={busy} onclick={() => entry.directory ? loadFiles(entry.path, 0) : createJob('probe', { space, path: entry.path })}><Icon name={entry.directory ? 'folder' : 'video-file'} /><span>{entry.name}</span><small>{entry.directory ? '' : bytes(entry.size)}</small></button></li>{/each}</ul>
    {#if !entries.some((entry) => entry.directory || isVideo(entry.name))}<p class="empty">{$t.studio.noVideos}</p>{/if}
  {/if}
  <div class="dialog-actions"><button class="secondary" disabled={filesLoading || offset === 0} onclick={() => loadFiles(folder, Math.max(0, offset - 50))}>{$t.previous}</button><span>{offset + (filesTotal ? 1 : 0)}–{Math.min(offset + 50, filesTotal)} / {filesTotal}</span><button class="secondary" disabled={filesLoading || offset + 50 >= filesTotal} onclick={() => loadFiles(folder, offset + 50)}>{$t.next}</button></div>
</Modal>
<Modal bind:open={confirmOpen} title={$t.confirmation}>
  <p>{confirmation === 'project' ? $t.studio.deleteProject : confirmation === 'job' ? $t.studio.deleteJob : confirmation === 'publish' ? $t.studio.publishHelp : $t.studio.leave}</p>
  {#if confirmation === 'project' || confirmation === 'job'}<p class="help">{$t.studio.deleteHelp}</p>{/if}
  {#if confirmation === 'publish'}<label>{$t.studio.fileName}<input bind:value={sharedName} maxlength="255" disabled={busy} /></label>{/if}
  <div class="dialog-actions"><button class="secondary" disabled={busy} onclick={() => { confirmation = null; confirmOpen = false; }}>{$t.cancel}</button><button class="primary" disabled={busy} onclick={confirm}>{$t.confirm}</button></div>
</Modal>

<style>
  h2,h3{font-size:17px;margin:0 0 12px;overflow-wrap:anywhere}.studio-heading{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}.project-panel,.timeline-panel,.editor-panel,.subtitle-panel,.render-panel{margin-bottom:20px}.project-name{flex:1;min-width:160px}.toolbar{align-items:end}.toolbar h2{margin:0;align-self:center}.unsaved{color:var(--warning);margin:12px 20px}.editor-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;margin-top:20px}.source-view,.clip-settings{min-width:0}.help{color:var(--muted);font-size:13px;line-height:1.6}.crop-preview{background:#000;border-radius:var(--shape-md);position:relative;overflow:hidden;width:100%;max-width:782px;margin-inline:auto}.crop-preview.portrait{max-width:247px}.crop-preview video{width:100%;height:100%;object-fit:cover;display:block}.preview-title,.preview-subtitle{position:absolute;left:8%;right:8%;text-align:center;color:#fff;text-shadow:0 1px 4px #000,1px 0 #000,-1px 0 #000;white-space:pre-line;overflow-wrap:anywhere;pointer-events:none}.preview-title{top:8%;font-weight:700;font-size:clamp(14px,2vw,28px)}.preview-subtitle{bottom:18%;font-size:clamp(12px,1.5vw,22px)}fieldset{border:0;padding:0;margin:0;display:grid;gap:16px;min-width:0}.clip-buttons,.thumbnail-tools,.render-actions,.job-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.thumbnail-tools{align-items:end;margin:16px 0}.thumbnail-tools input{width:130px}.thumbnail{max-width:100%;max-height:200px;border-radius:var(--shape-sm)}.timeline{display:flex;gap:12px;list-style:none;margin:0;padding:16px;overflow-x:auto}.timeline li{flex:0 0 210px;border:1px solid var(--line);border-radius:var(--shape-md);background:var(--surface-container)}.timeline li.chosen{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}.clip-select{display:grid;gap:6px;text-align:left;width:100%;padding:14px;background:transparent;color:var(--text)}.clip-select span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.clip-select small{color:var(--muted)}.clip-actions{display:flex;justify-content:space-around;border-top:1px solid var(--line)}.editor-panel,.subtitle-panel,.render-panel{padding:20px}.subtitle-panel label+label{margin-top:16px}textarea{resize:vertical;width:100%;font-family:ui-monospace,monospace;font-size:14px}.validation{color:var(--danger);overflow-wrap:anywhere}.render-video{width:100%;max-height:500px;background:#000;border-radius:var(--shape-md);margin:12px 0 24px}.job-list{list-style:none;margin:0;padding:0}.job-list li{padding:16px 0;border-top:1px solid var(--line)}.job-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.job-summary time{margin-left:auto;color:var(--muted);font-size:12px}.job-actions{margin-top:12px}progress{width:100%;height:8px;margin-top:12px;accent-color:var(--accent)}.library-toolbar{display:flex;align-items:end;gap:12px;flex-wrap:wrap}.library-toolbar label:nth-child(2){flex:1;min-width:140px}.folder-path{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;overflow-wrap:anywhere}.library-list{list-style:none;padding:0;max-height:45vh;overflow-y:auto}.library-entry{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:14px 8px;background:transparent;color:var(--text);border-bottom:1px solid var(--line)}.library-entry:hover{background:var(--panel-hover)}.library-entry span{flex:1;min-width:0;overflow-wrap:anywhere}.library-entry small{color:var(--muted);white-space:nowrap}
  .step-heading{display:flex;align-items:center;gap:10px}.step-heading span{display:grid;place-items:center;flex-shrink:0;width:28px;height:28px;border-radius:50%;background:var(--secondary-container);color:var(--on-secondary-container);font-size:14px}.section-help{padding-inline:16px}.source-navigation{margin-top:16px}.source-navigation label{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.source-navigation output{font-variant-numeric:tabular-nums;color:var(--muted)}.source-navigation input{width:100%;accent-color:var(--accent)}summary{cursor:pointer;min-height:44px;align-content:center;font-weight:600}.advanced-settings label{margin-top:16px}.clip-settings .help{margin:0}.job-history{margin-top:20px}
  @media(max-width:1000px){.editor-grid{grid-template-columns:minmax(0,1fr) 250px;gap:16px}}
  @media(max-width:700px){.editor-grid{grid-template-columns:1fr}.toolbar label{flex-basis:100%}.toolbar>button.primary{flex:1}.clip-settings{border-top:1px solid var(--line);padding-top:20px}.clip-buttons>*{flex:1;min-width:130px}.editor-panel,.subtitle-panel,.render-panel{padding:16px}.job-summary time{width:100%;margin-left:0}.render-actions button{flex:1;min-width:150px}.library-toolbar>label{flex:1}.library-entry small{display:none}.timeline li{flex-basis:190px}.job-actions>*{min-height:44px}.studio-heading{gap:8px}}
</style>
