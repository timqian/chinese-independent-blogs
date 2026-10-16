// Login codes by SMTP, replacing the Cloudflare email binding. When SMTP is
// not configured (or EMAIL_DEV_LOG=1) codes are only printed to the log.
import nodemailer from 'nodemailer';

let transport = null;
let transportKey = '';

export const mailConfigured = (env) => Boolean(env.SMTP_HOST);

function getTransport(env) {
  const key = [env.SMTP_HOST, env.SMTP_PORT, env.SMTP_USER, env.SMTP_SECURE, env.SMTP_TLS_INSECURE].join('|');
  if (!transport || transportKey !== key) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      // Implicit TLS (465); other ports use STARTTLS when the server offers it
      secure: env.SMTP_SECURE === '1' || Number(env.SMTP_PORT) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      ...(env.SMTP_TLS_INSECURE === '1' && { tls: { rejectUnauthorized: false } }),
    });
    transportKey = key;
  }
  return transport;
}

export async function sendMail(env, { to, subject, text, html }) {
  await getTransport(env).sendMail({
    from: env.EMAIL_FROM || env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}
