import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { checkPassword, hashPassword, legacyPasswordHash } from '../src/lib/server/passwords';
import { prepareUsers } from '../scripts/migrate-users';

const password = 'Un mot de passe de test + 🦆';
const meteorHash = bcrypt.hashSync(createHash('sha256').update(password).digest('hex'), 4);
const meteorUser = { _id: 'legacy-1', username: 'Éric+canard', emails: [{ address: 'eric+duck@example.org', verified: false }], createdAt: { $date: '2017-02-03T10:20:30.000Z' }, isAdmin: false, isValid: true, services: { password: { bcrypt: meteorHash }, resume: { loginTokens: [{ token: 'never-import' }] } } };

describe('Meteor account migration', () => {
  it('verifies Meteor SHA256 then bcrypt and rejects raw bcrypt and wrong passwords', async () => {
    const stored = legacyPasswordHash(meteorHash);
    expect(await checkPassword(password, stored)).toBe(true);
    expect(await checkPassword('wrong', stored)).toBe(false);
    expect(await checkPassword(password, legacyPasswordHash(bcrypt.hashSync(password, 4)))).toBe(false);
  });

  it('uses Better Auth scrypt for new credentials', async () => {
    const stored = await hashPassword(password);
    expect(stored.startsWith('meteor$')).toBe(false);
    expect(await checkPassword(password, stored)).toBe(true);
    expect(await checkPassword('wrong', stored)).toBe(false);
    expect(await checkPassword(password, 'corrupt')).toBe(false);
  });

  it('preserves id, Unicode username, plus email, dates and unverified status without old tokens', () => {
    const [user] = prepareUsers({ users: [meteorUser] });
    expect(user).toMatchObject({ id: 'legacy-1', username: 'Éric+canard', email: 'eric+duck@example.org', enabled: true, approved: true, emailVerified: false, role: 'member' });
    expect(user.createdAt.toISOString()).toBe('2017-02-03T10:20:30.000Z');
    expect(user).not.toHaveProperty('services');
    expect(user).not.toHaveProperty('resume');
  });

  it('preserves effective legacy access isAdmin OR isValid', () => {
    expect(prepareUsers([{ ...meteorUser, isValid: false }])[0].enabled).toBe(false);
    expect(prepareUsers([{ ...meteorUser, isValid: false, isAdmin: true }])[0]).toMatchObject({ enabled: true, role: 'admin' });
    expect(() => prepareUsers([{ ...meteorUser, isValid: undefined }])).toThrow('Missing access flags');
  });

  it('fails closed for duplicate identities, ambiguous sign-in or incomplete accounts', () => {
    expect(() => prepareUsers([meteorUser, meteorUser])).toThrow('Duplicate');
    expect(() => prepareUsers([{ ...meteorUser, services: undefined }])).toThrow('Missing password');
    expect(() => prepareUsers([{ ...meteorUser, emails: [] }])).toThrow('Expected one email');
    const second = { ...meteorUser, _id: 'legacy-2', username: 'other', emails: [{ address: 'other@example.org' }] };
    expect(() => prepareUsers([{ ...meteorUser, username: 'other@example.org' }, second])).toThrow('ambiguous');
  });
});
