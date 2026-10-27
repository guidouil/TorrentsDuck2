<script lang="ts">
  import Notification from '#lib/Notification.svelte';
  import { onMount } from 'svelte';
  import { api, bytes, duration } from '#lib/client.js';
  import { language, t } from '#lib/i18n.js';
  import MetricGauge from '#lib/MetricGauge.svelte';
  import { transferSpeed, diskPercent, chartPoints } from '#lib/transfer-metrics.js';
  import Modal from '#lib/Modal.svelte';
  import Icon from '#lib/Icon.svelte';
  let { data } = $props();
  type Torrent = { hash: string; name: string; size: number; progress: number; downloadSpeed: number; uploadSpeed: number; ratio: number; peers: number; eta: number; state: string; authorId?: string };
  let torrents = $state<Torrent[]>([]);
  let stats = $state<any>({}); let storage = $state<any>({});
  let services = $state<{ id: string; cpuPercent: number | null }[]>([]);
  let lastSample = $state(0);
  let history = $state<{ download: number; upload: number }[]>([]);
  let peaks = $state({ download: 0, upload: 0 });
  const serviceNames = [{ id: 'web', name: 'Web' }, { id: 'qbittorrent', name: 'qBittorrent' }, { id: 'postgres', name: 'PostgreSQL' }, { id: 'nginx', name: 'Nginx' }, { id: 'ftp', name: 'FTPS' }];
  const downloadSpeed = $derived(lastSample ? transferSpeed(stats.downloadSpeed ?? stats.dl_info_speed ?? torrents.reduce((sum, torrent) => sum + torrent.downloadSpeed, 0)) : null);
  const uploadSpeed = $derived(lastSample ? transferSpeed(stats.uploadSpeed ?? stats.up_info_speed ?? torrents.reduce((sum, torrent) => sum + torrent.uploadSpeed, 0)) : null);
  const diskUsage = $derived(diskPercent(storage));
  let loading = $state(true); let connected = $state(false); let error = $state(''); let notice = $state('');
  let query = $state(''); let mine = $state(false); let sort = $state('progress'); let limit = $state(25); let currentPage = $state(1);
  let source = $state(''); let upload = $state<File | undefined>(); let busy = $state(false);
  let removal = $state<Torrent | null>(null); let removeOpen = $state(false); let deleteData = $state(false);
  const filtered = $derived(torrents.filter((x) => x.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!mine || x.authorId === data.user?.id)).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'speed' ? b.downloadSpeed - a.downloadSpeed : b.progress - a.progress));
  const rows = $derived(filtered.slice((currentPage - 1) * limit, currentPage * limit));
  const pages = $derived(Math.max(1, Math.ceil(filtered.length / limit)));
  function snapshot(value: any) {
    if (value.error) { error = value.error; loading = false; return; }
    if (value.sampledAt !== undefined && value.sampledAt < lastSample) return;
    torrents = value.torrents ?? []; currentPage = Math.min(currentPage, pages);
    stats = value.stats ?? {}; storage = value.storage ?? {}; services = value.metrics?.services ?? [];
    peaks = { download: transferSpeed(stats.downloadPeak ?? 0) ?? 0, upload: transferSpeed(stats.uploadPeak ?? 0) ?? 0 };
    const time = value.sampledAt ?? Date.now();
    if (time > lastSample) {
      const download = transferSpeed(stats.downloadSpeed ?? stats.dl_info_speed ?? torrents.reduce((sum, torrent) => sum + torrent.downloadSpeed, 0));
      const upload = transferSpeed(stats.uploadSpeed ?? stats.up_info_speed ?? torrents.reduce((sum, torrent) => sum + torrent.uploadSpeed, 0));
      if (download !== null && upload !== null) history = [...history.slice(-39), { download, upload }];
      lastSample = time;
    }
    loading = false; error = '';
  }
  onMount(() => {
    api('/api/torrents').then(snapshot).catch((e) => { error = e.message; loading = false; });
    const events = new EventSource('/api/events');
    events.addEventListener('snapshot', (e) => { try { snapshot(JSON.parse((e as MessageEvent).data)); connected = true; } catch { error = $t.invalidEngineResponse; } });
    events.addEventListener('error', () => { connected = false; });
    events.addEventListener('unauthorized', () => { events.close(); window.location.assign('/login'); });
    events.addEventListener('engine-error', (e) => { try { error = JSON.parse((e as MessageEvent).data).error; loading = false; } catch { error = $t.engineUnavailable; } });
    return () => events.close();
  });
  async function addTorrent(event: SubmitEvent) { event.preventDefault(); if (busy || (!source.trim() && !upload)) return; const form = event.currentTarget as HTMLFormElement; busy = true; error = ''; notice = ''; try { const body = new FormData(); if (upload) body.set('torrent', upload); else body.set('source', source); await api('/api/torrents', { method: 'POST', body }); source = ''; upload = undefined; form.reset(); notice = $t.torrentAdded; snapshot(await api('/api/torrents')); } catch (e) { error = (e as Error).message; } finally { busy = false; } }
  async function action(torrent: Torrent, action: string, confirm = false) { busy = true; error = ''; try { await api(`/api/torrents/${encodeURIComponent(torrent.hash)}`, { method: 'POST', body: JSON.stringify({ action, confirm }) }); removeOpen = false; snapshot(await api('/api/torrents')); } catch (e) { error = (e as Error).message; } finally { busy = false; } }
  function askRemove(torrent: Torrent, withData: boolean) { removal = torrent; deleteData = withData; removeOpen = true; }
  const stopped = (state: string) => /paused|stopped|error|missing/i.test(state);
  const stateLabel = (state: string, progress: number) => /error|missing/i.test(state) ? $t.stateError : stopped(state) ? $t.statePaused : progress >= 1 ? $t.stateSharing : /stalled/i.test(state) ? $t.stateWaiting : $t.downloading;
