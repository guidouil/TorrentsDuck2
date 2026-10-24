import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { get } from 'svelte/store';
import { transpile } from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import { notifications, notificationHosts } from '../src/lib/notifications';

function component(name: string, props = {}, exports = 'id') {
  const script = readFileSync(new URL(`../src/lib/${name}.svelte`, import.meta.url), 'utf8')
    .split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  let effect!: () => (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  const context: Record<string, any> = {
    notifications, notificationHosts,
    $props: () => props, $bindable: (value: unknown) => value,
    $effect: (callback: typeof effect) => { effect = callback; }
  };
  runInNewContext(transpile(`${script}\nglobalThis.component = { ${exports} };`), context);
  return {
    ...context.component,
    runEffect: () => { cleanup?.(); cleanup = effect(); },
    destroy: () => { cleanup?.(); cleanup = undefined; }
  };
}

const notice = (message: string, kind = 'info') => component('Notification', { message, kind }, 'id, message: () => message, setMessage: (value) => { message = value; }');

beforeEach(() => { notifications.set([]); notificationHosts.set([]); });

describe('shared notifications', () => {
  it('publishes only in the browser effect and ignores empty messages', () => {
    const empty = notice('');
    const added = notice('Torrent added', 'success');
    expect(get(notifications)).toEqual([]);
    empty.runEffect();
    expect(get(notifications)).toEqual([]);
    added.runEffect();
    expect(get(notifications)).toMatchObject([{ id: added.id, message: 'Torrent added', kind: 'success' }]);
  });

  it('stacks independent sources and replaces an updated message without duplicates', () => {
    const first = notice('Uploading');
    const second = notice('Connection failed', 'error');
    first.runEffect(); second.runEffect();
    expect(get(notifications).map((item) => item.message)).toEqual(['Uploading', 'Connection failed']);
    first.setMessage('Upload complete');
    first.runEffect();
    expect(get(notifications).map((item) => item.message)).toEqual(['Connection failed', 'Upload complete']);
    expect(get(notifications).filter((item) => item.id === first.id)).toHaveLength(1);
    first.destroy();
    expect(get(notifications)).toMatchObject([{ id: second.id, message: 'Connection failed' }]);
    second.destroy();
    expect(get(notifications)).toEqual([]);
  });

  it('clears a dismissed source and allows the same message to be shown again', () => {
    const added = notice('Torrent added', 'success');
    added.runEffect();
    get(notifications)[0].dismiss();
    expect(added.message()).toBe('');
    added.runEffect();
    expect(get(notifications)).toEqual([]);
    added.setMessage('Torrent added');
    added.runEffect();
    expect(get(notifications)).toMatchObject([{ message: 'Torrent added' }]);
  });
});

describe('notification hosts', () => {
  it.each([false, true])('restores the available host after nested dialogs close (out of order: %s)', (outOfOrder) => {
    const root = component('Notifications');
    const firstModal = component('Notifications', { modal: true });
    const secondModal = component('Notifications', { modal: true });
    root.runEffect();
    expect(get(notificationHosts).at(-1)).toBe(root.id);
    firstModal.runEffect();
    expect(get(notificationHosts).at(-1)).toBe(firstModal.id);
    secondModal.runEffect();
    expect(get(notificationHosts).at(-1)).toBe(secondModal.id);
    if (outOfOrder) {
      firstModal.destroy();
      expect(get(notificationHosts).at(-1)).toBe(secondModal.id);
      secondModal.destroy();
    } else {
      secondModal.destroy();
      expect(get(notificationHosts).at(-1)).toBe(firstModal.id);
      firstModal.destroy();
    }
    expect(get(notificationHosts)).toEqual([root.id]);
    root.destroy();
    expect(get(notificationHosts)).toEqual([]);
  });
});
