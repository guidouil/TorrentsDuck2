import { redirect } from '@sveltejs/kit';
export async function load({ parent }: { parent: () => Promise<{ user: { enabled: boolean; approved: boolean } | null }> }) {
  const { user } = await parent();
  if (!user?.enabled) redirect(303, '/login');
  if (!user.approved) redirect(303, '/waiting');
  return {};
}
