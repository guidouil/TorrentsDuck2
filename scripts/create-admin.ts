import { randomUUID } from 'node:crypto';
import { db, transaction } from '../src/lib/server/db';
import { hashPassword } from '../src/lib/server/passwords';

async function main(): Promise<void> {
  const username = process.env.ADMIN_USERNAME;
  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!username?.trim() || username.length > 128 || /[\x00-\x1f\x7f]/.test(username) || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 12 || password.length > 128) {
    throw new Error('Set ADMIN_USERNAME, ADMIN_EMAIL and ADMIN_PASSWORD (12–128 characters) in the process environment');
  }
  const hash = await hashPassword(password);
  const id = randomUUID();
  await transaction(async (client) => {
    await client.query('LOCK TABLE "user" IN EXCLUSIVE MODE');
    const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM "user"');
    if (count !== 0) throw new Error('Bootstrap requires an empty user database; use the administrator interface for existing users');
    await client.query('INSERT INTO "user"(id,name,username,"displayUsername",email,role,enabled,approved) VALUES ($1,$2,$2,$2,$3,\'admin\',true,true)', [id, username, email]);
    await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES ($1,$2,\'credential\',$2,$3)', [randomUUID(), id, hash]);
  });
  console.log('Administrator created. Remove ADMIN_PASSWORD from the environment.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => db.end());
