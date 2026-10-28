import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { light, skin, skins, restoreTheme, selectSkin, toggleTheme } from '../src/lib/theme.js';

beforeEach(() => { light.set(false); skin.set('duck'); });
afterEach(() => vi.unstubAllGlobals());

function storage(values: Record<string, string | undefined> = {}) {
  const localStorage = {
    getItem: vi.fn((key: string) => values[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { values[key] = value; })
  };
  vi.stubGlobal('localStorage', localStorage);
  return localStorage;
}

describe('interface themes', () => {
  it.each(skins)('applies and restores %s independently from light/dark mode', (value) => {
    const saved = storage({ theme: 'light' });
    restoreTheme();
    selectSkin(value);
    expect(get(skin)).toBe(value);
    expect(saved.setItem).toHaveBeenCalledWith('skin', value);
    toggleTheme();
    expect(get(light)).toBe(false);
    expect(get(skin)).toBe(value);
    expect(saved.setItem).toHaveBeenCalledWith('theme', 'dark');
    skin.set('duck');
    light.set(true);
    restoreTheme();
    expect(get(skin)).toBe(value);
    expect(get(light)).toBe(false);
  });

  it.each([{}, { skin: 'unknown', theme: 'unknown' }])('uses the original dark appearance for missing or invalid preferences: %j', (preferences) => {
    storage(preferences);
    restoreTheme();
    expect(get(skin)).toBe('duck');
    expect(get(light)).toBe(false);
  });

  it('still allows theme selection when browser storage is blocked', () => {
    const denied = () => { throw new Error('Storage unavailable'); };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied });
    expect(restoreTheme).not.toThrow();
    expect(() => selectSkin('ascii')).not.toThrow();
    expect(toggleTheme).not.toThrow();
    expect(get(skin)).toBe('ascii');
    expect(get(light)).toBe(true);
  });
});
