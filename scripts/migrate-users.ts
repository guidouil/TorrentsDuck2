import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db, transaction } from '../src/lib/server/db';
import { legacyPasswordHash } from '../src/lib/server/passwords';

type MeteorUser = {
  _id?: string;
  username?: string;
  emails?: { address: string; verified?: boolean }[];
  createdAt?: string | { $date: string | { $numberLong: string } };
  isAdmin?: boolean;
  isValid?: boolean;
  roles?: string[];
  allowed?: boolean;
  services?: { password?: { bcrypt?: string } };
};

export type ImportedUser = {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  role: 'admin' | 'member';
  enabled: boolean;
  approved: boolean;
  createdAt: Date;
  password: string;
};

function meteorDate(value: MeteorUser['createdAt']): Date {
  const raw = value && typeof value === 'object' ? value.$date : value;
  const date = new Date(raw && typeof raw === 'object' ? Number(raw.$numberLong) : raw ?? NaN);
  if (!Number.isFinite(date.getTime())) throw new Error('Missing or invalid creation date');
  return date;
}

export function prepareUsers(input: unknown): ImportedUser[] {
  const users = Array.isArray(input) ? input : input && typeof input === 'object' && 'users' in input ? input.users : null;
  if (!Array.isArray(users) || !users.length) throw new Error('Expected a non-empty Meteor user array or {users:[...]}');
  const ids = new Set<string>();
  const usernames = new Set<string>();
  const emails = new Set<string>();
  const result = users.map((value: MeteorUser) => {
    if (!value || typeof value._id !== 'string' || !value._id || value._id.length > 200) throw new Error('Missing or invalid legacy id');
    if (typeof value.username !== 'string' || !value.username.trim() || value.username.length > 128 || /[\x00-\x1f\x7f]/.test(value.username)) throw new Error(`Invalid username for legacy id ${value._id}`);
    if (!Array.isArray(value.emails) || value.emails.length !== 1) throw new Error(`Expected one email for legacy id ${value._id}; review this account manually`);
    const primary = value.emails[0];
    if (typeof primary.address !== 'string' || primary.address.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(primary.address)) throw new Error(`Invalid email for legacy id ${value._id}`);
    const email = primary.address.toLowerCase();
    if (ids.has(value._id) || usernames.has(value.username) || emails.has(email)) throw new Error('Duplicate id, username or email; no account was imported');
    ids.add(value._id);
    usernames.add(value.username);
    emails.add(email);
    if (value.isAdmin !== undefined && typeof value.isAdmin !== 'boolean') throw new Error('Invalid isAdmin flag');
    if (value.isValid !== undefined && typeof value.isValid !== 'boolean') throw new Error('Invalid isValid flag');
    const isAdmin = value.isAdmin ?? value.roles?.includes('admin') ?? false;
    const isValid = value.isValid ?? value.allowed;
    if (isValid === undefined && !isAdmin) throw new Error(`Missing access flags for legacy id ${value._id}`);
    const hash = value.services?.password?.bcrypt;
    if (typeof hash !== 'string') throw new Error(`Missing password hash for legacy id ${value._id}`);
    return {
      id: value._id,
      username: value.username,
      email,
      emailVerified: primary.verified === true,
      role: isAdmin ? 'admin' as const : 'member' as const,
      enabled: isAdmin || isValid === true,
      approved: true,
      createdAt: meteorDate(value.createdAt),
      password: legacyPasswordHash(hash)
    };
  });
  if (result.some((user) => emails.has(user.username.toLowerCase()) && user.username.toLowerCase() !== user.email)) {
    throw new Error('A username matches another account email; resolve ambiguous sign-in before import');
  }
  return result;
}

export type ExistingUser = Pick<ImportedUser, 'id' | 'username' | 'email'> & { legacyId: string | null };

export function usersToImport(users: ImportedUser[], existing: ExistingUser[]): ImportedUser[] {
  return users.filter((user) => {
    const matches = existing.filter((current) => current.id === user.id || current.legacyId === user.id ||
      current.username === user.username || current.email.toLowerCase() === user.email ||
      current.username.toLowerCase() === user.email || current.email.toLowerCase() === user.username.toLowerCase());
    if (!matches.length) return true;
    const current = matches[0];
    if (matches.length === 1 && current.username === user.username && current.email.toLowerCase() === user.email &&
      (current.legacyId === null || current.legacyId === user.id)) return false;
    throw new Error('Existing identity conflict; no account was imported');
  });
}

export async function importUsers(users: ImportedUser[], skipExisting = false): Promise<{ imported: number; skipped: number }> {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(782412)');
    await client.query('LOCK TABLE "user" IN EXCLUSIVE MODE');
    const { rows: existing } = await client.query<ExistingUser>('SELECT id,username,email,"legacyId" FROM "user"');
    if (existing.length && !skipExisting) throw new Error('Import requires an empty user database; existing accounts were not changed');
    const pending = usersToImport(users, existing);
    for (const user of pending) {
      await client.query('INSERT INTO "user"(id,name,username,"displayUsername",email,"emailVerified",role,enabled,approved,"legacyId","createdAt","updatedAt") VALUES ($1,$2,$2,$2,$3,$4,$5,$6,true,$1,$7,$7)', [user.id, user.username, user.email, user.emailVerified, user.role, user.enabled, user.createdAt]);
      await client.query('INSERT INTO account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ($1,$2,\'credential\',$2,$3,$4,$4)', [randomUUID(), user.id, user.password, user.createdAt]);
    }
    const result = { imported: pending.length, skipped: users.length - pending.length };
    await client.query('INSERT INTO audit_log(action,details) VALUES (\'migration.users\',$1)', [JSON.stringify({ count: result.imported, skipped: result.skipped, admins: pending.filter((user) => user.role === 'admin').length })]);
    return result;
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const source = args.find((arg) => !arg.startsWith('--'));
  if (!source) throw new Error('Usage: npm run users:import -- /private/users.json [--apply] [--skip-existing] [--expected-users=N] [--expected-admins=N]');
  const users = prepareUsers(JSON.parse(await readFile(source, 'utf8')));
  const expectedUsers = Number(args.find((arg) => arg.startsWith('--expected-users='))?.split('=')[1] ?? 95);
  const expectedAdmins = Number(args.find((arg) => arg.startsWith('--expected-admins='))?.split('=')[1] ?? 1);
  const admins = users.filter((user) => user.role === 'admin').length;
  if (users.length !== expectedUsers || admins !== expectedAdmins) throw new Error(`Count mismatch: ${users.length} users and ${admins} admins; expected ${expectedUsers} and ${expectedAdmins}`);
  console.log(JSON.stringify({ users: users.length, admins, enabled: users.filter((user) => user.enabled).length, dryRun: !args.includes('--apply') }));
  if (args.includes('--apply')) console.log(JSON.stringify(await importUsers(users, args.includes('--skip-existing'))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => db.end());
}