</script>
<svelte:head><title>{$t.transfers} · TorrentsDuck2</title></svelte:head>
<h1 class="sr-only">{$t.transfers}</h1>
{#snippet activity(values: number[], maximum: number)}
  <svg class="activity-chart" viewBox="0 0 240 36" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <path class="chart-grid" d="M0 2H240 M0 17H240 M0 32H240" />
    {#if values.length > 1}
      <polygon points={`0,36 ${chartPoints(values, maximum)} 240,36`} />
      <polyline points={chartPoints(values, maximum)} />
    {/if}
  </svg>
{/snippet}
<div class="stat-grid transfer-stats">
  <section class="stat-card metric-card network-card" aria-label={$t.downloading}>
    <div class="stat-label"><span class="metric-icon"><Icon name="download" size={17} /></span><span>{$t.downloading}</span><span class="metric-cap" title={$t.bandwidthPeakHelp}>{bytes(peaks.download)}/s</span></div>
    <MetricGauge value={downloadSpeed} maximum={peaks.download} unit="o/s" label={$t.downloading} />
    {@render activity(history.map((sample) => sample.download), peaks.download)}
  </section>
  <section class="stat-card metric-card upload-card" aria-label={$t.uploadingLabel}>
    <div class="stat-label"><span class="metric-icon"><Icon name="upload" size={17} /></span><span>{$t.uploadingLabel}</span><span class="metric-cap" title={$t.bandwidthPeakHelp}>{bytes(peaks.upload)}/s</span></div>
    <MetricGauge value={uploadSpeed} maximum={peaks.upload} unit="o/s" label={$t.uploadingLabel} />
    {@render activity(history.map((sample) => sample.upload), peaks.upload)}
  </section>
  <section class={['stat-card metric-card disk-card', { 'disk-warning': diskUsage !== null && diskUsage >= 80, 'disk-danger': diskUsage !== null && diskUsage >= 90 }]} aria-label={$t.primaryDisk}>
    <div class="stat-label"><span class="metric-icon"><Icon name="disk" size={17} /></span><span>{$t.primaryDisk}</span><span class="metric-cap">{diskUsage === null ? '— / —' : `${bytes(storage.used ?? storage.total - storage.available)} / ${bytes(storage.total)}`}</span></div>
    <MetricGauge value={diskUsage} unit="%" label={$t.primaryDisk} />
    <div class="disk-segments" aria-hidden="true">{#each { length: 40 } as _, index (index)}<span class={{ filled: diskUsage !== null && index < diskUsage / 2.5, reserve: index >= 36 }}></span>{/each}</div>
  </section>
  <section class="stat-card metric-card services-card" aria-label={$t.serviceLoad}>
    <div class="stat-label"><span class="metric-icon"><Icon name="settings" size={17} /></span><span>{$t.serviceLoad}</span><span class="metric-cap" title={$t.serviceCpuHelp}>CPU</span></div>
    <div class="service-meters">
      {#each serviceNames as service (service.id)}
        {@const cpu = services.find((item) => item.id === service.id)?.cpuPercent ?? null}
        <div class="service-meter" role="img" aria-label={`${service.name}: ${cpu === null ? $t.metricUnavailable : `${cpu.toLocaleString($language, { maximumFractionDigits: 1 })} % CPU`}`} title={$t.serviceCpuHelp}>
          <div class="service-reading"><span>{service.name}</span><strong>{cpu === null ? '—' : cpu.toLocaleString($language, { maximumFractionDigits: 1 })}<small>{cpu === null ? '' : ' %'}</small></strong></div>
          <div class="service-track"><span style:width={`${Math.min(100, Math.max(0, cpu ?? 0))}%`}></span></div>
        </div>
      {/each}
    </div>
  </section>
</div>
<Notification bind:message={error} kind="error" />
<Notification bind:message={notice} kind="success" />
<details class="panel torrent-add">
  <summary><Icon name="plus" size={18} /><strong>{$t.add}</strong><span class="add-description">{$t.torrentsDescription}</span><span class="disclosure-chevron"><Icon name="chevron-right" size={18} /></span></summary>
  <form onsubmit={addTorrent}>
    <fieldset class="add-fields" disabled={busy}>
      <label>{$t.magnetUrl}<input bind:value={source} placeholder="magnet:?xt=urn:btih:…" disabled={busy || !!upload} onblur={(e) => e.currentTarget.form?.requestSubmit()} /></label>
      <label>{$t.torrentFile}<input type="file" accept=".torrent,application/x-bittorrent" onchange={(e) => { upload = e.currentTarget.files?.[0]; if (upload) e.currentTarget.form?.requestSubmit(); }} /></label>
      <button type="submit" class="primary icon-button" title={$t.add} aria-label={$t.add} aria-busy={busy} disabled={busy || (!source.trim() && !upload)}><Icon name="send" /></button>
    </fieldset>
  </form>
</details>
<section class="panel transfers-panel" aria-label={$t.transfers}>
  <div class="toolbar"><input class="search" aria-label={$t.search} placeholder={$t.search} bind:value={query} oninput={() => { currentPage = 1; }} /><select aria-label={$t.sort} bind:value={sort} onchange={() => { currentPage = 1; }}><option value="progress">{$t.progress}</option><option value="name">{$t.name}</option><option value="speed">{$t.speed}</option></select><div class="spacer"></div><label class="check-label"><input type="checkbox" bind:checked={mine} onchange={() => { currentPage = 1; }} />{$t.mine}</label><select aria-label={$t.transferCount} bind:value={limit} onchange={() => { currentPage = 1; }}><option value={25}>25 / page</option><option value={50}>50 / page</option><option value={100}>100 / page</option></select></div>
  {#if loading}
    <div class="empty"><p>{$t.loading}</p></div>
  {:else if rows.length === 0}
    <div class="empty"><p>{query || mine ? $t.noMatchingTransfers : $t.empty}</p></div>
  {:else}
    <div class="table-wrap">
      <!-- Preserve table semantics when CSS displays rows as cards. -->
      <!-- svelte-ignore a11y_no_redundant_roles -->
      <table role="table" aria-label={$t.transfers}>
        <thead role="rowgroup"><tr role="row"><th scope="col">{$t.name}</th><th scope="col">{$t.progress}</th><th scope="col">{$t.speed}</th><th scope="col">{$t.state}</th><th scope="col"><span class="sr-only">{$t.actions}</span></th></tr></thead>
        <tbody role="rowgroup">
          {#each rows as torrent (torrent.hash)}
            <tr role="row">
              <td class="name-cell" role="cell"><div class="torrent-name"><span class="file-glyph"><Icon name="transfer" /></span><div class="name-detail"><a class="torrent-link" href={`/api/torrents/${encodeURIComponent(torrent.hash)}`} data-sveltekit-reload><strong title={torrent.name}>{torrent.name}</strong></a><small>{bytes(torrent.size)} · ratio {torrent.ratio.toFixed(2)} · {torrent.peers} {$t.peers}</small></div></div></td>
              <td class="progress-cell" role="cell"><span class="mobile-label" aria-hidden="true">{$t.progress}</span><div class="progress-caption"><span>{(torrent.progress * 100).toFixed(0)} %</span><span>{#if torrent.progress < 1}{duration(torrent.eta)}{:else}<Icon name="check" size={14} />{/if}</span></div><div class="progress" role="progressbar" aria-label={torrent.name} aria-valuenow={Math.round(torrent.progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style:width={`${torrent.progress * 100}%`}></span></div></td>
              <td role="cell"><span class="mobile-label" aria-hidden="true">{$t.speed}</span><span class="transfer-speed accent"><Icon name="download" size={14} />{bytes(torrent.downloadSpeed)}/s</span><small class="transfer-speed muted"><Icon name="upload" size={14} />{bytes(torrent.uploadSpeed)}/s</small></td>
              <td role="cell"><span class="mobile-label" aria-hidden="true">{$t.state}</span><span class={['badge', { good: torrent.progress >= 1 && !stopped(torrent.state), bad: /error|missing/i.test(torrent.state) }]}>{stateLabel(torrent.state, torrent.progress)}</span></td>
              <td class="actions-cell" role="cell"><div class="row-actions"><button class="icon-button" disabled={busy} title={stopped(torrent.state) ? $t.resume : $t.pause} aria-label={stopped(torrent.state) ? $t.resume : $t.pause} onclick={() => action(torrent, stopped(torrent.state) ? 'start' : 'stop')}><Icon name={stopped(torrent.state) ? 'play' : 'pause'} size={18} /><span class="action-label">{stopped(torrent.state) ? $t.resume : $t.pause}</span></button><button class="icon-button warning" disabled={busy} title={$t.remove} aria-label={$t.remove} onclick={() => askRemove(torrent, false)}><Icon name="x" size={18} /><span class="action-label">{$t.removeShort}</span></button><button class="icon-button danger" disabled={busy} title={$t.delete} aria-label={$t.delete} onclick={() => askRemove(torrent, true)}><Icon name="trash" size={18} /><span class="action-label">{$t.deleteShort}</span></button></div></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  <div class="panel-bottom"><span>{filtered.length} {$t.transfers.toLocaleLowerCase()} <span class="muted">·</span> <span class="loading-indicator"><span class="tiny-dot"></span>{connected ? $t.live : $t.connecting}</span></span><div class="pagination"><button aria-label={$t.previousPage} disabled={currentPage <= 1} onclick={() => currentPage--}><Icon name="chevron-left" size={18} /></button><span>{currentPage} / {pages}</span><button aria-label={$t.nextPage} disabled={currentPage >= pages} onclick={() => currentPage++}><Icon name="chevron-right" size={18} /></button></div></div>
</section>
<Modal bind:open={removeOpen} title={deleteData ? $t.delete : $t.remove}>{#if removal}<p><strong>{removal.name}</strong></p><p>{deleteData ? $t.deleteTorrentHelp : $t.removeTorrentHelp}</p><div class="dialog-actions"><button class="secondary" onclick={() => { removeOpen = false; }}>{$t.cancel}</button><button class={['primary', { destructive: deleteData }]} disabled={busy} onclick={() => removal && action(removal, deleteData ? 'delete' : 'remove', deleteData)}>{deleteData ? $t.deletePermanently : $t.remove}</button></div>{/if}</Modal>
<style>
  .transfer-stats{align-items:stretch}
  .metric-card{--chart-color:var(--accent-ink);position:relative;overflow:hidden;background:linear-gradient(145deg,color-mix(in srgb,var(--chart-color) 7%,var(--surface-container)),var(--surface-container));border:1px solid color-mix(in srgb,var(--chart-color) 15%,var(--line));padding:16px 18px 12px}
  .upload-card{--chart-color:light-dark(#366a87,#96c9e8)}
  .services-card{--chart-color:light-dark(#6e5594,#c7b3e7)}
  .disk-card{--chart-color:light-dark(#926326,#e5c18c)}
  .disk-warning{--chart-color:var(--warning)}
  .disk-danger{--chart-color:var(--danger)}
  .metric-card .stat-label{gap:7px;margin-bottom:10px;white-space:nowrap;font-weight:500;flex-wrap:wrap}
  .metric-icon{display:flex;color:var(--chart-color)}
  .metric-cap{margin-left:auto;font-size:10px;color:var(--muted);font-weight:400}
  .activity-chart{display:block;width:100%;height:30px;margin-top:12px;overflow:visible;color:var(--chart-color)}
  .chart-grid{stroke:var(--line);stroke-width:.6;opacity:.45;fill:none}
  .activity-chart polygon{fill:currentColor;opacity:.13}
  .activity-chart polyline{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
  .service-meters{display:grid;gap:9px;padding-top:3px}
  .service-reading{display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:1.2;margin-bottom:5px}
  .service-reading strong{font-weight:500;font-variant-numeric:tabular-nums}
  .service-reading small{font-weight:400;color:var(--muted);font-size:10px}
  .service-track{height:4px;border-radius:var(--shape-full);background:var(--surface-container-highest);overflow:hidden}
  .service-track span{display:block;height:100%;background:var(--chart-color);border-radius:inherit;transition:width .6s ease}
  .disk-segments{display:flex;gap:3px;height:22px;margin-top:8px;align-items:center}
  .disk-segments span{flex:1;height:14px;min-width:0;border-radius:2px;background:var(--surface-container-highest)}
  .disk-segments .reserve{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 50%,transparent)}
  .disk-segments .filled{background:var(--chart-color)}
  @media(max-width:700px){
    .transfer-stats{padding-bottom:0;border-bottom:0;gap:10px}
    .transfer-stats .stat-card.metric-card{padding:12px;background:linear-gradient(145deg,color-mix(in srgb,var(--chart-color) 7%,var(--surface-container)),var(--surface-container));border-radius:var(--shape-lg)}
    .metric-card .stat-label{font-size:11px;gap:5px}
    .metric-cap{font-size:9px}
    .metric-icon{display:none}
    .service-meters{gap:8px}
    .disk-segments{gap:2px}
  }
  @media(prefers-reduced-motion:reduce){.service-track span{transition:none}}

  .torrent-add{margin-bottom:14px}
  .torrent-add summary{display:flex;align-items:center;gap:8px;min-height:48px;padding:12px 16px;background:var(--accent);color:var(--accent-text);border-radius:var(--shape-lg);cursor:pointer;list-style:none}
  .torrent-add summary:hover{background:color-mix(in srgb,var(--accent) 92%,var(--accent-text))}
  .torrent-add summary::-webkit-details-marker{display:none}
  .torrent-add summary:focus-visible{outline:3px solid var(--accent-text);outline-offset:-6px}
  .add-description{font-size:12px}
  .disclosure-chevron{margin-left:auto;display:flex}
  .torrent-add[open] .disclosure-chevron{transform:rotate(90deg)}
  .add-fields{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto;align-items:end;gap:12px;margin:0;padding:16px;border:0;min-width:0}
  .add-fields label,.add-fields input{min-width:0}
  .add-fields label{font-size:12px;gap:6px}
  .add-fields input{padding:9px 12px;min-height:44px}
  .add-fields input[type=file]{padding:0;border:0}
  .add-fields .primary{width:44px;min-height:44px;padding:10px}
  @media(max-width:700px){
    .add-description{display:none}
    .add-fields{grid-template-columns:minmax(0,1fr)}
    .add-fields button{justify-self:end}
  }
  table{table-layout:fixed}
  th:nth-child(2){width:18%}
  th:nth-child(3){width:17%}
  th:nth-child(4){width:14%}
  th:last-child{width:174px}
  td,th{padding:8px 14px}
  .torrent-name,.name-detail{min-width:0}
  .torrent-link{display:block;color:var(--accent-ink)}
  .torrent-link:hover{text-decoration:underline}
  .torrent-name strong{max-width:100%}
  .torrent-name small{line-height:1.6}
  .transfer-speed{display:flex;align-items:center;gap:5px;white-space:nowrap}
  small.transfer-speed{margin-top:4px}
  .mobile-label,.action-label{display:none}
  .row-actions .icon-button{display:inline-flex;align-items:center;justify-content:center;gap:7px}
  @media(max-width:1100px){
    .table-wrap{overflow:visible}
    table,tbody{display:block;width:100%}
    thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    tbody{padding:12px;display:grid;gap:12px}
    tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:12px;background:var(--surface-container);border:0;border-radius:var(--shape-lg)}
    td{padding:0;border:0;min-width:0}
    .name-cell,.progress-cell,.actions-cell{grid-column:1/-1}
    .torrent-name{max-width:none;align-items:flex-start}
    .torrent-name strong{white-space:normal;overflow-wrap:anywhere;font-size:14px;line-height:1.5}
    .torrent-name small{font-size:12px;margin-top:5px}
    .mobile-label{display:block;color:var(--muted);font-size:12px;margin-bottom:5px}
    .progress-caption{font-size:12px}
    .progress{height:6px}
    .badge{white-space:normal;line-height:1.4}
    .row-actions{justify-content:flex-start;flex-wrap:wrap;gap:6px;padding-top:8px;border-top:1px solid var(--line)}
    .row-actions .icon-button{padding:10px 14px;font-size:13px;min-height:44px}
    .action-label{display:inline}
    .panel-bottom{flex-wrap:wrap;gap:16px}
    .pagination{margin-left:auto}
  }
  @media(max-width:700px){
    .transfers-panel{background:transparent;border-radius:0;overflow:visible}
    tbody{padding:0;gap:0}
    tr{padding:12px 0;gap:10px;background:transparent;border-radius:0}
    tr+tr{border-top:1px solid var(--line)}
    .file-glyph{width:20px;height:20px;background:transparent;border-radius:0}
    .row-actions{flex-wrap:nowrap;gap:6px;padding-top:0;border-top:0}
    .row-actions .icon-button{flex:1;min-width:0;gap:4px;padding:8px 4px;font-size:12px}
    .action-label{white-space:nowrap}
  }
</style>
