// The app's configuration, read from environment variables (which replaces
// wrangler.jsonc vars and `wrangler secret put`). A frontend/.env file is
// loaded first; real environment variables take precedence over it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;

const DEFAULT_BLOGS_CSV_URL =
  'https://raw.githubusercontent.com/timqian/chinese-independent-blogs/master/blogs-original.csv';

export function loadEnvFile(file = join(HERE, '../.env')) {
  if (existsSync(file)) process.loadEnvFile(file);
}

export function config() {
  const pick = (name, fallback = '') => process.env[name] ?? fallback;
  return {
    SITE_URL: pick('SITE_URL').replace(/\/+$/, ''),
    ADMIN_TOKEN: pick('ADMIN_TOKEN'),
    CACHE_TTL: pick('CACHE_TTL', '300'),
    // Empty disables the GitHub fetch; the bundled CSV in the repo root is used
    BLOGS_CSV_URL: pick('BLOGS_CSV_URL', DEFAULT_BLOGS_CSV_URL),
    BLOGS_CSV_PATH: pick('BLOGS_CSV_PATH', join(HERE, '../../blogs-original.csv')),
    EMAIL_DEV_LOG: pick('EMAIL_DEV_LOG'),
    EMAIL_FROM: pick('EMAIL_FROM', 'Indi <noreply@localhost>'),
    SMTP_HOST: pick('SMTP_HOST'),
    SMTP_PORT: pick('SMTP_PORT', '587'),
    SMTP_USER: pick('SMTP_USER'),
    SMTP_PASS: pick('SMTP_PASS'),
    SMTP_SECURE: pick('SMTP_SECURE'),
    SMTP_TLS_INSECURE: pick('SMTP_TLS_INSECURE'),
    GITHUB_CLIENT_ID: pick('GITHUB_CLIENT_ID'),
    GITHUB_CLIENT_SECRET: pick('GITHUB_CLIENT_SECRET'),
    TELEGRAM_BOT_TOKEN: pick('TELEGRAM_BOT_TOKEN'),
    TELEGRAM_CHAT_ID: pick('TELEGRAM_CHAT_ID'),
    // Set when a trusted reverse proxy (nginx, Caddy) forwards X-Forwarded-For
    TRUST_PROXY: pick('TRUST_PROXY'),
    // CRAWL=0 disables the in-process hourly crawler
    CRAWL: pick('CRAWL', '1'),
    DB_PATH: pick('DB_PATH', join(HERE, '../data/indi.db')),
    PORT: pick('PORT', '8787'),
    HOST: pick('HOST', '0.0.0.0'),
  };
}
