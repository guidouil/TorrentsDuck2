import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ db: { end: vi.fn() }, transaction: database.transaction }));

import { importUsers, usersToImport, type ExistingUser, type ImportedUser } from '../scripts/migrate-users';

function user(overrides: Partial<ImportedUser> = {}): ImportedUser {
  return {
    id: 'legacy-member', username: 'duck-member', email: 'member@example.org',
    emailVerified: false, role: 'member', enabled: true, approved: true,
    createdAt: new Date('2018-01-02T03:04:05Z'), password: 'prepared-legacy-fixture-hash', ...overrides
  };
}

function current(overrides: Partial<ExistingUser> = {}): ExistingUser {
  return { id: 'current-member', username: 'duck-member', email: 'MEMBER@EXAMPLE.ORG', legacyId: null, ...overrides };
}

describe('existing user import plan', () => {
  it('imports new identities and skips only the matching username and case-insensitive email', () => {
    const added = user({ id: 'legacy-other', username: 'other-duck', email: 'other@example.org' });
    expect(usersToImport([user(), added], [current()])).toEqual([added]);
    expect(usersToImport([added], [])[0]).toBe(added);
  });

  it('can be replayed after an import, including an identity with an existing legacy link', () => {
    expect(usersToImport([user()], [current({ id: 'legacy-member', legacyId: 'legacy-member' })])).toEqual([]);
    expect(usersToImport([user()], [current({ legacyId: 'legacy-member' })])).toEqual([]);
  });

  it('leaves source data and every field of a recreated identity untouched', () => {
    const incoming = [user()];
    const live = [{ ...current(), role: 'admin', enabled: false, emailVerified: true, password: 'live-fixture-hash', sessions: ['live-session-fixture'] }];
    const snapshot = structuredClone({ incoming, live });
    expect(usersToImport(incoming, live)).toEqual([]);
    expect({ incoming, live }).toEqual(snapshot);
  });

  it.each([
    ['username only', current({ email: 'different@example.org' })],
    ['email only', current({ username: 'different-duck' })],
    ['username differs in case', current({ username: 'DUCK-MEMBER' })],
    ['unrelated id collision', current({ id: 'legacy-member', username: 'other-duck', email: 'other@example.org' })],
    ['unrelated legacy id collision', current({ username: 'other-duck', email: 'other@example.org', legacyId: 'legacy-member' })],
    ['different legacy link on matching identity', current({ legacyId: 'different-legacy' })]
  ])('rejects %s', (_name, existing) => {
    expect(() => usersToImport([user()], [existing])).toThrow('Existing identity conflict');
  });

  it.each(['id', 'legacyId'] as const)('rejects a matching identity when another account owns its historical %s', (field) => {
    const collision = current({ id: 'other-current', username: 'other-duck', email: 'other@example.org', [field]: 'legacy-member' });
    expect(() => usersToImport([user()], [current(), collision])).toThrow('Existing identity conflict');
  });

  it('rejects incoming username matching an existing email without regard to case', () => {
    const incoming = user({ username: 'SHARED@EXAMPLE.ORG' });
    expect(() => usersToImport([incoming], [current({ username: 'other-duck', email: 'shared@example.org' })])).toThrow('Existing identity conflict');
  });

  it('rejects incoming email matching an existing username without regard to case', () => {
    const incoming = user({ email: 'shared@example.org' });
    expect(() => usersToImport([incoming], [current({ username: 'SHARED@EXAMPLE.ORG', email: 'other@example.org' })])).toThrow('Existing identity conflict');
  });

  it('allows the same identity to use its own email as its username', () => {
    expect(usersToImport([user({ username: 'member@example.org' })], [current({ username: 'member@example.org' })])).toEqual([]);
  });
});

describe('transactional user import', () => {
  let existing: ExistingUser[];

  beforeEach(() => {
    vi.clearAllMocks();
    existing = [];
    database.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT id,username,email,') ? existing : [] }));
    database.transaction.mockImplementation(async (run: (client: { query: typeof database.query }) => unknown) => run({ query: database.query }));
  });

  it('requires an empty database unless skipping existing identities is explicit', async () => {
    existing = [current()];
    await expect(importUsers([user()])).rejects.toThrow('empty user database');
    expect(database.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
  });

  it('takes the registration advisory lock before the table lock and conflict snapshot', async () => {
    await importUsers([user()]);
    const calls = database.query.mock.calls.map(([sql]) => sql);
    expect(calls.slice(0, 3)).toEqual([
      'SELECT pg_advisory_xact_lock(782412)',
      'LOCK TABLE "user" IN EXCLUSIVE MODE',
      'SELECT id,username,email,"legacyId" FROM "user"'
    ]);
  });

  it('rejects the complete plan before inserting when a later record conflicts', async () => {
    existing = [current({ email: 'different@example.org' })];
    const added = user({ id: 'legacy-other', username: 'other-duck', email: 'other@example.org' });
    await expect(importUsers([added, user()], true)).rejects.toThrow('Existing identity conflict');
    expect(database.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
  });

  it('inserts only new users and credentials, preserving all existing rows', async () => {
    existing = [current()];
    const before = structuredClone(existing);
    const added = user({ id: 'legacy-other', username: 'other-duck', email: 'other@example.org' });
    await expect(importUsers([user(), added], true)).resolves.toEqual({ imported: 1, skipped: 1 });
    const userInserts = database.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO "user"'));
    const accountInserts = database.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO account'));
    expect(userInserts).toHaveLength(1);
    expect(userInserts[0][1][0]).toBe(added.id);
    expect(accountInserts).toHaveLength(1);
    expect(accountInserts[0][1].slice(1, 3)).toEqual([added.id, added.password]);
    expect(database.query.mock.calls.some(([sql]) => /^\s*(UPDATE|DELETE)\b/i.test(sql))).toBe(false);
    expect(database.query.mock.calls.some(([sql]) => /\bsession\b/i.test(sql))).toBe(false);
    expect(existing).toEqual(before);
    const audit = database.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO audit_log'));
    expect(JSON.parse(audit![1][0])).toEqual({ count: 1, skipped: 1, admins: 0 });
  });

  it('replays without inserting users or credential accounts', async () => {
    existing = [current({ id: 'legacy-member', legacyId: 'legacy-member' })];
    await expect(importUsers([user()], true)).resolves.toEqual({ imported: 0, skipped: 1 });
    expect(database.query.mock.calls.some(([sql]) => /^INSERT INTO ("user"|account)/.test(sql))).toBe(false);
  });
});
