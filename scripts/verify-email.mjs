import nextEnv from '@next/env';
import nodemailer from 'nodemailer';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const required = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'EMAIL_FROM_ADDRESS',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing email environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const port = Number(process.env.SMTP_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('SMTP_PORT must be an integer between 1 and 65535.');
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: process.env.SMTP_SECURE === 'true',
  requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
  tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
});

try {
  await transport.verify();
  console.log('SMTP connection and authentication succeeded.');
} catch (error) {
  console.error(
    'SMTP verification failed:',
    error?.code || error?.name || 'unknown',
    error?.response || error?.message || 'Unknown error'
  );
  process.exitCode = 1;
} finally {
  transport.close();
}
