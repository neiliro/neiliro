import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { createSession, SESSION_COOKIE, setSessionCookie, userForToken } from '../lib/auth.js';
import { log } from '../lib/log.js';
import { slugFromHost } from '../lib/tenants.js';

/*
  Sign-in with Google — a plain OIDC authorization code flow with PKCE,
  by hand via two fetches: heavy SDKs are not needed here.

  The rules this module upholds:

  — Accounts are NOT created via Google. Login admits only those whose
    google_sub is already linked; any other Google account is refused.
    The hub is a family one, the roster is known, self-signup is not
    a thing.

  — Linking happens only by explicit action from settings, under a live
    session. No linking "by matching email": the email in Google can be
    changed, and local accounts have ones like user@hub.local that don't
    google at all.

  — Identification is by the `sub` claim — the Google account's
    permanent ID.

  Hosted mode adds one hop. Google's redirect URIs are exact strings —
  there is no wildcard for *.neiliro.com — so every family's sign-in
  returns to ONE reserved host (`auth.<apex>`), which then hands the
  browser back to the family's own subdomain with a single-use ticket.
  The hand-back is not decoration: the session cookie is host-only, so
  only the family's own host can set it. A pleasant side effect is that
  Google never learns which family signed in — it sees one callback host.
*/

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** How long a started but unfinished Google sign-in lives. */
const STATE_TTL_MS = 10 * 60_000;

/*
  The cookie ties the state to the browser that started the flow. Without
  it, a foreign callback URL slipped to the victim would quietly complete
  the attacker's flow in her browser (login CSRF). Now the return from
  Google is accepted only in the browser where the sign-in began.
*/
const OAUTH_COOKIE = 'hub_oauth';

/*
  Hosted hand-back. The callback host knows who signed in but cannot set
  the family's session cookie, so it parks the result under a single-use
  ticket and sends the browser home. The ticket is short-lived on purpose:
  it is a bearer token for one specific sign-in, and it travels in a URL.

  Three things are checked when it is redeemed, and each closes a
  different door: the family it was issued for (a ticket replayed on
  another family's subdomain is refused), the state cookie from the
  browser that began the flow (a stolen ticket alone is not enough), and
  single use (a redeemed ticket is gone).
*/
const HANDOFF_TTL_MS = 60_000;

interface Handoff {
  slug: string;
  state: string;
  mode: 'login' | 'link';
  userId?: string;
  sub: string;
  email: string | null;
  expires: number;
}

const handoffs = new Map<string, Handoff>();

function pruneHandoffs(): void {
  const now = Date.now();
  for (const [key, value] of handoffs) {
    if (value.expires < now) handoffs.delete(key);
  }
}

interface PendingState {
  verifier: string;
  mode: 'login' | 'link';
  /** For linking — who we are linking to. */
  userId?: string;
  /** Hosted: which family started the flow, since the return lands elsewhere. */
  slug?: string;
  expires: number;
}

// In memory: there is one process, and an unfinished flow should die with a restart anyway
const pending = new Map<string, PendingState>();

function prunePending(): void {
  const now = Date.now();
  for (const [key, value] of pending) {
    if (value.expires < now) pending.delete(key);
  }
}

/**
 * Whether the button makes sense at all. Exported because the sign-in
 * screen asks the same question through /api/auth/state — and there the
 * answer must be identical for a real family and for the ghost, or the
 * button's presence would enumerate families all by itself.
 */
export function googleSignInAvailable(): boolean {
  return Boolean(
    env.googleClientId && env.googleClientSecret && (env.publicUrl || env.hostedMode),
  );
}

/** The one host Google is allowed to return to in hosted mode. */
function authHost(): string {
  return `auth.${env.hostedDomain}`;
}

function redirectUri(): string {
  // Hosted: one client, one callback, many families — see the note on top.
  // `auth` is in RESERVED_SLUGS, so no family can ever claim this name.
  if (env.hostedMode) return `https://${authHost()}/api/auth/google/callback`;
  return `${env.publicUrl}/api/auth/google/callback`;
}

