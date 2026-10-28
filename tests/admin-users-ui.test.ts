import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { compile } from 'svelte/compiler';
// @ts-expect-error Compiled SSR output uses this runtime, which has no public declarations.
import * as server from 'svelte/internal/server';
import { render } from 'svelte/server';
import { get } from 'svelte/store';
import { transpile } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { language, t } from '../src/lib/i18n';

const component = readFileSync(new URL('../src/routes/(app)/admin/+page.svelte', import.meta.url), 'utf8');
const script = component.split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
const compiled = compile(component
  .replace('let { data } = $props();', 'let { data, fixtureUsers, fixtureTab, fixtureQuery, fixtureState } = $props();')
  .replace('$state<any[]>([])', '$state<any[]>(fixtureUsers)')
  .replace("$state<'members' | 'pending'>('members')", "$state<'members' | 'pending'>(fixtureTab)")
  .replace("let query = $state('')", 'let query = $state(fixtureQuery)')
  .replace('let loading = $state(true)', 'let loading = $state(fixtureState.loading ?? false)')
  .replace('let busy = $state(false)', 'let busy = $state(fixtureState.busy ?? false)')
  .replace('let deletePendingOpen = $state(false)', 'let deletePendingOpen = $state(fixtureState.deletePendingOpen ?? false)'),
{ generate: 'server', filename: '+page.svelte' }).js.code
  .replace(/^import .+;\s*$/gm, '').replace('export default function', 'function');
const modal = compile('<script>let { open, title, children } = $props();</script>{#if open}<section aria-label={title}>{@render children?.()}</section>{/if}',
  { generate: 'server', filename: 'Modal.svelte' }).js.code
  .replace(/^import .+;\s*$/gm, '').replace('export default function', 'function');

const approved = { id: 'member', username: 'Member', email: 'member@example.invalid', approved: true, enabled: true, emailVerified: false, role: 'member', createdAt: '2026-10-01T12:00:00Z' };
const pending = { ...approved, id: 'pending', username: 'PrivateDuck', email: 'private@example.invalid', approved: false };
const disabled = { ...pending, id: 'disabled', username: 'DisabledDuck', email: 'disabled@example.invalid', enabled: false };
const users = [approved, pending, disabled];

function renderPage(members = users, tab = 'members', query = '', state = {}) {
  const Page = runInNewContext(`${compiled}\n_page;`, {
    $: server, t, language, onMount: () => {}, Notification: () => {},
    Modal: runInNewContext(`${modal}\nModal;`, { $: server })
  });
  return render(Page, { props: { data: { user: { id: 'admin' } }, fixtureUsers: members, fixtureTab: tab, fixtureQuery: query, fixtureState: state } }).body;
}

function mount(api: ReturnType<typeof vi.fn>) {
  const context: Record<string, any> = {
    api, onMount: () => {}, $props: () => ({ data: { user: { id: 'admin' } } }),
    $state: (value: unknown) => value, $derived: (value: unknown) => value
  };
  runInNewContext(transpile(`${script}\nglobalThis.admin = { load, updateUser, askDeletePending, deletePendingUsers, search: (value) => { query = value; tab = 'pending'; }, state: () => ({ users, busy, error, loading, deletePendingOpen, query, tab }) };`), context);
  return context.admin;
}

afterEach(() => language.set('fr'));

describe('administrator account tabs', () => {
  it.each(['fr', 'en'] as const)('separates approved members and pending accounts and shows their emails in %s', (locale) => {
    language.set(locale);
    const labels = get(t);
    const members = renderPage();
    const waiting = renderPage(users, 'pending');
    expect(members).toContain(`${labels.members} (1)`);
    expect(members).toContain(`${labels.pending} (2)`);
    expect(members).toContain(approved.email);
    expect(members).not.toContain(pending.email);
    expect(waiting).toContain(pending.email);
    expect(waiting).toContain(disabled.email);
    expect(waiting).not.toContain(approved.email);
    expect(waiting).toContain(labels.approve);
    expect(waiting).toContain(labels.pendingAccountsHelp);
    expect(waiting).toMatch(/aria-pressed="true"[^>]*>Pending \(2\)|aria-pressed="true"[^>]*>En attente \(2\)/);
  });

  it.each(['PRIVATEDUCK', 'PRIVATE@EXAMPLE.INVALID'])('searches pending accounts by username or email: %s', (query) => {
    const body = renderPage(users, 'pending', query);
    expect(body).toContain(pending.email);
    expect(body).not.toContain(disabled.email);
    expect(body).not.toContain(approved.email);
  });

  it('distinguishes an empty waiting list from a search with no matches', () => {
    expect(renderPage([approved], 'pending')).toContain(get(t).noPendingAccounts);
    expect(renderPage(users, 'pending', 'absent')).toContain(get(t).noResults);
    expect(renderPage(users, 'pending', 'absent')).not.toContain(get(t).noPendingAccounts);
  });

  it('moves an approved account to Members and refreshes both counters without verifying its email', async () => {
    let members = [approved, pending];
    const api = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        members = members.map((user) => user.id === pending.id ? { ...user, approved: true } : user);
        return { user: members[1] };
      }
      return url === '/api/admin/users' ? { users: members } : { backup: null };
    });
    const page = mount(api);
    await page.load();
    await page.updateUser({ user: pending, approved: true });
    expect(api).toHaveBeenCalledWith('/api/admin/users', { method: 'POST', body: JSON.stringify({ id: pending.id, approved: true }) });
    expect(page.state()).toMatchObject({ busy: false, error: '', loading: false });
    expect(page.state().users[1]).toMatchObject({ approved: true, emailVerified: false });
    const waiting = renderPage(page.state().users, 'pending');
    expect(waiting).toContain(`${get(t).pending} (0)`);
    expect(waiting).toContain(get(t).noPendingAccounts);
    expect(waiting).not.toContain(pending.email);
    const memberList = renderPage(page.state().users);
    expect(memberList).toContain(`${get(t).members} (2)`);
    expect(memberList).toContain(pending.email);
  });

  it('keeps the account pending and restores its actions after a failed approval', async () => {
    const api = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') throw new Error('Approval failed');
      return url === '/api/admin/users' ? { users: [pending] } : { backup: null };
    });
    const page = mount(api);
    await page.load();
    await page.updateUser({ user: pending, approved: true });
    expect(page.state()).toMatchObject({ users: [pending], busy: false, error: 'Approval failed' });
    expect(renderPage(page.state().users, 'pending')).toContain(pending.email);
  });
});

