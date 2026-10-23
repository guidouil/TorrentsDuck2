import { requireAdmin } from '#lib/server/permissions.js';
export async function load(event: import('@sveltejs/kit').RequestEvent) { await requireAdmin(event); return {}; }
