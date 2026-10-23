import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendRegistrationEmail, sendResetEmail, sendVerificationEmail } from '../src/lib/server/mail';
import nodemailer from 'nodemailer';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
const fetchMock = vi.fn();
const sendMail = vi.fn().mockResolvedValue({});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  for (const name of ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN', 'MAILGUN_FROM', 'MAILGUN_API_URL', 'SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_PORT', 'SMTP_SECURE']) vi.stubEnv(name, '');
  vi.stubEnv('MAILGUN_API_KEY', 'mailgun-test-key');
  vi.stubEnv('MAILGUN_DOMAIN', 'mg.example.org');
  vi.stubEnv('MAILGUN_FROM', 'Torrents Duck <noreply@mg.example.org>');
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.mocked(nodemailer.createTransport).mockReset().mockReturnValue({ sendMail } as never);
  sendMail.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('transactional email', () => {
  it('sends password resets through the Mailgun API without exposing credentials in the URL', async () => {
    const url = 'https://duck.example.org/reset-password?token=reset-secret';
    await sendResetEmail('duck@example.org', url);
    const [endpoint, options] = fetchMock.mock.calls[0];
    expect(endpoint).toBe('https://api.mailgun.net/v3/mg.example.org/messages');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Basic ${Buffer.from('api:mailgun-test-key').toString('base64')}` } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(options.body.entries())).toEqual({
      from: 'Torrents Duck <noreply@mg.example.org>', to: 'duck@example.org',
      subject: 'Torrents Duck — Réinitialisation du mot de passe',
      text: expect.stringContaining(url)
    });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('sends verification links using the EU endpoint', async () => {
    vi.stubEnv('MAILGUN_API_URL', 'https://api.eu.mailgun.net/');
    await sendVerificationEmail('duck@example.org', 'https://duck.example.org/api/auth/verify-email?token=verify-secret');
    const [endpoint, { body }] = fetchMock.mock.calls[0];
    expect(endpoint).toBe('https://api.eu.mailgun.net/v3/mg.example.org/messages');
    expect(body.get('subject')).toBe('Torrents Duck — Confirme ton adresse e-mail');
    expect(body.get('text')).toContain('token=verify-secret');
  });

  it('sends administrators the submitted account details as plain text with an approval link', async () => {
    await sendRegistrationEmail('admin@example.org', '<b>Éric & duck</b>', 'eric@example.org', 'https://duck.example.org/admin');
    const [, { body }] = fetchMock.mock.calls[0];
    expect(body.get('to')).toBe('admin@example.org');
    expect(body.get('subject')).toBe('Torrents Duck — Nouveau compte à valider');
    expect(body.get('text')).toContain('Pseudo : <b>Éric & duck</b>\nAdresse e-mail : eric@example.org');
    expect(body.get('text')).toContain('https://duck.example.org/admin');
    expect(body.has('html')).toBe(false);
  });

  it.each(['MAILGUN_DOMAIN', 'MAILGUN_FROM'])('rejects missing %s before sending anything', async (name) => {
    vi.stubEnv(name, '');
    await expect(sendResetEmail('duck@example.org', 'https://duck.example.org/reset')).rejects.toThrow('required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects endpoints that could disclose the API key', async () => {
    vi.stubEnv('MAILGUN_API_URL', 'https://untrusted.example.org');
    await expect(sendResetEmail('duck@example.org', 'https://duck.example.org/reset')).rejects.toThrow('official Mailgun HTTPS endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates Mailgun errors without including response content or using SMTP', async () => {
    fetchMock.mockResolvedValueOnce(new Response('private upstream details', { status: 401 }));
    await expect(sendResetEmail('duck@example.org', 'https://duck.example.org/reset')).rejects.toThrow('Mailgun email delivery failed (401)');
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('propagates network failures', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network unavailable'));
    await expect(sendResetEmail('duck@example.org', 'https://duck.example.org/reset')).rejects.toThrow('Network unavailable');
  });

  it('keeps SMTP delivery when no Mailgun key is configured', async () => {
    vi.stubEnv('MAILGUN_API_KEY', '');
    vi.stubEnv('SMTP_HOST', 'smtp.example.org');
    vi.stubEnv('SMTP_FROM', 'Torrents Duck <noreply@example.org>');
    vi.stubEnv('SMTP_PORT', '587');
    await sendResetEmail('duck@example.org', 'https://duck.example.org/reset');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.org', port: 587, secure: false, requireTLS: true }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'Torrents Duck <noreply@example.org>', to: 'duck@example.org' }));
  });
});
