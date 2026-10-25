<script lang="ts">
  import { language } from '#lib/i18n.js';
  import { bytes } from '#lib/client.js';
  let { value, maximum = 100, unit, label }: { value: number | null; maximum?: number; unit: string; label: string } = $props();
  const percent = $derived(value === null || maximum <= 0 ? 0 : Math.min(100, Math.max(0, value / maximum * 100)));
  const byteReading = $derived(bytes(value ?? 0).split(' '));
  const formatted = $derived(value === null ? '—' : unit === 'o/s' ? byteReading[0] : value.toLocaleString($language, { maximumFractionDigits: 1 }));
  const displayedUnit = $derived(unit === 'o/s' ? `${byteReading[1]}/s` : unit);
  const formattedMaximum = $derived(unit === 'o/s' ? `${bytes(maximum)}/s` : `${maximum.toLocaleString($language, { maximumFractionDigits: 1 })} ${unit}`);
</script>

<div class="gauge" role="img" aria-label={`${label}: ${formatted} ${displayedUnit} / ${formattedMaximum}`}>
  <svg viewBox="0 0 200 110" aria-hidden="true" focusable="false">
    <path class="ticks" d="M14 100 A86 86 0 0 1 186 100" pathLength="100" />
    <path class="track" d="M28 100 A72 72 0 0 1 172 100" pathLength="100" />
    <path class={['fill', { unknown: value === null }]} d="M28 100 A72 72 0 0 1 172 100" pathLength="100" stroke-dasharray={`${percent} 100`} />
  </svg>
  <div class="reading" aria-hidden="true"><strong>{formatted}</strong><span>{displayedUnit}</span></div>
</div>

<style>
  .gauge{container-type:inline-size;position:relative;width:100%;max-width:220px;margin:0 auto;color:var(--chart-color,var(--accent-ink))}
  svg{display:block;width:100%;overflow:visible;fill:none}
  .ticks{stroke:var(--control-line);stroke-width:4;stroke-dasharray:.5 4.5;opacity:.5}
  .track,.fill{stroke-width:9;stroke-linecap:round}
  .track{stroke:var(--surface-container-highest)}
  .fill{stroke:currentColor;transition:stroke-dasharray .6s ease}
  .unknown{visibility:hidden}
  .reading{position:absolute;inset:auto 0 0;display:flex;align-items:baseline;justify-content:center;gap:5px;color:var(--text);white-space:nowrap;font-variant-numeric:tabular-nums}
  strong{font-size:clamp(19px,17cqi,34px);font-weight:500;letter-spacing:-1px;line-height:1.2}
  span{font-size:clamp(8px,6cqi,12px);color:var(--muted)}
  @media(max-width:480px){.gauge{max-width:180px}}
  @media(prefers-reduced-motion:reduce){.fill{transition:none}}
</style>
