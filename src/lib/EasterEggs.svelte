<script lang="ts">
  import { onMount } from 'svelte';
  import Notification from '#lib/Notification.svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n.js';

  let keys: string[] = [];
  let message = $state('');
  let matrix = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => () => clearTimeout(timer));

  function dismiss() {
    message = '';
    matrix = false;
    clearTimeout(timer);
  }

  function keydown(event: KeyboardEvent) {
    if (matrix && event.key === 'Escape') { dismiss(); return; }
    const target = event.target;
    if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey
      || (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"], [role="dialog"], dialog')))) {
      keys = [];
      return;
    }
    keys = [...keys, event.key.toLowerCase()].slice(-10);
    let found = '';
    if (keys.join(' ') === 'arrowup arrowup arrowdown arrowdown arrowleft arrowright arrowleft arrowright b a') found = $t.konamiFound;
    else if (keys.slice(-5).join('') === 'iddqd') found = $t.doomFound;
    const matrixFound = keys.slice(-6).join('') === 'matrix';
    if (!found && !matrixFound) return;
    keys = [];
    message = found;
    matrix = matrixFound;
    clearTimeout(timer);
    timer = setTimeout(dismiss, matrix ? 6500 : 4200);
  }
</script>

<svelte:window onkeydown={keydown} />
<Notification bind:message />

{#if matrix}
  <div class="matrix-overlay">
    <div class="matrix-rain" aria-hidden="true">
      {#each { length: 32 } as _, index (index)}
        <span style:left={`${index * 100 / 32}%`} style:animation-duration={`${3.4 + index % 7 * 0.45}s`} style:animation-delay={`${-(index % 11) * 0.63}s`}>{index % 2 ? 'ﾈ01ﾎﾃ10ｻﾊ01ﾐﾋｰｳｼ10ﾅﾓ01ﾆ' : '01ﾊﾐﾋｰｳｼﾅﾓ10ﾆｻﾜ01ﾂｵﾘ10'}</span>
      {/each}
    </div>
    <p class="matrix-message" role="status">
      {$t.matrixWakeUp}<br />
      <span>{$t.matrixFollowDuck}</span>
      <span class="matrix-duck" aria-hidden="true"><Icon name="duck" size={44} /></span>
    </p>
    <button class="matrix-close" type="button" onclick={dismiss}><Icon name="x" size={18} />{$t.close}</button>
  </div>
{/if}

<style>
  .matrix-overlay{position:fixed;inset:0;z-index:200;display:grid;place-items:center;overflow:hidden;padding:16px;background:rgb(0 8 3 / 94%);color:#89ffa7;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;pointer-events:none;isolation:isolate}
  .matrix-overlay::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0 3px,rgb(65 255 110 / 4%) 3px 4px);pointer-events:none}
  .matrix-rain{position:absolute;inset:0;overflow:hidden;opacity:.6;animation:matrix-glitch 4s steps(1,end) infinite}
  .matrix-rain span{position:absolute;top:0;writing-mode:vertical-rl;text-orientation:upright;font-size:clamp(10px,1.2vw,18px);line-height:1;letter-spacing:5px;color:#31d75b;text-shadow:0 0 8px #1bb144;animation:matrix-fall linear infinite}
  .matrix-message{z-index:1;margin:0;text-align:center;font-size:clamp(18px,3vw,36px);line-height:1.7;letter-spacing:.08em;text-shadow:0 0 18px #27c95a;animation:matrix-glitch 3s steps(1,end) infinite}
  .matrix-duck{display:flex;justify-content:center;margin-top:24px;color:#52ff83;filter:drop-shadow(0 0 10px #27c95a)}
  .matrix-close{position:absolute;right:max(16px,env(safe-area-inset-right));top:max(16px,env(safe-area-inset-top));z-index:1;display:flex;align-items:center;gap:8px;min-height:44px;padding:8px 12px;border:1px solid #326b42;border-radius:8px;background:#061a0d;color:#89ffa7;pointer-events:auto}
  .matrix-close:hover{background:#0e2c18}
  .matrix-close:focus-visible{outline:3px solid #89ffa7;outline-offset:3px}
  @keyframes matrix-fall{from{transform:translateY(-100%)}to{transform:translateY(100dvh)}}
  @keyframes matrix-glitch{0%,30%,34%,62%,66%,100%{transform:none}31%,64%{transform:translateX(2px) skewX(-2deg)}32%,63%{transform:translate(-2px,1px)}33%,65%{transform:translateX(1px)}}
  @media(prefers-reduced-motion:reduce){.matrix-rain,.matrix-rain span,.matrix-message{animation:none}.matrix-rain{opacity:.2}.matrix-rain span{transform:translateY(-15%)}}
</style>
