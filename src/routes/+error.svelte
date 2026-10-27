<script lang="ts">
  import { page } from '$app/state';
  import { t } from '#lib/i18n.js';

  const notFound = $derived(page.status === 404);
  const title = $derived(notFound ? $t.notFoundTitle : $t.errorTitle);
  let audio = $state<HTMLAudioElement>();

  function quack() {
    if (!audio) return;
    audio.currentTime = 0;
    void audio.play().catch(() => { /* Sound can be unavailable in the browser. */ });
  }
</script>

<svelte:head>
  <title>{page.status} · {title} · TorrentsDuck2</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<main class="error-page">
  <section aria-labelledby="error-title">
    <p class="eyebrow">TorrentsDuck2 · {page.status}</p>
    {#if notFound}
      <audio bind:this={audio} src="/quack.mp3" preload="none"></audio>
      <div class="error-code">
        <span aria-hidden="true">4</span>
        <div class="pond">
          <span class="zero" aria-hidden="true">0</span>
          <button class="diving-duck" type="button" onclick={quack} aria-label={$t.quack} title={$t.quack}>
            <svg viewBox="0 0 160 170" aria-hidden="true" focusable="false">
              <g class="duck">
                <path class="legs" d="m66 89-9-43m36 43 13-46" />
                <path class="feet" d="m57 48-24-7 11-8-2-13 14 8 12-5-1 17Zm49-3-14-12 11-5 6-13 6 13 13 6-14 9Z" />
                <path class="body" d="M42 126c-8-17-4-38 12-48 9-6 18-6 26-18 8 12 17 12 26 18 16 10 20 31 12 48l-15 22H57Z" />
                <path class="wing" d="M58 108c9-14 29-17 43-4-7 16-25 23-39 16" />
              </g>
              <ellipse class="water" cx="80" cy="141" rx="66" ry="13" />
              <ellipse class="ripple" cx="80" cy="141" rx="52" ry="8" />
              <ellipse class="ripple outer" cx="80" cy="141" rx="73" ry="18" />
            </svg>
          </button>
        </div>
        <span aria-hidden="true">4</span>
      </div>
    {:else}
      <p class="error-code" aria-hidden="true">{page.status}</p>
    {/if}
    <h1 id="error-title">{title}</h1>
    <p class="description">{notFound ? $t.notFoundDescription : $t.errorDescription}</p>
    <a class="button primary" href="/">{$t.backHome}</a>
  </section>
</main>

<style>
  .error-page { display: grid; place-items: center; min-height: 100dvh; padding: 100px 24px 56px; text-align: center; }
  section { width: min(100%, 560px); }
  .eyebrow { color: var(--muted); font-size: 13px; letter-spacing: 1px; margin: 0 0 28px; }
  .error-code { display: flex; align-items: center; justify-content: center; gap: 4px; margin: 0 0 32px; color: var(--accent); font-size: clamp(112px, 25vw, 192px); font-weight: 700; line-height: 1; letter-spacing: -6px; }
  .pond { position: relative; }
  .zero { opacity: .2; }
  .diving-duck { position: absolute; width: 1em; height: 1.07em; left: 50%; bottom: -.08em; transform: translateX(-50%); padding: 0; background: transparent; color: var(--accent); border-radius: var(--shape-lg); }
  svg { display: block; width: 100%; height: 100%; overflow: visible; }
  .legs { stroke: var(--warning); stroke-width: 7; stroke-linecap: round; }
  .feet { fill: var(--warning); }
  .body { fill: var(--accent); }
  .wing { fill: none; stroke: var(--accent-text); stroke-width: 3; stroke-linecap: round; }
  .water { fill: var(--bg); stroke: var(--accent); stroke-width: 2; }
  .ripple { fill: none; stroke: var(--accent); stroke-width: 1.5; transform-origin: 80px 141px; animation: ripple 3s ease-in-out infinite; }
  .outer { opacity: .3; animation-delay: -1.5s; }
  h1 { font-size: clamp(26px, 5vw, 34px); text-wrap: balance; }
  .description { color: var(--muted); line-height: 1.8; max-width: 360px; margin: 20px auto 28px; text-wrap: pretty; }
  .button { min-height: 44px; padding-inline: 24px; }
  @keyframes ripple { 50% { transform: scaleX(1.08); opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .ripple { animation: none; } }
  @media (max-width: 700px) { .error-page { padding-inline: 20px; } }
</style>