describe('deleting all pending accounts', () => {
  it('offers deletion only in Pending and uses the total pending count despite the search', () => {
    const labels = get(t);
    const deleteButton = (body: string) => body.match(new RegExp(`<button[^>]*>${labels.deleteAll}</button>`))?.[0];
    expect(deleteButton(renderPage())).toBeUndefined();
    expect(deleteButton(renderPage(users, 'pending', 'absent'))).not.toContain('disabled');
    expect(deleteButton(renderPage([approved], 'pending'))).toContain('disabled');
    expect(deleteButton(renderPage(users, 'pending', '', { loading: true }))).toContain('disabled');
    expect(deleteButton(renderPage(users, 'pending', '', { busy: true }))).toContain('disabled');
  });

  it.each(['fr', 'en'] as const)('requires confirmation for every pending account, including filtered ones, in %s', (locale) => {
    language.set(locale);
    const labels = get(t);
    const api = vi.fn();
    const page = mount(api);
    page.askDeletePending();
    expect(page.state().deletePendingOpen).toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(renderPage(users, 'pending')).not.toContain(labels.confirmDeletePendingAccounts.replace('{count}', '2'));
    const body = renderPage(users, 'pending', 'PRIVATE', { deletePendingOpen: true });
    expect(body).toContain(labels.confirmDeletePendingAccounts.replace('{count}', '2'));
    expect(body).toContain(labels.deletePendingAccountsHelp);
    expect(body).toContain(labels.cancel);
    expect(body).toContain(labels.deletePermanently);
  });

  it('deletes all pending accounts even while filtered and preserves approved members', async () => {
    let members = [...users];
    const api = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') { members = members.filter((user) => user.approved); return { deleted: 2 }; }
      return url === '/api/admin/users' ? { users: members } : { backup: null };
    });
    const page = mount(api);
    await page.load();
    page.search('PRIVATE');
    page.askDeletePending();
    await page.deletePendingUsers();
    expect(api).toHaveBeenCalledWith('/api/admin/users', { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
    expect(page.state()).toMatchObject({ users: [approved], busy: false, error: '', deletePendingOpen: false, query: 'PRIVATE' });
    const body = renderPage(page.state().users, 'pending', page.state().query);
    expect(body).toContain(`${get(t).pending} (0)`);
    expect(body).toContain(`${get(t).members} (1)`);
    expect(body).toContain(get(t).noPendingAccounts);
    expect(renderPage(page.state().users)).toContain(approved.email);
  });

  it('keeps confirmation open and restores actions when deletion fails', async () => {
    const api = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') throw new Error('Deletion failed');
      return url === '/api/admin/users' ? { users } : { backup: null };
    });
    const page = mount(api);
    await page.load();
    page.askDeletePending();
    await page.deletePendingUsers();
    expect(page.state()).toMatchObject({ users, busy: false, error: 'Deletion failed', deletePendingOpen: true });
  });

  it('ignores a second confirmation while deletion is running', async () => {
    let finish!: (value: unknown) => void;
    const api = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') return new Promise((resolve) => { finish = resolve; });
      return url === '/api/admin/users' ? { users } : { backup: null };
    });
    const page = mount(api);
    page.askDeletePending();
    const deleting = page.deletePendingUsers();
    await page.deletePendingUsers();
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/admin/users', { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
    expect(page.state()).toMatchObject({ busy: true, deletePendingOpen: true });
    finish({ deleted: 2 });
    await deleting;
    expect(page.state()).toMatchObject({ busy: false, deletePendingOpen: false });
  });
});
