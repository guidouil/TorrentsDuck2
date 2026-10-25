import { requireSourceManager } from '#lib/server/permissions.js';

export async function load(event: import('@sveltejs/kit').RequestEvent) {
  await requireSourceManager(event);
  return {};
}
