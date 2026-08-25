import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * By default the data lives outside the project folder.
 *
 * The database used to sit in ./data — inside a directory that gets
 * replaced wholesale on update. When replacing a folder, Finder on macOS
 * doesn't merge contents, it deletes the old one with everything inside,
 * and the database vanished. The data directory must not depend on how
 * the code is updated.
 *
 * In Docker the DATA_DIR variable is set explicitly and points to a volume.
 */
const DEFAULT_DATA_DIR = join(homedir(), '.family-hub');

/** The old location — data is migrated out of it on first start. */
export const legacyDataDir = resolve('./data');

/**
 * Numbers and flags from the environment are validated on the spot: a typo
 * in a value must stop startup or be visible, not silently turn into NaN
 * ("listening on port NaN") or false ("the flag looks enabled, but isn't").
 */
function intFrom(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}=${raw} — expected a positive integer`);
  }
  return value;
}

function boolFrom(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name}=${raw} — expected true or false`);
}

export const env = {
  port: intFrom('PORT', 8787),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: resolve(process.env.DATA_DIR ?? DEFAULT_DATA_DIR),
  webDist: resolve(process.env.WEB_DIST ?? '../web/dist'),
  isProd: process.env.NODE_ENV === 'production',
  // Enable only after HTTPS is working (scripts/setup-https.sh).
  // Enabled too early, the browser rejects the cookie and login breaks.
  secureCookies: boolFrom('SECURE_COOKIES'),
  // Enabled when the app sits behind a reverse proxy (Caddy on the VPS):
  // the client address then comes from X-Forwarded-For, otherwise every
  // request looks like it came from the proxy — and per-IP limits ban
  // ourselves. Must stay off on an exposed install without a proxy:
  // the header can be forged.
  trustProxy: boolFrom('TRUST_PROXY'),
  // ── Sign-in with Google ─────────────────────────────────────────────────
  // Both values come from Google Cloud Console (OAuth client, Web application).
  // An empty clientId disables the feature entirely: no button on the login
  // screen, the routes reply that Google sign-in is not configured.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  // The address the hub is reachable at from a browser — the Google
  // redirect URI is built from it. For production: https://hub.example.com
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/$/, ''),
  // Public sandbox: a throwaway database per visitor.
  // See server/src/lib/sandbox.ts and lib/demo.ts
  demoMode: boolFrom('DEMO_MODE'),
  // Hosted mode: many families on one server, one database file each,
  // routed by the Host header. See server/src/lib/tenants.ts
  hostedMode: boolFrom('HOSTED_MODE'),
  // The apex all family subdomains hang off (e.g. neiliro.com):
  // a request to <slug>.<domain> is routed to that family's database.
  hostedDomain: (process.env.HOSTED_DOMAIN ?? '').trim().toLowerCase(),
  // ── Family mail on the service's own domain (#30, milestone C) ──────────
  // The domain family addresses hang off: <slug>@<domain>. The address is
  // derived from the slug, never stored — a rename must not leave a stale
  // copy behind. Empty disables both halves below.
  mailDomain: (process.env.MAIL_DOMAIN ?? '').trim().toLowerCase(),
  // Mailgun's HTTP webhook signing key (Settings -> API Security), which
  // is NOT the sending API key. Inbound accepts nothing unsigned, so an
  // empty key leaves the route refusing everything — the safe default for
  // an install that never configured mail.
  mailgunSigningKey: process.env.MAILGUN_SIGNING_KEY ?? '',
  // SMTP of that domain, used to send for a family that has no mailbox of
  // its own. A family that configured its own account keeps using it.
  mailSmtpHost: (process.env.MAIL_SMTP_HOST ?? '').trim(),
  mailSmtpPort: intFrom('MAIL_SMTP_PORT', 465),
  mailSmtpUser: process.env.MAIL_SMTP_USER ?? '',
  mailSmtpPass: process.env.MAIL_SMTP_PASS ?? '',
  // debug | info | warn | error | silent. Default warn:
  // in normal operation only warnings and errors are interesting.
  logLevel: process.env.LOG_LEVEL ?? 'warn',
} as const;

// A typo'd combination must stop startup, not surface as odd routing later.
if (env.hostedMode && env.demoMode) {
  throw new Error('HOSTED_MODE and DEMO_MODE are mutually exclusive — run the demo as its own process');
}
if (env.hostedMode && !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(env.hostedDomain)) {
  throw new Error('HOSTED_MODE=true requires HOSTED_DOMAIN (the apex domain, e.g. example.com)');
}

// A mail domain with no signing key would accept inbound from anyone, and
// a signing key with no domain has nothing to route: neither half works
// alone, and a half-configured install must say so at startup rather than
// drop letters at runtime.
if (env.mailDomain && !env.mailgunSigningKey) {
  throw new Error('MAIL_DOMAIN requires MAILGUN_SIGNING_KEY — inbound mail is never accepted unsigned');
}
if (env.mailgunSigningKey && !env.mailDomain) {
  throw new Error('MAILGUN_SIGNING_KEY requires MAIL_DOMAIN (the domain family addresses live on)');
}

export const paths = {
  db: resolve(env.dataDir, 'hub.db'),
  attachments: resolve(env.dataDir, 'attachments'),
  backups: resolve(env.dataDir, 'backups'),
} as const;
