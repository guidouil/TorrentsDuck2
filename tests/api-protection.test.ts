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
		'../src/routes/api/files/share/+server',
		'../src/routes/api/torrents/+server',
		'../src/routes/api/torrents/[hash]/+server',
		'../src/routes/api/events/+server',
		'../src/routes/api/chat/+server'
	])('rejects %s before reading collective data', async (route) => {
		const { GET } = await import(route);
		await expect(GET({ request: new Request('http://localhost/api'), url: new URL('http://localhost/api') } as RequestEvent)).rejects.toMatchObject({ status: 401 });
		expect(mocked.query).not.toHaveBeenCalled();
	});
	it('rejects invalid chat pagination before asking the database', async () => {
		mocked.member.mockResolvedValueOnce({ id: 'member', enabled: true });
		const { GET } = await import('../src/routes/api/chat/+server');
		await expect(GET({ request: new Request('http://localhost/api/chat?before=9999999999999999999'), url: new URL('http://localhost/api/chat?before=9999999999999999999') } as never)).rejects.toMatchObject({ status: 400 });
		expect(mocked.query).not.toHaveBeenCalled();
	});
});
