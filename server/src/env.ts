import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isRealDate } from './lib/date-field.js';

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
  // Which node of the hosted service this process is (ADR 0002). The
  // registry never consults it for placement — a family that is here has
  // node IS NULL in its row, on every node — so the name exists for what
  // leaves the machine: the startup log, the route map control exports,
  // the per-node registry archive. One node today, hence the default.
  nodeName: (process.env.NODE_NAME ?? 'hosted01').trim().toLowerCase(),
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
  // Sending for a family that has no mailbox of its own goes over
  // Mailgun's HTTP API, not SMTP — deliberately. Cloud providers block
  // outbound SMTP (DigitalOcean closes 25/465/587 by default), so a mail
  // path that depends on those ports is a path that breaks on the next
  // machine. Port 443 is never blocked. A family that configured its own
  // account keeps sending through that account's SMTP.
  mailgunApiKey: process.env.MAILGUN_API_KEY ?? '',
  // Regional endpoint: the EU and US clouds are separate, and a domain
  // belongs to exactly one of them.
  mailgunApiBase: (process.env.MAILGUN_API_BASE ?? 'https://api.eu.mailgun.net').replace(/\/$/, ''),
  // ── Self-serve sign-up (#262, hosted only) ──────────────────────────────
  // The bearer the landing page's function presents on signup.<apex>.
  // Empty means the route is not registered at all.
  signupToken: (process.env.SIGNUP_TOKEN ?? '').trim(),
  // Process-wide ceiling on sign-ups per hour: each one is a letter
  // through the mail provider, and a flood is a deliverability problem
  // before it is a disk problem.
  signupHourlyCap: Math.max(1, Number(process.env.SIGNUP_HOURLY_CAP ?? 60) || 60),
  // ── Billing through Paddle (#265, hosted only) ──────────────────────────
  // Paddle is the merchant of record: it sells the subscription, holds the
  // card, issues the receipt and tells us what happened through webhooks
  // on billing.<apex>. The secret signs those; empty = the route is not
  // registered, and every family stays on the trial clock.
  paddleWebhookSecret: (process.env.PADDLE_WEBHOOK_SECRET ?? '').trim(),
  // Server-side API key, used for one thing: minting the customer-portal
  // link a family manages its subscription with. Empty = no portal link.
  paddleApiKey: (process.env.PADDLE_API_KEY ?? '').trim(),
  // sandbox | live — sandbox and live are separate Paddle accounts with
  // separate keys, prices and API hosts.
  paddleEnv: (process.env.PADDLE_ENV ?? 'sandbox').trim().toLowerCase() === 'live' ? 'live' : 'sandbox',
  // ── A pending change to the terms or the privacy policy (#229, hosted only) ──
  // Both documents promise notice before a material change takes effect.
  // The e-mail half is the operator's script (neiliro/cloud); this is the
  // in-app half: while both values are set, every administrator sees a
  // dismissable line naming the date and linking to what changes. Set from
  // the control plane so a notice never waits for an app release; unset
  // both once the date has passed.
  policyNoticeUrl: (process.env.POLICY_NOTICE_URL ?? '').trim(),
  policyNoticeEffective: (process.env.POLICY_NOTICE_EFFECTIVE ?? '').trim(),
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
// The node name ends up in a file name (the registry archive) and in a
// Caddyfile (the route map): a hostname's alphabet keeps it safe in both.
if (env.hostedMode && !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(env.nodeName)) {
  throw new Error('NODE_NAME must be 1–32 chars of [a-z0-9-], letters or digits at the edges (e.g. hosted02)');
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

// The notice is one thing or nothing: a date with no link sends people
// looking for a change they cannot read, a link with no date says nothing
// about when. Self-hosted hubs have no terms to change, so there it is a
// misconfiguration rather than a feature.
if ((env.policyNoticeUrl === '') !== (env.policyNoticeEffective === '')) {
  throw new Error('POLICY_NOTICE_URL and POLICY_NOTICE_EFFECTIVE are set together or not at all');
}
if (env.policyNoticeUrl && !env.hostedMode) {
  throw new Error('POLICY_NOTICE_* is for the hosted service — a self-hosted hub has no terms to announce');
}
if (env.policyNoticeUrl && !/^https:\/\/[^\s]+$/.test(env.policyNoticeUrl)) {
  throw new Error('POLICY_NOTICE_URL must be an https:// address');
}
if (env.policyNoticeEffective && !isRealDate(env.policyNoticeEffective)) {
  throw new Error('POLICY_NOTICE_EFFECTIVE must be a real date, YYYY-MM-DD');
}

export const paths = {
  db: resolve(env.dataDir, 'hub.db'),
  attachments: resolve(env.dataDir, 'attachments'),
  backups: resolve(env.dataDir, 'backups'),
} as const;
