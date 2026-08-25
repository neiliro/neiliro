import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';

/*
  Any validation failure without an authored message falls back to zod's
  own vocabulary — "Required", "Invalid", "Invalid email" — which the
  client cannot translate: it translates server strings by exact match
  against a dictionary of authored sentences. The app's forms rarely hit
  these (fields initialise to '' and always send the key), but the API
  surface does, and so will the first form that omits a key. One error
  map catches all ~100 unauthored field definitions at once; messages
  written at the schema (.min(1, '…')) still win over it. (#86)
*/
z.setErrorMap(() => ({ message: 'Check the fields' }));
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { existsSync } from 'node:fs';
import { env } from './env.js';
import { registerRoutes } from './routes/index.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGoogleRoutes } from './routes/google.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerUserRoutes } from './routes/users.js';
import { registerProfileRoutes, registerPublicWishlistRoutes } from './routes/profiles.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerNoteRoutes } from './routes/notes.js';
import { MAX_FILE_BYTES, registerAttachmentRoutes } from './routes/attachments.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { registerMailRoutes } from './routes/mail.js';
import { registerInboundMailRoutes } from './routes/mail-inbound.js';
import { registerPasswordResetRoutes } from './routes/password-reset.js';
import { registerMoneyRoutes } from './routes/money.js';
import { registerBudgetRoutes } from './routes/budgets.js';
import { registerFamilyRoutes } from './routes/family.js';
import { authenticate } from './lib/auth.js';
import { log } from './lib/log.js';

