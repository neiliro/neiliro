import { env } from './env.js';
import { buildApp } from './app.js';
import { migrate } from './db/migrate.js';
import { runAutoCreate } from './routes/budgets.js';
import { announceSetupIfEmpty, pruneSessions } from './lib/auth.js';
import { log, logLevel } from './lib/log.js';

/*
  Starting the server: everything that touches the world once, in order.
  The HTTP surface itself — hooks, plugins, routes — is built by buildApp
  in app.ts, which knows nothing about ports, migrations or signals so
  that tests can build the same app and drive it through inject().
*/

/*
  In hosted mode every per-database chore below — migrations, session
  pruning, recurring transactions, mail polling — runs once per family
  instead of once. eachFamily is that difference in one place: the
  single-family fallback just runs the job as before.
*/
const eachFamily: (fn: () => unknown) => Promise<void> = env.hostedMode
  ? (await import('./lib/tenants.js')).forEachFamily
  : async (fn) => {
      await fn();
    };

if (env.hostedMode) {
  // Opens the registry and migrates every family; migrate() below would
  // only touch the unused default database.
  const { initHosted } = await import('./lib/tenants.js');
  initHosted();
} else {
  migrate();
}

await eachFamily(pruneSessions);
// Boot-only pruning was enough while every deploy restarted the process,
// but a home server can stay up for months — repeat daily so expiry and
// the 30-day idle rule actually retire rows from the Devices list.
// Nothing leaks either way (userForToken enforces expiry); this is about
// the table and the list not growing stale. Same pattern as the attempt
// and MFA sweeps in routes/auth.ts.
setInterval(() => void eachFamily(pruneSessions), 24 * 60 * 60_000).unref();

// Production without Secure cookies is almost certainly a forgotten flag,
// not intent: the session cookie would then travel over plaintext too
if (env.isProd && !env.secureCookies && !env.demoMode) {
  log.warn('NODE_ENV=production without SECURE_COOKIES=true — enable it once HTTPS is set up');
}
if (env.demoMode) {
  const { initDemo } = await import('./lib/sandbox.js');
  await initDemo();
} else if (!env.hostedMode) {
  // Hosted families onboard through the same first-run screen, but on
  // their own subdomain — announcing a setup link for the unused default
  // database would only mislead.
  announceSetupIfEmpty();
}

const app = await buildApp();

// Recurring payments marked "create automatically" catch up at startup:
// the Mac may have been asleep, and a couple of dates may have passed us by
await eachFamily(() => {
  const created = runAutoCreate();
  if (created > 0) log.info(`recurring transactions: created ${created}`);
});
// ...and once a day from then on. Catch-up used to be boot-only, which a
// server that never restarts (hosted, a long-lived home box) never hits:
// auto-created payments silently stopped between deploys. runAutoCreate
// is idempotent — a repeat run creates nothing extra.
setInterval(
  () => void eachFamily(runAutoCreate),
  24 * 60 * 60_000,
).unref();

try {
  await app.listen({ port: env.port, host: env.host });
  log.notice(`Hub listening on http://${env.host}:${env.port} · log level: ${logLevel}`);
} catch (err) {
  log.error('Failed to bind the port', err);
  process.exit(1);
}

// Family mail: background IMAP polling. Not in demo — sandboxes have no
// mailbox, and the sample messages are seeded, not fetched.
if (!env.demoMode) {
  const { startMailPoller } = await import('./lib/mail.js');
  startMailPoller(eachFamily);
}

// An unhandled crash must be visible at any log level
process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason));
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    // Close the stats rows of live sandboxes with reason "shutdown":
    // without it every deploy manufactures sessions that never ended
    if (env.demoMode) {
      const { shutdownDemo } = await import('./lib/sandbox.js');
      shutdownDemo();
    }
    // Same courtesy for hosted: closing checkpoints each family's WAL,
    // so every hub.db stays a single copy-friendly file on disk
    if (env.hostedMode) {
      const { shutdownHosted } = await import('./lib/tenants.js');
      shutdownHosted();
    }
    // An explicit close runs a WAL checkpoint: the database stays a single
    // file, no -wal/-shm next to it — safer to copy and move around
    try {
      const { currentDb } = await import('./db/index.js');
      currentDb().close();
    } catch {
      // The database is already closed or never opened — not an error on exit
    }
    process.exit(0);
  });
}
