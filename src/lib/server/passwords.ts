import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword } from 'better-auth/crypto';

export { hashPassword };
export const LEGACY_PREFIX = 'meteor$';

export function legacyPasswordHash(bcryptHash: string): string {
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(bcryptHash)) throw new Error('Invalid Meteor bcrypt hash');
  const rounds = Number(bcryptHash.slice(4, 6));
  if (rounds < 4 || rounds > 15) throw new Error('Unsupported Meteor bcrypt cost');
  return LEGACY_PREFIX + bcryptHash;
}

export async function checkPassword(password: string, storedHash: string): Promise<boolean> {
  if (!password || password.length > 1024) return false;
  try {
    if (storedHash.startsWith(LEGACY_PREFIX)) {
      const digest = createHash('sha256').update(password, 'utf8').digest('hex');
      return await bcrypt.compare(digest, storedHash.slice(LEGACY_PREFIX.length));
    }
    return await verifyPassword({ password, hash: storedHash });
  } catch {
    return false;
  }
}