/** PKCE: the verifier stays with us, the challenge travels to Google. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function startFlow(
  req: FastifyRequest,
  reply: FastifyReply,
  mode: 'login' | 'link',
  userId?: string,
): void {
  prunePending();
  const state = randomBytes(24).toString('base64url');
  const { verifier, challenge } = pkcePair();
  // Hosted: remember the family here, because the callback arrives on a
  // different host with no tenant of its own. An unknown subdomain gets
  // the same treatment as a real one — the ghost must not be recognisable
  // by the sign-in screen behaving differently.
  const slug = env.hostedMode ? (slugFromHost(req.headers.host) ?? undefined) : undefined;
  if (env.hostedMode && !slug) {
    // Not a family address at all (the apex, a nested label, a foreign
    // host): there is nowhere to hand the browser back to.
    void reply.redirect('/?google=error');
    return;
  }
  pending.set(state, { verifier, mode, userId, slug, expires: Date.now() + STATE_TTL_MS });

  reply.setCookie(OAUTH_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax', // Lax lets the cookie through on the top-level redirect from Google
    secure: env.secureCookies,
    path: '/api/auth/google',
    maxAge: STATE_TTL_MS / 1000,
  });

  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', env.googleClientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Always show the account chooser: a family device may hold
  // several Google accounts
  url.searchParams.set('prompt', 'select_account');

  void reply.redirect(url.toString());
}

/** Exchange the code for a token and fetch the sub. Errors escape as exceptions. */
async function fetchGoogleSub(code: string, verifier: string): Promise<{ sub: string; email: string | null }> {
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token endpoint: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error('Google returned no access_token');

  const infoRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!infoRes.ok) {
    throw new Error(`Google userinfo: ${infoRes.status} ${await infoRes.text()}`);
  }
  const info = (await infoRes.json()) as { sub?: string; email?: string };
  if (!info.sub) throw new Error('Google returned no sub');
  return { sub: info.sub, email: info.email ?? null };
}

/**
 * Turn a proven Google identity into its local consequence, inside the
 * database this request belongs to. Shared by the self-hosted callback and
 * the hosted hand-back: what differs between them is the transport, not
 * the meaning, and the rules at the top of this file must hold in both.
 */
function applyGoogleIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
  identity: { mode: 'login' | 'link'; userId?: string; sub: string; email: string | null },
): void {
  const { mode, userId, sub, email } = identity;

  if (mode === 'link') {
    if (!userId) {
      void reply.redirect('/?google=error');
      return;
    }

    const taken = db
      .prepare('SELECT id FROM users WHERE google_sub = ? AND id != ?')
      .get(sub, userId);
    if (taken) {
      // One Google account — one user account
      void reply.redirect('/settings?google=taken');
      return;
    }

    db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(sub, userId);
    log.info(`google linked: user ${userId}, ${email ?? 'email hidden'} from ${req.ip}`);
    void reply.redirect('/settings?google=linked');
    return;
  }

  // mode === 'login'
  const user = db
    .prepare('SELECT id, email FROM users WHERE google_sub = ? AND disabled_at IS NULL')
    .get(sub) as { id: string; email: string } | undefined;

  if (!user) {
    // A valid Google account, but not ours. No account is created — refuse.
    log.warn(`google login refused: ${email ?? sub} is not linked, from ${req.ip}`);
    void reply.redirect('/?google=not_linked');
    return;
  }

  setSessionCookie(reply, createSession(user.id, req.headers['user-agent'], req.ip));
  log.info(`google login: ${user.email} from ${req.ip}`);
  void reply.redirect('/');
}

