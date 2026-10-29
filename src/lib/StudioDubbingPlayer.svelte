<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '#lib/i18n.js';
  let { videoSrc, audioSrc, offset = $bindable(0), onplay }: { videoSrc: string; audioSrc: string; offset?: number; onplay?: () => void } = $props();
  let video = $state<HTMLVideoElement>(), audio = $state<HTMLAudioElement>();
  let playing = $state(false), buffering = $state(false), failed = $state(false);
  let position = $state(0), videoDuration = $state(0), audioPosition = $state(0), audioDuration = $state(0);
  let rate = $state(1), originalAudio = $state(false), volume = $state(1);
  let lastOffset = NaN, pendingSeek = false, alive = true;
  const starting = new WeakSet<HTMLMediaElement>();
  const ready = $derived(Number.isFinite(videoDuration) && videoDuration > 0 && Number.isFinite(audioDuration) && audioDuration > 0 && !failed);
  const timecode = (seconds: number) => !Number.isFinite(seconds) ? '—' : `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}`;

  export function pause() {
    playing = false; buffering = false;
    video?.pause(); audio?.pause();
  }
  function fail() { failed = true; pause(); }
  function start(media: HTMLMediaElement) {
    if (!media.paused || starting.has(media)) return;
    starting.add(media);
    void media.play().catch((cause: Error) => {
      if (alive && playing && cause.name !== 'AbortError') fail();
    }).finally(() => starting.delete(media));
  }
  function synchronize(force = false) {
    if (!video || !audio || !Number.isFinite(offset) || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    pendingSeek ||= force || offset !== lastOffset;
    const target = video.currentTime - offset;
    const audible = target >= 0 && target < audio.duration;
    const bounded = Math.max(0, Math.min(target, audio.duration));
    if (!audio.seeking) {
      if ((pendingSeek || Math.abs(audio.currentTime - bounded) > 0.04) && audio.currentTime !== bounded) audio.currentTime = bounded;
      lastOffset = offset; pendingSeek = false;
    }
    video.playbackRate = audio.playbackRate = rate;
    if (video.ended) { pause(); return; }
    if (!playing) { video.pause(); audio.pause(); return; }
    buffering = video.seeking || video.readyState < 3 || (audible && (audio.seeking || audio.readyState < 3));
    if (buffering) { video.pause(); audio.pause(); return; }
    start(video);
    if (audible) start(audio); else audio.pause();
  }
  function toggle() {
    if (playing) { pause(); return; }
    if (!ready) return;
    playing = true;
    if (video?.ended) video.currentTime = 0;
    onplay?.();
    // Start loading within the user gesture, including browsers that ignore preload.
    if (video && audio) {
      audio.currentTime = Math.max(0, Math.min(video.currentTime - offset, audio.duration));
      start(video);
      start(audio);
    }
    synchronize(true);
  }
  function seek(time: number) {
    if (!video || !Number.isFinite(time) || !Number.isFinite(videoDuration) || videoDuration <= 0) return;
    position = Math.max(0, Math.min(time, videoDuration));
    video.currentTime = position;
    synchronize(true);
  }
  function setOffset(value: number) {
    if (!Number.isFinite(value)) return;
    offset = Math.round(Math.max(-600, Math.min(value, 600)) * 1000) / 1000;
    synchronize(true);
  }
  onMount(() => {
    alive = true;
    const timer = setInterval(() => synchronize(), 50);
    return () => { alive = false; clearInterval(timer); pause(); };
  });
</script>

<div class="dubbing-player" aria-label={$t.studio.dubPlayer}>
  <h3>{$t.studio.dubPlayer}</h3>
  <video bind:this={video} bind:currentTime={position} bind:duration={videoDuration} muted={!originalAudio} playsinline preload="auto" src={videoSrc} onended={pause} onerror={fail} onseeked={() => synchronize(true)} onwaiting={() => synchronize()} oncanplay={() => synchronize()}><track kind="captions" />{$t.browserUnsupported}</video>
  <label class="track-position">{$t.studio.source}<output>{timecode(position)} / {timecode(videoDuration)}</output>
    <input type="range" min="0" max={Number.isFinite(videoDuration) ? videoDuration : 0} step="0.001" value={position} disabled={!ready} oninput={(event) => seek(event.currentTarget.valueAsNumber)} />
  </label>
  <audio bind:this={audio} bind:currentTime={audioPosition} bind:duration={audioDuration} bind:volume preload="auto" src={audioSrc} onerror={fail} oncanplay={() => synchronize()} onwaiting={() => synchronize()}></audio>
  <label class="track-position audio-position">{$t.studio.dubAudio}<output>{timecode(audioPosition)} / {timecode(audioDuration)}</output>
    <input type="range" min="0" max={Number.isFinite(audioDuration) ? audioDuration : 0} step="0.001" value={audioPosition} disabled={!ready} oninput={(event) => seek(event.currentTarget.valueAsNumber + offset)} />
  </label>
  <div class="playback-controls">
    <button type="button" class="primary" disabled={!ready} onclick={toggle}>{playing ? $t.studio.dubPause : $t.studio.dubPlay}</button>
    <button type="button" class="secondary" disabled={!ready} aria-label={$t.studio.backTen} onclick={() => seek(position - 10)}>−10 s</button>
    <button type="button" class="secondary" disabled={!ready} aria-label={$t.studio.forwardTen} onclick={() => seek(position + 10)}>+10 s</button>
    <label>{$t.studio.dubSpeed}<select bind:value={rate} onchange={() => synchronize()}><option value={0.5}>0.5×</option><option value={0.75}>0.75×</option><option value={1}>1×</option></select></label>
  </div>
  <div class="sound-controls">
    <label class="checkbox"><input type="checkbox" bind:checked={originalAudio} />{$t.studio.dubOriginalAudio}</label>
    <label>{$t.studio.dubVolume}<input type="range" min="0" max="1" step="0.01" bind:value={volume} /></label>
  </div>
  <div class="offset-controls">
    <label>{$t.studio.dubOffset}<input type="number" min="-600" max="600" step="0.001" value={offset} oninput={(event) => setOffset(event.currentTarget.valueAsNumber)} /></label>
    <div class="fine-tune" role="group" aria-label={$t.studio.dubFineTune}>
      {#each [-0.1, -0.01, 0.01, 0.1] as amount (amount)}
        <button type="button" class="secondary" onclick={() => setOffset(offset + amount)} aria-label={`${amount < 0 ? $t.studio.dubEarlier : $t.studio.dubLater} ${Math.abs(amount)} s`}>{amount > 0 ? '+' : '−'}{Math.abs(amount)} s</button>
      {/each}
    </div>
  </div>
  <p class="help">{$t.studio.dubSync}</p>
  {#if failed}<p class="playback-error" role="alert">{$t.studio.dubPlaybackError}</p>
  {:else if buffering}<p class="help" role="status">{$t.studio.dubBuffering}</p>{/if}
</div>

<style>
  .dubbing-player{display:grid;gap:16px;margin-top:20px}h3{margin:0}video{display:block;width:100%;max-height:60vh;background:#000;border-radius:var(--shape-sm)}.track-position{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between}.track-position output{font-variant-numeric:tabular-nums;color:var(--muted);font-size:.875rem}.track-position input{flex-basis:100%;width:100%}.audio-position{padding:16px;background:var(--panel-hover);border:1px solid var(--line);border-radius:var(--shape-sm)}.playback-controls,.sound-controls,.offset-controls,.fine-tune{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.playback-controls label{min-width:130px}.sound-controls{align-items:center;justify-content:space-between}.sound-controls label:not(.checkbox){min-width:180px}.checkbox{display:flex;align-items:center;gap:8px}.checkbox input{width:auto}.offset-controls>label{flex:1;min-width:180px}.fine-tune{padding-bottom:1px}.help{margin:0}.playback-error{color:var(--danger);margin:0}
  @media(max-width:700px){.playback-controls>button:first-child{flex-basis:100%}.playback-controls label{flex:1}.sound-controls{align-items:stretch;flex-direction:column}.offset-controls>label{flex-basis:100%}.fine-tune{width:100%}.fine-tune button{flex:1;padding-inline:8px}.track-position output{flex-basis:100%}}
</style>
