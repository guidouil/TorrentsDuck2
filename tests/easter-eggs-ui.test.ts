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
  runInNewContext(transpile(`${script}\nglobalThis.egg = { keydown, dismiss, message: () => message, matrix: () => matrix };`), context);
  const preventDefault = vi.fn();
  const key = (key: string, overrides = {}) => context.egg.keydown({ key, target: new Element(), preventDefault, ...overrides });
  return {
    key, preventDefault, message: context.egg.message, matrix: context.egg.matrix, dismiss: context.egg.dismiss, cleanup: () => cleanup(),
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
    for (const code of ['iddqd', 'matrix']) {
      egg.press(code.slice(0, -1));
      egg.key(code.at(-1)!, { [flag]: true });
      egg.press(code.at(-1)!);
      expect(egg.message()).toBe('');
      expect(egg.matrix()).toBe(false);
    }
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
    for (const code of ['iddqd', 'matrix']) {
      egg.press(code.slice(0, -1));
      egg.key(code.at(-1)!, { target });
      egg.press(code.at(-1)!);
      expect(egg.message()).toBe('');
      expect(egg.matrix()).toBe(false);
    }
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

  it.each(['iddqd', 'matrix'])('cancels the %s timer when unmounted', (code) => {
    const egg = mount();
    egg.press(code);
    expect(vi.getTimerCount()).toBe(1);
    egg.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Matrix easter egg', () => {
  it.each(['matrix', 'MATRIX'])('activates the effect with %s without consuming keys', (code) => {
    const egg = mount();
    egg.press(code);
    expect(egg.matrix()).toBe(true);
    expect(egg.message()).toBe('');
    expect(egg.preventDefault).not.toHaveBeenCalled();
  });

  it('stays visible for 6500 ms and renews its single timer on another activation', () => {
    const egg = mount();
    egg.press('matrix');
    vi.advanceTimersByTime(6499);
    expect(egg.matrix()).toBe(true);
    egg.press('matrix');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(6499);
    expect(egg.matrix()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(egg.matrix()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['Escape', 'close'])('dismisses immediately with %s and clears the timer', (action) => {
    const egg = mount();
    egg.press('matrix');
    if (action === 'Escape') egg.key('Escape', { target: new Element('input') });
    else egg.dismiss();
    expect(egg.matrix()).toBe(false);
    expect(egg.message()).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces a notification and yields to another easter egg', () => {
    const egg = mount();
    egg.press('iddqd');
    egg.press('matrix');
    expect(egg.matrix()).toBe(true);
    expect(egg.message()).toBe('');
    egg.press(konami);
    expect(egg.matrix()).toBe(false);
    expect(egg.message()).toBe('Konami found');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps a pending code when a previous notification expires', () => {
    const egg = mount();
    egg.press('iddqd');
    vi.advanceTimersByTime(4199);
    egg.press('mat');
    vi.advanceTimersByTime(1);
    egg.press('rix');
    expect(egg.matrix()).toBe(true);
  });
});
