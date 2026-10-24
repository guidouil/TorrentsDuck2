<script lang="ts">
  import Notification from '#lib/Notification.svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { api, bytes } from '#lib/client.js';
  import { language, t } from '#lib/i18n.js';
  import Modal from '#lib/Modal.svelte';
  import Icon from '#lib/Icon.svelte';
  type Entry = { name: string; path: string; directory: boolean; size: number; modifiedAt: string };
  const location = $derived(page.shallow?.url ?? page.url);
  const space = $derived(location.searchParams.get('space') === 'share' ? 'share' : 'downloads');
  const path = $derived(location.searchParams.get('path') ?? '');
  const query = $derived(location.searchParams.get('search') ?? '');
  const sort = $derived(location.searchParams.get('sort') ?? 'name');
  const requestedOffset = $derived(Number(location.searchParams.get('offset')));
  const offset = $derived(Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0);
  const parts = $derived(path.split('/').filter(Boolean));
  let entries = $state<Entry[]>([]); let total = $state(0); let loading = $state(true); let busy = $state(false); let error = $state(''); let notice = $state('');
  let filesInput = $state<HTMLInputElement>(); let dialogOpen = $state(false); let operation = $state('mkdir'); let selected = $state<Entry | null>(null); let newName = $state('');
  let videoOpen = $state(false); let video = $state<Entry | null>(null); let linkOpen = $state(false); let link = $state<any>(null);
  let vlcLink = $state('');
  let ftpsOpen = $state(false);
  let requestNumber = 0;
  const fileIcon = (name: string) => /\.(mp4|m4v|webm|ogv|mkv|mov|avi|mpeg|mpg|wmv|flv|m2ts|mts|vob|3gp)$/i.test(name) ? 'video-file' : /\.(mp3|m4a|ogg|oga|flac|wav|aac|opus|aiff|aif|wma|ape|alac)$/i.test(name) ? 'audio-file' : 'file';
  const fileUrl = (entry: Entry, inline = false) => `/api/files/download?${new URLSearchParams({ space, path: entry.path, ...(inline ? { inline: '1' } : {}) })}`;
  async function loadFiles() { const number = ++requestNumber; loading = true; error = ''; try { const result = await api(`/api/files?${new URLSearchParams({ space, path, search: query, sort, offset: String(offset), limit: '50' })}`); if (number !== requestNumber) return; entries = result.entries; total = result.total; } catch (e) { if (number === requestNumber) error = (e as Error).message; } finally { if (number === requestNumber) loading = false; } }
  $effect(() => { space; path; query; sort; offset; void loadFiles(); });
  $effect(() => { space; path; dialogOpen = false; videoOpen = false; linkOpen = false; });
  function browse(values: Record<string, string>, replace = false) {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries(values)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    if (url.href !== location.href) void goto(url, { shallow: true, replace, reset: false });
  }
  function switchSpace(value: string) { browse({ space: value, path: '', offset: '', search: '' }); }
  function enter(value: string) { browse({ path: value, offset: '', search: '' }); }
  function ask(action: string, entry: Entry | null = null) { operation = action; selected = entry; newName = action === 'rename' && entry ? entry.name : ''; dialogOpen = true; }
  async function mutate(event: SubmitEvent) { event.preventDefault(); busy = true; error = ''; try { await api('/api/files', { method: 'POST', body: JSON.stringify({ action: operation, space, path: selected?.path ?? path, name: newName, confirm: operation === 'delete' }) }); dialogOpen = false; await loadFiles(); } catch (e) { error = (e as Error).message; } finally { busy = false; } }
  async function upload(event: Event) { const input = event.currentTarget as HTMLInputElement; if (!input.files?.length) return; const uploadPath = path; busy = true; error = ''; notice = ''; try { for (const file of Array.from(input.files)) { notice = `${$t.uploading} ${file.name}…`; const body = new FormData(); body.set('file', file); body.set('action', 'upload'); await api(`/api/files?${new URLSearchParams({ space: 'share', path: uploadPath })}`, { method: 'POST', body }); } notice = $t.uploaded; await loadFiles(); } catch (e) { error = (e as Error).message; } finally { busy = false; input.value = ''; } }
  function mobileVlcUrl(url: string, name: string) {
    const { userAgent, maxTouchPoints } = navigator;
    if (/Android/i.test(userAgent)) {
      const media = new URL(url);
      // VLC needs a MIME type to accept our playback URLs without a file extension.
      return `intent://${media.host}${media.pathname}${media.search}#Intent;scheme=${media.protocol.slice(0, -1)};package=org.videolan.vlc;type=${fileIcon(name) === 'audio-file' ? 'audio' : 'video'}/*;end`;
    }
    if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`;
    return '';
  }
  async function makeLink(entry: Entry) { busy = true; error = ''; try { link = await api('/api/files/share', { method: 'POST', body: JSON.stringify({ space, path: entry.path }) }); vlcLink = mobileVlcUrl(link.url, entry.name); linkOpen = true; } catch (e) { error = (e as Error).message; } finally { busy = false; } }
  async function revoke() { try { await api('/api/files/share', { method: 'DELETE', body: JSON.stringify({ id: link.id }) }); linkOpen = false; notice = $t.linkRevoked; } catch (e) { error = (e as Error).message; } }
  async function copyLink() { try { await navigator.clipboard.writeText(new URL(link.url, window.location.origin).href); notice = $t.linkCopied; } catch { notice = $t.copyManually; } }
  function downloadPlaylist() { const blob = new Blob([`#EXTM3U\n${new URL(link.url, window.location.origin).href}\n`], { type: 'audio/x-mpegurl' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'torrents-duck.m3u'; a.click(); URL.revokeObjectURL(url); }
</script>
<svelte:head><title>{$t.files} · Torrents Duck</title></svelte:head>
<h1 class="sr-only">{$t.files}</h1>
<input class="sr-only" type="file" multiple bind:this={filesInput} onchange={upload} aria-label={$t.upload} />
<section class="panel explorer-panel" aria-label={$t.files}>
  <div class="toolbar explorer-toolbar">
    <div class="tabs" aria-label={$t.files}>
      <button class={{ selected: space === 'downloads' }} aria-pressed={space === 'downloads'} title={$t.downloadsDescription} disabled={busy} onclick={() => switchSpace('downloads')}><Icon name="download" size={18} />{$t.downloads}</button>
      <button class={{ selected: space === 'share' }} aria-pressed={space === 'share'} title={$t.shareDescription} disabled={busy} onclick={() => switchSpace('share')}><Icon name="folder" size={18} />{$t.shared}</button>
    </div>
    <input class="search" type="search" placeholder={$t.search} aria-label={$t.search} value={query} oninput={(event) => browse({ search: event.currentTarget.value, offset: '' }, Boolean(query))} />
    <select aria-label={$t.sort} value={sort} onchange={(event) => browse({ sort: event.currentTarget.value, offset: '' })}><option value="name">{$t.name}</option><option value="modifiedAt">{$t.date}</option><option value="size">{$t.size}</option></select>
  </div>
  <div class="explorer-location">
    <div class="breadcrumbs" aria-label={$t.path}><button disabled={busy} onclick={() => enter('')}>{space === 'downloads' ? $t.downloads : $t.shared}</button>{#each parts as part, i (parts.slice(0, i + 1).join('/'))}<span>/</span><button disabled={busy} onclick={() => enter(parts.slice(0, i + 1).join('/'))} aria-current={i === parts.length - 1 ? 'location' : undefined}>{part}</button>{/each}</div>
    <div class="file-actions"><button type="button" class="secondary" onclick={() => { ftpsOpen = true; }}>{$t.ftpsHelp}</button>{#if space === 'share'}<button class="secondary" disabled={busy} onclick={() => ask('mkdir')}><Icon name="plus" size={18} />{$t.newFolder}</button><button class="primary" disabled={busy} onclick={() => filesInput?.click()}><Icon name="upload" size={18} />{$t.upload}</button>{/if}</div>
  </div>
  <Notification bind:message={error} kind="error" /><Notification bind:message={notice} kind="info" />
{#if loading}
  <div class="empty"><p>{$t.loadingPage}</p></div>
{:else if !entries.length}
  <div class="empty"><p>{query ? $t.noResults : $t.emptyFolder}</p></div>
{:else}
  <div class="table-wrap">
    <!-- Preserve table semantics when CSS displays rows as cards. -->
      <!-- svelte-ignore a11y_no_redundant_roles -->
      <table role="table" aria-label={$t.files} class={{ editable: space === 'share' }}>
      <thead role="rowgroup"><tr role="row"><th scope="col">{$t.name}</th><th scope="col">{$t.size}</th><th scope="col">{$t.date}</th><th scope="col"><span class="sr-only">{$t.actions}</span></th></tr></thead>
      <tbody role="rowgroup">
        {#each entries as entry (entry.path)}
          <tr role="row">
            <td class="name-cell" role="cell">{#if entry.directory}<button class="file-link" disabled={busy} onclick={() => enter(entry.path)}><span class="file-glyph"><Icon name="folder" /></span><span class="truncate">{entry.name}</span></button>{:else}<a href={fileUrl(entry)} class="file-link"><span class="file-glyph"><Icon name={fileIcon(entry.name)} /></span><span class="truncate">{entry.name}</span></a>{/if}</td>
            <td class="muted" role="cell"><span class="mobile-label" aria-hidden="true">{$t.size}</span>{entry.directory ? '—' : bytes(entry.size)}</td>
            <td class="muted" role="cell"><span class="mobile-label" aria-hidden="true">{$t.date}</span>{new Date(entry.modifiedAt).toLocaleDateString($language)}</td>
            <td class="actions-cell" role="cell"><div class="row-actions">{#if !entry.directory}<a class="icon-button" title={$t.download} aria-label={$t.download} href={fileUrl(entry)}><Icon name="download" size={18} /><span class="action-label">{$t.download}</span></a>{#if /\.(mp4|m4v|webm|ogv|mkv|mov|avi|m4a|mp3|ogg|flac)$/i.test(entry.name)}<button class="icon-button" title={$t.play} aria-label={$t.play} onclick={() => { video = entry; videoOpen = true; }}><Icon name="play" size={18} /><span class="action-label">{$t.play}</span></button><button class="icon-button" title={$t.share} aria-label={$t.share} disabled={busy} onclick={() => makeLink(entry)}><Icon name="share" size={18} /><span class="action-label">{$t.share}</span></button>{/if}{/if}{#if space === 'share'}<button class="icon-button" title={$t.rename} aria-label={$t.rename} disabled={busy} onclick={() => ask('rename', entry)}><Icon name="edit" size={18} /><span class="action-label">{$t.rename}</span></button><button class="icon-button danger" title={$t.delete} aria-label={$t.delete} disabled={busy} onclick={() => ask('delete', entry)}><Icon name="trash" size={18} /><span class="action-label">{$t.delete}</span></button>{/if}</div></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
<div class="panel-bottom"><span>{total} {$t.items} · {$t.ftpsPort}</span><div class="pagination"><button aria-label={$t.previous} disabled={busy || loading || offset === 0} onclick={() => browse({ offset: String(Math.max(0, offset - 50)) })}><Icon name="chevron-left" size={18} /></button><span>{Math.floor(offset / 50) + 1} / {Math.max(1, Math.ceil(total / 50))}</span><button aria-label={$t.next} disabled={busy || loading || offset + 50 >= total} onclick={() => browse({ offset: String(offset + 50) })}><Icon name="chevron-right" size={18} /></button></div></div></section>
<Modal bind:open={dialogOpen} title={operation === 'mkdir' ? $t.newFolder : operation === 'rename' ? $t.rename : $t.delete}><form onsubmit={mutate} class="form-stack">{#if operation === 'delete'}<p>{$t.deleteFileBefore} {selected?.name} {$t.deleteFileAfter}</p>{:else}<label>{$t.name}<input required bind:value={newName} maxlength={240} /></label>{/if}<div class="dialog-actions"><button type="button" class="secondary" onclick={() => { dialogOpen = false; }}>{$t.cancel}</button><button class={['primary', { destructive: operation === 'delete' }]} disabled={busy}>{operation === 'delete' ? $t.deletePermanently : $t.save}</button></div></form></Modal>
<Modal bind:open={videoOpen} title={video?.name ?? $t.play} wide={true}>{#if video && videoOpen}<video class="video-player" controls preload="metadata" src={fileUrl(video, true)} onloadedmetadata={(event) => { event.currentTarget.muted = false; event.currentTarget.volume = 1; }}><track kind="captions" />{$t.browserUnsupported}</video><p>{$t.playbackHelp}</p><div class="dialog-actions"><a class="button secondary" href={fileUrl(video)}>{$t.download}</a><button class="primary" onclick={() => video && makeLink(video)}>{$t.share}</button></div>{/if}</Modal>
<Modal bind:open={linkOpen} title={$t.share}>{#if link}<p>{$t.linkExpires} {new Date(link.expiresAt).toLocaleString($language)}. {$t.linkPrivate}</p>{#if vlcLink}<p>{$t.vlcMobileHelp}</p>{/if}<div class="token-box">{link.url}</div><div class="dialog-actions"><button class="secondary danger" onclick={revoke}>{$t.revoke}</button><button class="secondary" onclick={copyLink}>{$t.copy}</button><button class={vlcLink ? 'secondary' : 'primary'} onclick={downloadPlaylist}>{$t.vlcPlaylist}</button>{#if vlcLink}<a class="button primary" href={vlcLink}>{$t.share}</a>{/if}</div>{/if}</Modal>
<Modal bind:open={ftpsOpen} title={$t.ftpsTitle}>
  <p>{$t.ftpsInstructions}</p>
  <dl class="ftps-settings">
    <dt>{$t.ftpsHost}</dt><dd>{page.url.hostname}</dd>
    <dt>{$t.ftpsPortLabel}</dt><dd>21000</dd>
    <dt>{$t.ftpsEncryption}</dt><dd>{$t.ftpsExplicit}</dd>
    <dt>{$t.ftpsTransferMode}</dt><dd>{$t.ftpsPassive}</dd>
  </dl>
  <p>{$t.ftpsCredentials}</p>
  <p><code>/downloads</code> — {$t.downloadsDescription}<br /><code>/share</code> — {$t.shareDescription}</p>
  <p>{$t.ftpsSharedFolders}</p>
  <div class="dialog-actions"><button type="button" class="primary" onclick={() => { ftpsOpen = false; }}>{$t.close}</button></div>
</Modal>
<style>
  .explorer-panel{display:flex;flex-direction:column;min-height:calc(100dvh - 44px);border-radius:var(--shape-lg)}
  .explorer-toolbar{gap:10px;padding:10px 12px}
  .tabs{flex-shrink:0}
  .tabs button{gap:6px;padding:8px 14px;min-height:38px}
  .explorer-toolbar .search{margin-left:auto;flex:1;width:auto;min-height:38px;padding:8px 14px}
  .explorer-toolbar select{min-height:38px;padding:7px 10px}
  .explorer-location{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;padding:5px 12px;border-bottom:1px solid var(--line)}
  .breadcrumbs{flex:1;min-width:0;gap:3px;margin:0}
  .breadcrumbs button{min-height:34px;padding:5px;overflow-wrap:anywhere;text-align:left;min-width:0}
  .file-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}
  .file-actions button{min-height:34px;padding:6px 12px;font-size:12px}
  .table-wrap{flex:1}
  table{table-layout:fixed}
  th:nth-child(2){width:12%}
  th:nth-child(3){width:15%}
  th:last-child{width:140px}
  table.editable th:last-child{width:220px}
  td,th{padding:8px 12px}
  .file-link{width:100%;min-width:0;max-width:none;gap:8px}
  .file-glyph{width:28px;height:28px;border-radius:var(--shape-sm)}
  .mobile-label,.action-label{display:none}
  .row-actions .icon-button{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;padding:6px}
  .panel-bottom{margin-top:auto;padding:8px 12px;gap:8px}
  .pagination{gap:8px}
  .pagination button{min-width:34px;min-height:34px;padding:6px}
  .empty{flex:1;padding:40px 16px}
  .ftps-settings{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px 16px;font-size:13px;line-height:1.6}
  .ftps-settings dt{color:var(--muted)}
  .ftps-settings dd{margin:0;overflow-wrap:anywhere}
  @media(max-width:900px){
    .explorer-panel{min-height:calc(100dvh - 180px)}
  }
  @media(max-width:700px){
    .explorer-toolbar{gap:8px;padding:8px 0}
    .tabs{width:100%}
    .tabs button{flex:1;min-width:0;min-height:44px;padding:8px}
    .explorer-toolbar .search{max-width:none;min-width:120px;min-height:44px}
    .explorer-toolbar select{min-height:44px}
    .explorer-location{gap:4px;padding:4px 0}
    .breadcrumbs{flex-basis:100%}
    .breadcrumbs button{min-height:44px}
    .file-actions{justify-content:flex-start}
    .file-actions button{min-height:44px;padding:6px 8px;gap:4px}
    .table-wrap{overflow:visible}
    table,tbody{display:block;width:100%}
    thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    tbody{padding:0;display:grid;gap:0}
    tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:12px 0;background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0}
    td{padding:0;border:0;min-width:0;font-size:12px}
    .name-cell,.actions-cell{grid-column:1/-1}
    .file-link{align-items:flex-start}
    .truncate{white-space:normal;overflow-wrap:anywhere;font-size:14px;line-height:1.5}
    .mobile-label{display:inline;color:var(--muted);font-size:11px;margin-right:6px}
    .row-actions{justify-content:flex-start;flex-wrap:wrap;gap:4px}
    .row-actions:empty{display:none}
    .actions-cell:has(.row-actions:empty){display:none}
    .row-actions .icon-button{min-width:44px;min-height:44px}
    .pagination{margin-left:auto}
    .pagination button{min-width:44px;min-height:44px}
  }
</style>
