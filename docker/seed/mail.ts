import nodemailer from 'nodemailer';
import type { Env } from './env';
import { jsonRequest, request, waitFor } from './http';
import type { MailMessageSeed } from './scenario';

/** Clears Mailpit and delivers the scenario emails through its SMTP endpoint. */
export async function seedMail(env: Env, emails: MailMessageSeed[]): Promise<void> {
  await waitFor('Mailpit', async () => {
    const response = await request(`${env.MAILPIT_URL}/api/v1/info`, {}, 'Mailpit info');
    if (!response.ok) throw new Error(`info endpoint returned HTTP ${response.status}`);
  });

  const port = Number(env.MAILPIT_SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MAILPIT_SMTP_PORT "${env.MAILPIT_SMTP_PORT}"`);
  }

  const transport = nodemailer.createTransport({
    host: env.MAILPIT_SMTP_HOST,
    port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 10_000,
  });

  await waitFor('Mailpit SMTP', async () => {
    await transport.verify();
  });

  const cleared = await request(`${env.MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' }, 'Mailpit clear inbox');
  if (!cleared.ok) throw new Error(`Mailpit could not clear the inbox (HTTP ${cleared.status})`);

  for (const email of emails) {
    await transport.sendMail({
      from: email.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      date: new Date(email.date),
      messageId: email.messageId,
    });
    console.log(`  sent: ${email.subject}`);
  }

  await jsonRequest<{ total: number }>(`${env.MAILPIT_URL}/api/v1/messages`, {}, 'Mailpit messages');
  transport.close();
}