/*
  Everything that shapes the HTTP surface — hooks, plugins, routes — and
  nothing that touches the world. No migrations, no listening port, no
  background pollers, no process handlers: those belong to starting the
  server, which is index.ts.

  Split out so the routes can be exercised through app.inject() without a
  socket. Before this, importing the app started it, and the guards that
  carry this project's privacy promise had no way to be tested at all.
*/
/*
  Query parameter values never reach the log: that is where secrets live —
  the invite token (?token=), the OAuth callback code and state.
  A failed invite check is a 404 at warn level, and without masking
  the secret ended up in the log by default. Parameter names are kept:
  for diagnostics "which parameter came in" matters, not "with which value".
*/
export function redactUrl(url: string): string {
  // The wishlist share token travels in the PATH, not the query — a
  // rate-limited or mistyped request would otherwise write a live guest
  // link into the log at warn level (invites dodge this only because
  // their token is a query value).
  const masked = url.replace(/^(\/api\/wishlist\/)[^/?]+/, '$1…');
  const q = masked.indexOf('?');
  if (q === -1) return masked;
  const params = new URLSearchParams(masked.slice(q + 1));
  const names = [...new Set([...params.keys()])];
  return names.length
    ? `${masked.slice(0, q)}?${names.map((n) => `${n}=…`).join('&')}`
    : masked.slice(0, q);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // The built-in logger is off entirely: it writes a JSON line per request,
    // and on a home server that is noise drowning out real errors.
    // With logger: false there is no need to disable request logging separately.
    logger: false,
    trustProxy: env.trustProxy,
  });

  /*
    We log ourselves and only what deserves attention:
    server errors at error level, client rejections at warn,
    everything else at debug, hidden by default.
  */
  app.addHook('onResponse', (req, reply, done) => {
    // The error handler already wrote a detailed line — don't repeat it
    if (req.errorLogged) return done();

    const status = reply.statusCode;
    const line = `${status} ${req.method} ${redactUrl(req.url)}`;
    if (status >= 500) log.error(line);
    else if (status >= 400) log.warn(line);
    else log.debug(line, `${Math.round(reply.elapsedTime)}ms`);
    done();
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.errorLogged = true;

    // Bad parameters in the path or query string are a client error.
    // This used to blow up as a 500 and land in the log as a server error.
    if (err instanceof ZodError) {
      log.warn(`400 ${req.method} ${redactUrl(req.url)}`, err.issues[0]?.message ?? '');
      return reply.code(400).send({ error: 'Invalid request parameters' });
    }

    const status = err.statusCode ?? 500;
    if (status >= 500) log.error(`${req.method} ${redactUrl(req.url)}`, err);
    else log.warn(`${status} ${req.method} ${redactUrl(req.url)}`, err.message);

    return reply.code(status).send({
      error: status < 500 ? err.message : 'Internal server error',
    });
  });

  await app.register(fastifyCookie);

  /*
    Demo: route the request into the visitor's sandbox. The hook sits right
    after cookie parsing and wraps the rest of the handling in that sandbox's
    database context (AsyncLocalStorage, see db/index.ts) — from there all
    code, session check included, transparently works with that sandbox's
    database. A cookie without a live sandbox (expired, evicted, restart) —
    no context is set, the session won't be found in the main database,
    the client gets an honest 401 and returns to the login screen
    for a fresh sandbox.
  */
  if (env.demoMode) {
    const { SANDBOX_COOKIE, getSandbox, trackRequest } = await import('./lib/sandbox.js');
    const { runWithDb } = await import('./db/index.js');
    app.addHook('onRequest', (req, _reply, done) => {
      const sandboxId = req.cookies[SANDBOX_COOKIE];
      const sandbox = sandboxId ? getSandbox(sandboxId) : null;
      if (sandbox) {
        trackRequest(sandbox, req.method, req.url);
        return runWithDb(sandbox.db, done);
      }
      done();
    });
  }

  /*
    Hosted: route the request to its family by the Host header — the same
    contract as the demo hook above, with a permanent family instead of a
    throwaway sandbox (lib/tenants.ts). Every request gets a tenant:
    unknown subdomains get the ghost, which answers like a family
    rejecting a wrong password — so names cannot be enumerated.
  */
  if (env.hostedMode) {
    const { resolveTenant } = await import('./lib/tenants.js');
    const { runWithTenant } = await import('./db/index.js');
    app.addHook('onRequest', (req, _reply, done) => {
      return runWithTenant(resolveTenant(req.headers.host), done);
    });
  }
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: 10 },
  });

  /*
    Security headers. CSP is strict because we can afford it:
    the frontend is built by Vite into its own files, no external fonts
    or scripts. 'unsafe-inline' only for styles — React sets inline style
    attributes (project colors, avatars), without it they stop applying.
    HSTS is not set here: the proxy that terminates TLS owns it.
  */
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: false,
  });

  /*
    A general rate-limit fuse — API only. The threshold is generous:
    a family of a few people will never hit it, but it cuts the tempo
    of a scanner or a script hammering the API. Key — client IP
    (with trustProxy that is the real address, not Caddy's). Login has
    its own, much stricter limit — set on the route itself in auth.ts.

    Exempt from the limit:
    — static files and app pages: an interface of dozens of files must not
      compete with the API for budget, and a rate-limit error on the page
      itself looks like the whole hub is broken;
    — attachment reads: note images go through /api/attachments,
      a note with fifty receipt photos is fifty requests at once,
      and honest browsing of the family archive would eat the budget
      instantly. Attachments sit behind auth and are cached by the
      browser forever.
  */
  await app.register(fastifyRateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) =>
      !req.url.startsWith('/api') ||
      (req.method === 'GET' && req.url.startsWith('/api/attachments/')),
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Too many requests. Wait ${Math.ceil(context.ttl / 1000)} s.`,
    }),
  });

  // Logout and similar methods are called without a body. Fastify answers
  // that with a 400 by default — allow an empty body explicitly.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = (body as string).trim();
    if (raw === '') return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(Object.assign(new Error('The request body is not valid JSON'), { statusCode: 400 }), undefined);
    }
  });

  /*
    A CSRF barrier on top of SameSite=Lax: on a cross-site request the
    browser must send Origin, and it won't match our Host. A request
    without the header (curl, apps, same-origin GET) passes — that is not
    the cross-site browser scenario we defend against. Only hosts are
    compared: behind the proxy only Caddy knows the scheme.

    Production only: the Vite dev proxy rewrites Host to the API address
    (localhost:8787) while Origin stays the frontend's (localhost:5173) —
    the check would cut every legitimate dev request. In production Host
    arrives untouched both on direct access and via Caddy.
  */
  if (env.isProd) {
    app.addHook('onRequest', (req, reply, done) => {
      if (req.method === 'GET' || req.method === 'HEAD') return done();
      if (!req.url.startsWith('/api')) return done();
      const origin = req.headers.origin;
      if (!origin || origin === 'null') return done();
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return reply.code(403).send({ error: 'Cross-site request rejected' });
      }
      if (originHost !== req.headers.host) {
        return reply.code(403).send({ error: 'Cross-site request rejected' });
      }
      done();
    });
  }

  app.addHook('preHandler', authenticate);

  /*
    Hosted activity counters (lib/hosted-stats.ts). Registered after
    authenticate on purpose: the user id is part of the count (distinct
    active users per day), and requests authenticate rejects never get
    here — unauthenticated probing is not engagement.
  */
  if (env.hostedMode) {
    const { trackFamilyRequest } = await import('./lib/hosted-stats.js');
    const { currentTenant } = await import('./db/index.js');
    app.addHook('preHandler', (req, _reply, done) => {
      const { familyId } = currentTenant();
      if (familyId) trackFamilyRequest(familyId, req.method, req.url, req.user?.id);
      done();
    });
  }

  await registerAuthRoutes(app);
  await registerGoogleRoutes(app);
  await registerSetupRoutes(app);
  await registerUserRoutes(app);
  await registerProfileRoutes(app);
  await registerPublicWishlistRoutes(app);
  await registerProjectRoutes(app);
  await registerTaskRoutes(app);
  await registerNoteRoutes(app);
  await registerAttachmentRoutes(app);
  await registerCalendarRoutes(app);
  await registerMailRoutes(app);
  await registerInboundMailRoutes(app);
  await registerPasswordResetRoutes(app);
  await registerMoneyRoutes(app);
  await registerBudgetRoutes(app);
  await registerFamilyRoutes(app);

  await registerRoutes(app);

  // In dev the frontend lives on Vite. So hitting the API port doesn't look broken:
  if (!env.isProd) {
    app.get('/', (_req, reply) =>
      reply
        .type('text/plain; charset=utf-8')
        .send('The API is up. The UI runs in dev mode at http://localhost:5173'),
    );
  }

  // In production the same process serves the built frontend.
  // In dev the frontend lives on Vite and proxies /api here.
  if (env.isProd && existsSync(env.webDist)) {
    await app.register(fastifyStatic, { root: env.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.code(404).send({ error: 'No such endpoint' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
