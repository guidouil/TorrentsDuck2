import { query } from './db';

export async function audit(userId: string | null, action: string, details: Record<string, unknown> = {}, target?: string): Promise<void> {
  await query('INSERT INTO audit_log(user_id, action, details, target) VALUES ($1, $2, $3, $4)', [userId, action, JSON.stringify(details), target ?? null]);
}
