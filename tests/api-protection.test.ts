import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocked = vi.hoisted(() => ({ member: vi.fn(), query: vi.fn() }));
vi.mock('../src/lib/server/permissions', () => ({ requireMember: mocked.member }));
vi.mock('../src/lib/server/db', () => ({ query: mocked.query }));
beforeEach(() => {
	mocked.member.mockReset().mockRejectedValue({ status: 401 });
	mocked.query.mockReset();
});

describe('anonymous API boundary', () => {
	it.each([
		'../src/routes/api/files/+server',
		'../src/routes/api/files/download/+server',
		'../src/routes/api/files/audio/+server',
		'../src/routes/api/files/share/+server',
		'../src/routes/api/torrents/+server',
		'../src/routes/api/torrents/[hash]/+server',
		'../src/routes/api/events/+server',
		'../src/routes/api/chat/+server',
		'../src/routes/api/studio/+server',
		'../src/routes/api/studio/[id]/+server',
		'../src/routes/api/studio/[id]/jobs/[jobId]/file/+server'
	])('rejects %s before reading collective data', async (route) => {
		const { GET } = await import(route);
		await expect(GET({ request: new Request('http://localhost/api'), url: new URL('http://localhost/api') } as RequestEvent)).rejects.toMatchObject({ status: 401 });
		expect(mocked.query).not.toHaveBeenCalled();
	});
	it.each([
		['../src/routes/api/studio/+server', 'POST'],
		['../src/routes/api/studio/[id]/+server', 'PATCH'],
		['../src/routes/api/studio/[id]/+server', 'DELETE'],
		['../src/routes/api/studio/[id]/jobs/+server', 'POST'],
		['../src/routes/api/studio/[id]/jobs/[jobId]/+server', 'DELETE'],
		['../src/routes/api/studio/[id]/jobs/[jobId]/publish/+server', 'POST']
	])('protects Studio mutation %s %s before accessing private data', async (route, method) => {
		const handlers = await import(route);
		await expect(handlers[method]({ request: new Request('http://localhost/api'), url: new URL('http://localhost/api') } as RequestEvent)).rejects.toMatchObject({ status: 401 });
		expect(mocked.query).not.toHaveBeenCalled();
	});
	it('rejects invalid chat pagination before asking the database', async () => {
		mocked.member.mockResolvedValueOnce({ id: 'member', enabled: true });
		const { GET } = await import('../src/routes/api/chat/+server');
		await expect(GET({ request: new Request('http://localhost/api/chat?before=9999999999999999999'), url: new URL('http://localhost/api/chat?before=9999999999999999999') } as never)).rejects.toMatchObject({ status: 400 });
		expect(mocked.query).not.toHaveBeenCalled();
	});
});
