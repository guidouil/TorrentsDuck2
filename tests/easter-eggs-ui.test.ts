import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Element {
  constructor(readonly tag = 'div', readonly parent?: Element, readonly role = '', readonly editable = false) {}
  get isContentEditable(): boolean { return this.editable || !!this.parent?.isContentEditable; }
  closest(selectors: string): Element | null {
    return selectors.split(',').some((selector) => [this.tag, `[role="${this.role}"]`].includes(selector.trim()))
      ? this : this.parent?.closest(selectors) ?? null;
  }
}

const konami = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

function mount() {
  let cleanup = () => {};
  const script = readFileSync(new URL('../src/lib/EasterEggs.svelte', import.meta.url), 'utf8')
    .split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = {
    HTMLElement: Element, setTimeout, clearTimeout,
    $t: { konamiFound: 'Konami found', doomFound: 'Doom found' },
    $state: (value: unknown) => value,
    onMount: (callback: () => () => void) => { cleanup = callback(); }
  };
  runInNewContext(transpile(`${script}\nglobalThis.egg = { keydown, message: () => message };`), context);
  const preventDefault = vi.fn();
  const key = (key: string, overrides = {}) => context.egg.keydown({ key, target: new Element(), preventDefault, ...overrides });
  return {
    key, preventDefault, message: context.egg.message, cleanup: () => cleanup(),
    press: (keys: string | string[]) => { for (const value of keys) key(value); }
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('discreet keyboard easter eggs', () => {
  it.each([
    [konami, 'Konami found'],
    [konami.map((key) => key.toUpperCase()), 'Konami found'],
    ['iddqd', 'Doom found'],
    ['IDDQD', 'Doom found']
  ])('recognizes the complete sequence %j without consuming keys', (keys, message) => {
    const egg = mount();
    egg.press(keys);
    expect(egg.message()).toBe(message);
    expect(egg.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores incomplete and wrong codes, then recognizes an overlapping prefix', () => {
    const egg = mount();
    egg.press([...konami.slice(0, -1), 'x', 'i', 'd', 'd', 'q', 'x']);
    expect(egg.message()).toBe('');
    egg.press(['ArrowUp', ...konami]);
    expect(egg.message()).toBe('Konami found');
    egg.press('iiddqd');
    expect(egg.message()).toBe('Doom found');
  });

  it.each(['defaultPrevented', 'repeat', 'isComposing', 'ctrlKey', 'altKey', 'metaKey'])('ignores %s events and resets a pending code', (flag) => {
    const egg = mount();
    egg.press('iddq');
    egg.key('d', { [flag]: true });
    expect(egg.message()).toBe('');
    egg.press('d');
    expect(egg.message()).toBe('');
    egg.press('iddqd');
    expect(egg.message()).toBe('Doom found');
  });

  it.each([
    ['input', new Element('input')],
    ['textarea', new Element('textarea')],
    ['select', new Element('select')],
    ['textbox', new Element('span', new Element('div', undefined, 'textbox'))],
    ['nested editable content', new Element('span', new Element('div', undefined, '', true))],
    ['dialog role', new Element('span', new Element('div', undefined, 'dialog'))],
    ['native dialog', new Element('span', new Element('dialog'))]
  ])('leaves %s alone and resets a pending code', (_, target) => {
    const egg = mount();
    egg.press('iddq');
    egg.key('d', { target });
    expect(egg.message()).toBe('');
    egg.press('d');
    expect(egg.message()).toBe('');
    egg.press('iddqd');
    expect(egg.message()).toBe('Doom found');
  });

  it('clears the message after 4200 ms and extends it when another code is entered', () => {
    const egg = mount();
    egg.press('iddqd');
    vi.advanceTimersByTime(4199);
    expect(egg.message()).toBe('Doom found');
    egg.press(konami);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(4199);
    expect(egg.message()).toBe('Konami found');
    vi.advanceTimersByTime(1);
    expect(egg.message()).toBe('');
  });

  it('cancels its timer when unmounted', () => {
    const egg = mount();
    egg.press('iddqd');
    expect(vi.getTimerCount()).toBe(1);
    egg.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});
