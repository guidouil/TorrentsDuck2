import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url }) => {
  const userCode = url.searchParams.get('user_code') ?? '';
  if (!/^[A-Za-z0-9-]{4,32}$/.test(userCode)) return { userCode: '' };
  const { user } = await parent();
  if (!user) redirect(303, `/login?user_code=${encodeURIComponent(userCode)}`);
  return { userCode };
};
