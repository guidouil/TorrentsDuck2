<script lang="ts" module>
  const paths = {
    transfer: 'M7 3v18m-4-4 4 4 4-4M17 21V3m-4 4 4-4 4 4',
    files: 'M3 7h7l2 2h9v11H3zM3 7V4h7l2 3',
    chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0ZM7 10h8M7 14h5',
    settings: 'm10 3-1 3-3 1-3-1-1 4 2 2v2l-2 2 2 4 3-1 2 1 1 3h4l1-3 2-1 3 1 2-4-2-2v-2l2-2-2-4-3 1-3-1-1-3zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    sun: 'M12 3V1m0 22v-2M3 12H1m22 0h-2M5.6 5.6 4.2 4.2m15.6 15.6-1.4-1.4m0-12.8 1.4-1.4M4.2 19.8l1.4-1.4M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
    moon: 'M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z',
    user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2',
    logout: 'M9 4H4v16h5m5-12 4 4-4 4m-5-4h13',
    plus: 'M12 5v14M5 12h14',
    download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    upload: 'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5',
    library: 'M4 3v18M9 3v18M14 3v18m3-17 4 16',
    disk: 'm5 3-3 12v6h20v-6L19 3ZM2 15h20m-5 3h2',
    file: 'M14 2H4v20h16V8Zm0 0v6h6M8 13h8m-8 4h5',
    folder: 'M3 7h7l2 2h9v11H3zM3 7V4h7l2 3',
    play: 'm8 4 13 8-13 8Z',
    pause: 'M8 4v16M16 4v16',
    share: 'M14 3h7v7m0-7L10 14M10 5H3v16h16v-7',
    edit: 'm16 3 5 5-12 12-6 1 1-6ZM13 6l5 5',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    x: 'm6 6 12 12M6 18 18 6',
    'minus-circle': 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 12h8',
    'chevron-left': 'm15 5-7 7 7 7',
    'chevron-right': 'm9 5 7 7-7 7',
    check: 'm5 12 4 4L19 6',
    send: 'm22 2-7 20-4-9L2 9Zm0 0L11 13',
    duck: 'M3 12c3 1 6 1 8-1V7a4 4 0 0 1 8 0l3 2-4 2v2c0 5-4 8-9 8-4 0-7-3-7-6l1-3ZM15.5 6.5h.01M8 16c2 1 4 1 6-1'
  };
  export type IconName = keyof typeof paths;
</script>

<script lang="ts">
  let { name, size = 20 }: { name: IconName; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d={paths[name]} />
</svg>

<style>
  svg { display: inline-block; vertical-align: middle; flex-shrink: 0; }
</style>
