import 'server-only';

import nodemailer, { type Transporter } from 'nodemailer';

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Stable across webhook retries so mail providers can de-duplicate it. */
  messageId?: string;
  /** Include the agency copy for booking and deposit confirmation emails. */
  agencyConfirmationCopy?: boolean;
  /** Inline CID assets and customer documents such as confirmed ticket PDFs. */
  attachments?: Array<{
    filename: string;
    path?: string;
    cid?: string;
    content?: Buffer;
    contentType?: string;
    contentDisposition?: 'inline' | 'attachment';
  }>;
};

type EmailConfig = {
  from: { name: string; address: string };
  replyTo?: string;
  archiveBcc?: string;
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  user: string;
  password: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Email boolean environment variables must be true or false.');
}

function emailConfig(): EmailConfig {
  const host = process.env.SMTP_HOST?.trim();
  const rawPort = process.env.SMTP_PORT?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  const fromAddress = process.env.EMAIL_FROM_ADDRESS?.trim();
  const fromName =
    process.env.EMAIL_FROM_NAME?.trim() || 'Kaliganj Travels';
  const replyTo = process.env.EMAIL_REPLY_TO?.trim();
  const archiveBcc = process.env.SYSTEM_EMAIL_BCC?.trim();

  if (!host || !rawPort || !user || !password || !fromAddress) {
    throw new Error(
      'Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM_ADDRESS.'
    );
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535.');
  }
  if (!EMAIL_PATTERN.test(user) || !EMAIL_PATTERN.test(fromAddress)) {
    throw new Error('SMTP_USER and EMAIL_FROM_ADDRESS must be valid addresses.');
  }
  if (replyTo && !EMAIL_PATTERN.test(replyTo)) {
    throw new Error('EMAIL_REPLY_TO must be a valid address.');
  }
  if (archiveBcc && !EMAIL_PATTERN.test(archiveBcc)) {
    throw new Error('SYSTEM_EMAIL_BCC must be a single valid address.');
  }

  return {
    from: { name: fromName, address: fromAddress },
    replyTo: replyTo || undefined,
    archiveBcc: archiveBcc || undefined,
    host,
    port,
    secure: booleanValue(process.env.SMTP_SECURE, port === 465),
    requireTLS: booleanValue(process.env.SMTP_REQUIRE_TLS, port === 587),
    user,
    password,
  };
}

let transporter: Transporter | null = null;

const DELIVERY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;

function isRetryableEmailError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  const code = String(candidate.code ?? '');
  const message = String(candidate.message ?? '').toLowerCase();
  return (
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ESOCKET'].includes(code) ||
    message.includes('timeout') ||
    message.includes('greeting never received') ||
    message.includes('connection closed')
  );
}

function resetTransport() {
  transporter?.close();
  transporter = null;
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function emailTransport(): { config: EmailConfig; transport: Transporter } {
  const config = emailConfig();
  transporter ??= nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  });
  return { config, transport: transporter };
}

/** Sends one transactional email through the configured server-only SMTP transport. */
export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!EMAIL_PATTERN.test(message.to)) {
    throw new Error('Refusing to send email to an invalid address.');
  }
  if (!message.subject.trim() || /[\r\n]/.test(message.subject)) {
    throw new Error('Refusing to send email with an invalid subject.');
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt += 1) {
    try {
      const { config, transport } = emailTransport();
      const copyRecipients = [
        config.archiveBcc,
        message.agencyConfirmationCopy ? 'kaliganjtravels@gmail.com' : undefined,
      ].filter((address): address is string => Boolean(address));
      const uniqueCopies = Array.from(new Map(copyRecipients.map((address) =>
        [address.toLowerCase(), address]
      )).values()).filter((address) => address.toLowerCase() !== message.to.trim().toLowerCase());
      await transport.sendMail({
        from: config.from,
        replyTo: config.replyTo,
        to: message.to,
        // BCC is part of the SMTP envelope only; customers cannot see this address.
        bcc: uniqueCopies.length ? uniqueCopies.join(', ') : undefined,
        subject: message.subject,
        html: message.html,
        text: message.text,
        messageId: message.messageId,
        attachments: message.attachments,
      });
      return;
    } catch (error) {
      lastError = error;
      resetTransport();
      if (!isRetryableEmailError(error) || attempt === DELIVERY_ATTEMPTS - 1) {
        throw error;
      }
      console.warn(
        `[email] transient delivery failure; retrying attempt ${attempt + 2}/${DELIVERY_ATTEMPTS}`
      );
      await waitForRetry(RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1) ?? 1_000);
    }
  }

  throw lastError;
}

/** Opens an authenticated SMTP connection without sending a message. */
export async function verifyEmailTransport(): Promise<void> {
  await emailTransport().transport.verify();
}
