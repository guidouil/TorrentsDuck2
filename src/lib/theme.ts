import { writable } from 'svelte/store';

export const skins = ['duck', 'ascii', '8bit', 'corporate'] as const;
export type Skin = typeof skins[number];
export const skin = writable<Skin>('duck');
export const light = writable(false);

export function restoreTheme() {
  try {
    light.set(localStorage.getItem('theme') === 'light');
    const saved = localStorage.getItem('skin');
    skin.set(skins.includes(saved as Skin) ? saved as Skin : 'duck');
  } catch { /* Keep the defaults when browser storage is unavailable. */ }
}

export function selectSkin(value: Skin) {
  skin.set(value);
  try { localStorage.setItem('skin', value); } catch { /* The selection still works for this visit. */ }
}

export function toggleTheme() {
  light.update((value) => {
    const next = !value;
    try { localStorage.setItem('theme', next ? 'light' : 'dark'); } catch { /* The selection still works for this visit. */ }
    return next;
  });
}
