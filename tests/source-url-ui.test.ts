import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/client';

function mountSources(request = vi.fn()) {
  const script = readFileSync(new URL('../src/routes/(app)/search/sources/+page.svelte', import.meta.url), 'utf8').split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = {
    api: request,
    $props: () => ({ data: { user: { role: 'admin' } } }),
    $t: { sourceAdded: 'Added', sourceTestPassed: 'Recognized', sourceRequestFailed: 'Request failed' },
    onMount: () => {}, $state: (value: unknown) => value, $derived: (value: unknown) => value,
  };
  runInNewContext(transpile(`${script}\nglobalThis.sourcesUI = { add, update, setSources: (value) => { sources = value; }, fields: (value) => { name = value.name ?? 'Example'; url = value.url ?? 'https://example.org?q={query}'; authType = value.type ?? 'none'; username = value.username ?? ''; password = value.password ?? ''; token = value.token ?? ''; }, state: () => ({ name, url, authType, username, password, token, diagnostic, error, notice, busy }) };`), context);
  return { ...context.sourcesUI, request, event: { preventDefault: vi.fn() } };
}

function mountDiagnostic(writeText = vi.fn().mockResolvedValue(undefined)) {
  const script = readFileSync(new URL('../src/lib/Diagnostic.svelte', import.meta.url), 'utf8').split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = { navigator: { clipboard: { writeText } }, $props: () => ({ text: 'Safe report' }), $state: (value: unknown) => value };
  runInNewContext(transpile(`${script}\nglobalThis.diagnosticUI = { copy, report: (value) => { report = value; }, state: () => copied };`), context);
  return { ...context.diagnosticUI, writeText };
}

afterEach(() => vi.unstubAllGlobals());

describe('source URL addition', () => {
  it.each([
    ['none', { type: 'none' }],
    ['basic', { type: 'basic', username: 'fixture', password: 'fixture-password' }],
    ['bearer', { type: 'bearer', token: 'fixture-token' }],
    ['apiKey', { type: 'apiKey', token: 'fixture-token' }],
  ])('sends only the selected %s authentication and clears secrets after success', async (type, auth) => {
    const request = vi.fn().mockImplementation(async (_url, options) => options?.method === 'POST' ? { ok: true, diagnostic: 'Safe report' } : { sources: [], canManage: true });
    const source = mountSources(request);
    source.fields({ type, username: 'fixture', password: 'fixture-password', token: 'fixture-token' });
    await source.add(source.event);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ action: 'add', name: 'Example', url: 'https://example.org?q={query}', auth });
    expect(source.state()).toMatchObject({ name: '', url: '', password: '', username: '', token: '', authType: 'none', diagnostic: 'Safe report', notice: 'Added', busy: '' });
  });

  it('prevents duplicate submissions and retains fields for retry without putting them in the report', async () => {
    let reject!: (cause: Error) => void;
    const request = vi.fn().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const source = mountSources(request);
    source.fields({ type: 'basic', username: 'fixture-user', password: 'fixture-password', url: 'https://example.org?apikey=fixture-key' });
    const pending = source.add(source.event);
    await source.add(source.event);
    expect(request).toHaveBeenCalledOnce();
    reject(new Error('Network unavailable'));
    await pending;
    expect(source.state()).toMatchObject({ password: 'fixture-password', error: 'Network unavailable', busy: '' });
    expect(JSON.parse(source.state().diagnostic)).toMatchObject({ phase: 'client', operation: 'add', code: 'SOURCE_REQUEST_FAILED' });
    expect(source.state().diagnostic).not.toMatch(/fixture-user|fixture-password|fixture-key|example\.org/);
  });

  it('keeps the server detection report available for copying after a rejected source', async () => {
    const source = mountSources(vi.fn().mockRejectedValue(Object.assign(new Error('Unsupported format'), { diagnostic: '{"version":1,"code":"UNKNOWN_FORMAT"}' })));
    source.fields({});
    await source.add(source.event);
    expect(source.state()).toMatchObject({ error: 'Unsupported format', diagnostic: '{"version":1,"code":"UNKNOWN_FORMAT"}' });
  });

  it('selects the report for manual copying if clipboard access is unavailable', async () => {
    const diagnostic = mountDiagnostic(vi.fn().mockRejectedValue(new Error('Denied')));
    const report = { focus: vi.fn(), select: vi.fn() };
    diagnostic.report(report);
    await diagnostic.copy();
    expect(report.focus).toHaveBeenCalledOnce();
    expect(report.select).toHaveBeenCalledOnce();
    expect(diagnostic.state()).toEqual({ text: 'Safe report', manual: true });
  });

  it('copies a detection report through the shared component', async () => {
    const diagnostic = mountDiagnostic();
    await diagnostic.copy();
    expect(diagnostic.writeText).toHaveBeenCalledWith('Safe report');
    expect(diagnostic.state()).toEqual({ text: 'Safe report', manual: false });
  });

  it('tests an existing URL without sending credentials back from the browser', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, diagnostic: 'Safe report' });
    const source = mountSources(request);
    await source.update('url:fixture', 'test');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ id: 'url:fixture', action: 'test' });
    expect(source.state()).toMatchObject({ diagnostic: 'Safe report', notice: 'Recognized', busy: '' });
  });

  it('blocks unavailable engine actions while keeping URL sources operable', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, diagnostic: 'Safe report' });
    const source = mountSources(request);
    source.setSources([{ id: 'piratebay', kind: 'plugin', available: false }, { id: 'url:fixture', kind: 'url', available: false }]);
    await source.update('piratebay', 'install');
    expect(request).not.toHaveBeenCalled();
    await source.update('url:fixture', 'test');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ id: 'url:fixture', action: 'test' });
  });
});

describe('client API detection errors', () => {
  it('preserves the server diagnostic without changing ordinary Error handling', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ message: 'Unsupported format', diagnostic: 'Safe report' }, { status: 422 })));
    await expect(api('/api/search/sources')).rejects.toMatchObject({ message: 'Unsupported format', diagnostic: 'Safe report' });
  });

  it('ignores diagnostic values that are not text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ message: 'Rejected', diagnostic: { token: 'fixture' } }, { status: 422 })));
    await expect(api('/api/search/sources')).rejects.toMatchObject({ message: 'Rejected', diagnostic: undefined });
  });
});
