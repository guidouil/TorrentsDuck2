<script lang="ts">
  import { page } from '$app/state';
  import { api, bytes } from '#lib/client.js';
  import { language, t } from '#lib/i18n.js';
  import Modal from '#lib/Modal.svelte';
  import Icon from '#lib/Icon.svelte';
  type Entry = { name: string; path: string; directory: boolean; size: number; modifiedAt: string };
  let space = $state('downloads'); let path = $state(''); let query = $state(''); let sort = $state('name'); let offset = $state(0);
  let entries = $state<Entry[]>([]); let total = $state(0); let loading = $state(true); let busy = $state(false); let error = $state(''); let notice = $state('');
  let filesInput = $state<HTMLInputElement>(); let dialogOpen = $state(false); let operation = $state('mkdir'); let selected = $state<Entry | null>(null); let newName = $state('');
  let videoOpen = $state(false); let video = $state<Entry | null>(null); let linkOpen = $state(false); let link = $state<any>(null);
  let ftpsOpen = $state(false);
  let requestNumber = 0;
  const fileUrl = (entry: Entry, inline = false) => `/api/files/download?${new URLSearchParams({ space, path: entry.path, ...(inline ? { inline: '1' } : {}) })}`;
  async function loadFiles() { const number = ++requestNumber; loading = true; error = ''; try { const result = await api(`/api/files?${new URLSearchParams({ space, path, search: query, sort, offset: String(offset), limit: '50' })}`); if (number !== requestNumber) return; entries = result.entries; total = result.total; } catch (e) { if (number === requestNumber) error = (e as Error).message; } finally { if (number === requestNumber) loading = false; } }
  $effect(() => { space; path; query; sort; offset; void loadFiles(); });
  function switchSpace(value: string) { space = value; path = ''; offset = 0; query = ''; }
  function enter(value: string) { path = value; offset = 0; query = ''; }
  function ask(action: string, entry: Entry | null = null) { operation = action; selected = entry; newName = action === 'rename' && entry ? entry.name : ''; dialogOpen = true; }
  async function mutate(event: SubmitEvent) { event.preventDefault(); busy = true; error = ''; try { await api('/api/files', { method: 'POST', body: JSON.stringify({ action: operation, space, path: selected?.path ?? path, name: newName, confirm: operation === 'delete' }) }); dialogOpen = false; await loadFiles(); } catch (e) { error = (e as Error).message; } finally { busy = false; } }
  async function upload(event: Event) { const input = event.currentTarget as HTMLInputElement; if (!input.files?.length) return; busy = true; error = ''; notice = ''; try { for (const file of Array.from(input.files)) { notice = `${$t.uploading} ${file.name}…`; const body = new FormData(); body.set('file', file); body.set('action', 'upload'); await api(`/api/files?${new URLSearchParams({ space: 'share', path })}`, { method: 'POST', body }); } notice = $t.uploaded; await loadFiles(); } catch (e) { error = (e as Error).message; } finally { busy = false; input.value = ''; } }
  async function makeLink(entry: Entry) { busy = true; error = ''; try { link = await api('/api/files/share', { method: 'POST', body: JSON.stringify({ space, path: entry.path }) }); linkOpen = true; } catch (e) { error = (e as Error).message; } finally { busy = false; } }
  async function revoke() { try { await api('/api/files/share', { method: 'DELETE', body: JSON.stringify({ id: link.id }) }); linkOpen = false; notice = $t.linkRevoked; } catch (e) { error = (e as Error).message; } }
  async function copyLink() { try { await navigator.clipboard.writeText(new URL(link.url, window.location.origin).href); notice = $t.linkCopied; } catch { notice = $t.copyManually; } }
  function downloadPlaylist() { const blob = new Blob([`#EXTM3U\n${new URL(link.url, window.location.origin).href}\n`], { type: 'audio/x-mpegurl' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'torrents-duck.m3u'; a.click(); URL.revokeObjectURL(url); }
</script>
<svelte:head><title>{$t.files} · Torrents Duck</title></svelte:head>
<div class="page-heading"><h1>{$t.files}</h1><div class="file-actions"><button type="button" class="secondary" onclick={() => { ftpsOpen = true; }}>{$t.ftpsHelp}</button>{#if space === 'share'}<button class="primary" disabled={busy} onclick={() => filesInput?.click()}><Icon name="upload" />{$t.upload}</button>{/if}</div></div>
<div class="tabs"><button class={{ selected: space === 'downloads' }} aria-pressed={space === 'downloads'} onclick={() => switchSpace('downloads')}><Icon name="download" size={18} />{$t.downloads}</button><button class={{ selected: space === 'share' }} aria-pressed={space === 'share'} onclick={() => switchSpace('share')}><Icon name="folder" size={18} />{$t.shared}</button></div>
<p class="subtitle" style="margin-top:15px">{space === 'downloads' ? $t.downloadsDescription : $t.shareDescription}</p>
<div class="breadcrumbs" aria-label={$t.path}><button onclick={() => enter('')}>{space === 'downloads' ? $t.downloads : $t.shared}</button>{#each path.split('/').filter(Boolean) as part, i (path.split('/').slice(0, i + 1).join('/'))}<span>/</span><button onclick={() => enter(path.split('/').slice(0, i + 1).join('/'))}>{part}</button>{/each}</div>
{#if error}<div class="notice error" role="alert">{error}</div>{/if}{#if notice}<div class="notice" role="status">{notice}</div>{/if}
<input class="sr-only" type="file" multiple bind:this={filesInput} onchange={upload} aria-label={$t.upload} />
<section class="panel" aria-label={$t.files}><div class="toolbar"><input class="search" placeholder={$t.search} aria-label={$t.search} bind:value={query} oninput={() => { offset = 0; }} /><select aria-label={$t.sort} bind:value={sort}><option value="name">{$t.name}</option><option value="modifiedAt">{$t.date}</option><option value="size">{$t.size}</option></select><div class="spacer"></div>{#if space === 'share'}<button class="secondary" disabled={busy} onclick={() => ask('mkdir')}><Icon name="plus" size={18} />{$t.newFolder}</button>{/if}</div>
{#if loading}
  <div class="empty"><p>{$t.loadingPage}</p></div>
{:else if !entries.length}
  <div class="empty"><p>{query ? $t.noResults : $t.emptyFolder}</p></div>
{:else}
  <div class="table-wrap">
    <!-- Preserve table semantics when CSS displays rows as cards. -->
      <!-- svelte-ignore a11y_no_redundant_roles -->
      <table role="table" aria-label={$t.files}>
      <thead role="rowgroup"><tr role="row"><th scope="col">{$t.name}</th><th scope="col">{$t.size}</th><th scope="col">{$t.date}</th><th scope="col"><span class="sr-only">{$t.actions}</span></th></tr></thead>
      <tbody role="rowgroup">
        {#each entries as entry (entry.path)}
          <tr role="row">
            <td class="name-cell" role="cell">{#if entry.directory}<button class="file-link" onclick={() => enter(entry.path)}><span class="file-glyph"><Icon name="folder" /></span><span class="truncate">{entry.name}</span></button>{:else}<a href={fileUrl(entry)} class="file-link"><span class="file-glyph"><Icon name="file" /></span><span class="truncate">{entry.name}</span></a>{/if}</td>
            <td class="muted" role="cell"><span class="mobile-label" aria-hidden="true">{$t.size}</span>{entry.directory ? '—' : bytes(entry.size)}</td>
            <td class="muted" role="cell"><span class="mobile-label" aria-hidden="true">{$t.date}</span>{new Date(entry.modifiedAt).toLocaleDateString($language)}</td>
            <td class="actions-cell" role="cell"><div class="row-actions">{#if !entry.directory}<a class="icon-button" title={$t.download} aria-label={$t.download} href={fileUrl(entry)}><Icon name="download" size={18} /><span class="action-label">{$t.download}</span></a>{#if /\.(mp4|m4v|webm|ogv|mkv|mov|avi|m4a|mp3|ogg|flac)$/i.test(entry.name)}<button class="icon-button" title={$t.play} aria-label={$t.play} onclick={() => { video = entry; videoOpen = true; }}><Icon name="play" size={18} /><span class="action-label">{$t.play}</span></button><button class="icon-button" title={$t.share} aria-label={$t.share} disabled={busy} onclick={() => makeLink(entry)}><Icon name="share" size={18} /><span class="action-label">{$t.share}</span></button>{/if}{/if}{#if space === 'share'}<button class="icon-button" title={$t.rename} aria-label={$t.rename} disabled={busy} onclick={() => ask('rename', entry)}><Icon name="edit" size={18} /><span class="action-label">{$t.rename}</span></button><button class="icon-button danger" title={$t.delete} aria-label={$t.delete} disabled={busy} onclick={() => ask('delete', entry)}><Icon name="trash" size={18} /><span class="action-label">{$t.delete}</span></button>{/if}</div></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
<div class="panel-bottom"><span>{total} {$t.items} · {$t.ftpsPort}</span><div class="pagination"><button aria-label={$t.previous} disabled={offset === 0} onclick={() => { offset = Math.max(0, offset - 50); }}><Icon name="chevron-left" size={18} /></button><span>{Math.floor(offset / 50) + 1} / {Math.max(1, Math.ceil(total / 50))}</span><button aria-label={$t.next} disabled={offset + 50 >= total} onclick={() => { offset += 50; }}><Icon name="chevron-right" size={18} /></button></div></div></section>
<Modal bind:open={dialogOpen} title={operation === 'mkdir' ? $t.newFolder : operation === 'rename' ? $t.rename : $t.delete}><form onsubmit={mutate} class="form-stack">{#if operation === 'delete'}<p>{$t.deleteFileBefore} {selected?.name} {$t.deleteFileAfter}</p>{:else}<label>{$t.name}<input required bind:value={newName} maxlength={240} /></label>{/if}{#if error}<p class="inline-error" role="alert">{error}</p>{/if}<div class="dialog-actions"><button type="button" class="secondary" onclick={() => { dialogOpen = false; }}>{$t.cancel}</button><button class="primary" disabled={busy}>{operation === 'delete' ? $t.deletePermanently : $t.save}</button></div></form></Modal>
<Modal bind:open={videoOpen} title={video?.name ?? $t.play} wide={true}>{#if video && videoOpen}<video class="video-player" controls preload="metadata" src={fileUrl(video, true)}><track kind="captions" />{$t.browserUnsupported}</video><p>{$t.playbackHelp}</p><div class="dialog-actions"><a class="button secondary" href={fileUrl(video)}>{$t.download}</a><button class="primary" onclick={() => video && makeLink(video)}>{$t.share}</button></div>{/if}</Modal>
<Modal bind:open={linkOpen} title={$t.share}>{#if link}<p>{$t.linkExpires} {new Date(link.expiresAt).toLocaleString($language)}. {$t.linkPrivate}</p><div class="token-box">{link.url}</div><div class="dialog-actions"><button class="secondary danger" onclick={revoke}>{$t.revoke}</button><button class="secondary" onclick={copyLink}>{$t.copy}</button><button class="primary" onclick={downloadPlaylist}>{$t.vlcPlaylist}</button></div>{/if}</Modal>
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
  .file-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px}
  .tabs button,.toolbar .secondary{display:inline-flex;align-items:center;justify-content:center;gap:8px}
  table{table-layout:fixed}
  th:nth-child(2){width:12%}
  th:nth-child(3){width:16%}
  th:last-child{width:260px}
  td,th{padding:18px 14px}
  .file-link{width:100%;min-width:0}
  .breadcrumbs button{overflow-wrap:anywhere;text-align:left;min-width:0}
  .mobile-label,.action-label{display:none}
  .row-actions .icon-button{display:inline-flex;align-items:center;justify-content:center;gap:7px}
  .ftps-settings{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px 16px;font-size:13px;line-height:1.6}
  .ftps-settings dt{color:var(--muted)}
  .ftps-settings dd{margin:0;overflow-wrap:anywhere}
  @media(max-width:1100px){
    .table-wrap{overflow:visible}
    table,tbody{display:block;width:100%}
    thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    tbody{padding:12px;display:grid;gap:12px}
    tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;padding:16px;background:var(--bg);border:1px solid var(--line);border-radius:12px}
    td{padding:0;border:0;min-width:0}
    .name-cell,.actions-cell{grid-column:1/-1}
    .file-link{max-width:none;align-items:flex-start}
    .truncate{white-space:normal;overflow-wrap:anywhere;font-size:14px;line-height:1.5}
    .mobile-label{display:block;color:var(--muted);font-size:11px;margin-bottom:8px}
    .row-actions{justify-content:flex-start;flex-wrap:wrap;gap:8px;padding-top:12px;border-top:1px solid var(--line)}
    .row-actions:empty{display:none}
    .actions-cell:has(.row-actions:empty){display:none}
    .row-actions .icon-button{padding:10px;font-size:12px;min-height:44px;background:var(--panel);border:1px solid var(--line)}
    .action-label{display:inline}
    .panel-bottom{flex-wrap:wrap;gap:16px}
    .pagination{margin-left:auto}
  }
  @media(max-width:700px){
    .page-heading{flex-wrap:wrap}
    .file-actions{justify-content:flex-start;width:100%}
    .file-actions button{flex:1}
    .tabs button{flex:1;min-width:0;padding:12px 8px}
  }
  @media(max-width:400px){
    tbody{padding:10px;gap:10px}
    tr{padding:12px;gap:14px}
    .row-actions{gap:6px}
    .row-actions .icon-button{padding:9px 7px;font-size:11px}
  }
</style>
