import nodemailer from 'nodemailer';

async function sendEmail(email: string, subject: string, text: string): Promise<void> {
  if (process.env.MAILGUN_API_KEY) {
    const domain = process.env.MAILGUN_DOMAIN;
    const from = process.env.MAILGUN_FROM;
    if (!domain || !from) throw new Error('MAILGUN_DOMAIN and MAILGUN_FROM are required');
    const apiUrl = (process.env.MAILGUN_API_URL || 'https://api.mailgun.net').replace(/\/$/, '');
    if (!['https://api.mailgun.net', 'https://api.eu.mailgun.net'].includes(apiUrl)) throw new Error('MAILGUN_API_URL must be an official Mailgun HTTPS endpoint');
    const body = new FormData();
    for (const [name, value] of Object.entries({ from, to: email, subject, text })) body.set(name, value);
    const response = await fetch(`${apiUrl}/v3/${encodeURIComponent(domain)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString('base64')}` },
      body,
      signal: AbortSignal.timeout(15_000),
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`Mailgun email delivery failed (${response.status})`);
    return;
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) throw new Error('SMTP is not configured');
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_SECURE !== 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject,
    text
  });
}

export async function sendResetEmail(email: string, url: string): Promise<void> {
  await sendEmail(email, 'Torrents Duck — Réinitialisation du mot de passe', `Pour définir un nouveau mot de passe, ouvre ce lien :\n${url}\n\nSi tu n'as rien demandé, ignore ce message.`);
}

export async function sendVerificationEmail(email: string, url: string): Promise<void> {
  await sendEmail(email, 'Torrents Duck — Confirme ton adresse e-mail', `Pour confirmer ton adresse e-mail, ouvre ce lien :\n${url}\n\nSi tu n'as pas créé de compte, ignore ce message.`);
}

export async function sendRegistrationEmail(email: string, username: string, registeredEmail: string, url: string): Promise<void> {
  await sendEmail(email, 'Torrents Duck — Nouveau compte à valider', `Un nouveau compte vient de s'inscrire sur Torrents Duck.\n\nPseudo : ${username}\nAdresse e-mail : ${registeredEmail}\n\nPour vérifier et valider ce compte, ouvre l'administration :\n${url}`);
}