export async function registerGoogleRoutes(app: FastifyInstance): Promise<void> {
  // Login start. A public route: there is no session yet.
  app.get('/api/auth/google/start', (req, reply) => {
    if (!googleSignInAvailable()) {
      return reply.code(501).send({ error: 'Google sign-in is not configured' });
    }
    return startFlow(req, reply, 'login');
  });

  // Linking start. Closed by the general authentication: no session, no entry.
  app.get('/api/auth/google/link', (req, reply) => {
    if (!googleSignInAvailable()) {
      return reply.code(501).send({ error: 'Google sign-in is not configured' });
    }
    return startFlow(req, reply, 'link', req.user?.id);
  });

  // The return from Google. A public route; we tell our states from foreign ones ourselves.
  app.get('/api/auth/google/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;

    // The user changed their mind on the Google screen — not an error, just go back
    if (q.error) {
      return reply.redirect(q.error === 'access_denied' ? '/' : '/?google=error');
    }

    // Hosted: Google knows exactly one callback URI, so this route is only
    // ever reached on that host. The same path on a family's subdomain is
    // confusion at best and a code planted by hand at worst.
    if (env.hostedMode && (req.headers.host ?? '').split(':')[0] !== authHost()) {
      return reply.redirect('/?google=error');
    }

    prunePending();
    const state = q.state ? pending.get(q.state) : undefined;
    /*
      The state must match the cookie set at flow start: the return is
      accepted only in the browser that began the sign-in. In hosted mode
      that cookie belongs to the family's host and is not sent here — the
      check does not disappear, it moves to the hand-back below, which is
      the first moment the cookie is in scope again.
    */
    const browserMatches = env.hostedMode || req.cookies[OAUTH_COOKIE] === q.state;
    if (!state || !q.code || !browserMatches) {
      // A foreign, expired or reused state
      return reply.redirect('/?google=error');
    }
    pending.delete(q.state!); // single-use
    if (!env.hostedMode) reply.clearCookie(OAUTH_COOKIE, { path: '/api/auth/google' });

    let sub: string;
    let email: string | null;
    try {
      ({ sub, email } = await fetchGoogleSub(q.code, state.verifier));
    } catch (err) {
      log.error('Google code exchange failed', err);
      return reply.redirect('/?google=error');
    }

    if (env.hostedMode) {
      // Park the result and send the browser home: only the family's own
      // host can set the family's session cookie.
      pruneHandoffs();
      const ticket = randomBytes(24).toString('base64url');
      handoffs.set(ticket, {
        slug: state.slug!,
        state: q.state!,
        mode: state.mode,
        userId: state.userId,
        sub,
        email,
        expires: Date.now() + HANDOFF_TTL_MS,
      });
      return reply.redirect(
        `https://${state.slug}.${env.hostedDomain}/api/auth/google/finish?ticket=${ticket}`,
      );
    }

    applyGoogleIdentity(req, reply, {
      mode: state.mode,
      userId: state.userId,
      sub,
      email,
    });
    return reply;
  });

  /*
    The hosted hand-back. Public, because for a login this is where the
    session is born; the ticket from the callback host is the authorization,
    and it is only worth anything together with the cookie of the browser
    that started the flow.
  */
  app.get('/api/auth/google/finish', (req, reply) => {
    if (!env.hostedMode) return reply.callNotFound();

    pruneHandoffs();
    const { ticket } = req.query as { ticket?: string };
    const handoff = ticket ? handoffs.get(ticket) : undefined;
    if (!handoff) return reply.redirect('/?google=error');
    handoffs.delete(ticket!); // single use, redeemed or not

    const slug = slugFromHost(req.headers.host);
    if (!slug || slug !== handoff.slug) {
      // A ticket carried to another family's subdomain
      log.warn(`google hand-back refused: issued for ${handoff.slug}, redeemed at ${slug ?? 'a non-family host'}`);
      return reply.redirect('/?google=error');
    }
    if (req.cookies[OAUTH_COOKIE] !== handoff.state) {
      return reply.redirect('/?google=error');
    }
    reply.clearCookie(OAUTH_COOKIE, { path: '/api/auth/google' });

    if (handoff.mode === 'link') {
      // Linking still requires the live session it was started from: this
      // route is public, so the session is resolved here by hand rather
      // than by the authentication hook.
      const token = req.cookies[SESSION_COOKIE];
      const user = token ? userForToken(token) : null;
      if (!user || user.id !== handoff.userId) {
        return reply.redirect('/settings?google=error');
      }
    }

    applyGoogleIdentity(req, reply, handoff);
    return reply;
  });
}
