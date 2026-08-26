import { t } from '../lib/i18n';
import { BUILD_SHA, ISSUES_URL, REPO_URL, VERSION } from '../lib/build';
import { homeName } from '../lib/home-name';
import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { applyUpdate, setupPwa } from '../lib/pwa';
import { clearFailure, useFailure } from '../lib/failures';
import { QuickAdd } from './QuickAdd';
import { GlobalSearch, SearchTrigger } from './GlobalSearch';
import { applyTheme, initialDark, persistTheme } from '../lib/theme';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const NAV: NavItem[] = [
  {
    to: '/',
    label: t('Today'),
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M4 11 12 4l8 7" />
        <path d="M6 10v9h12v-9" />
      </svg>
    ),
  },
  {
    to: '/tasks',
    label: t('Tasks'),
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M4 7h10M4 12h10M4 17h6" />
        <path d="m17 6 2 2 3-3" />
      </svg>
    ),
  },
  {
    to: '/calendar',
    label: t('Calendar'),
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
        <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
      </svg>
    ),
  },
  {
    to: '/notes',
    label: t('Notes'),
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5Z" />
        <path d="M14.5 3.5V8h4.5M9 13h6M9 16.5h4" />
      </svg>
    ),
  },
  {
    to: '/money',
    label: t('Money'),
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <rect x="3" y="6.5" width="18" height="12" rx="2" />
        <circle cx="12" cy="12.5" r="2.5" />
        <path d="M6.5 12.5h.01M17.5 12.5h.01" />
      </svg>
    ),
  },
];

/** Sections that don't belong in the main row. */
const SECONDARY: NavItem[] = [
  {
    to: '/family',
    label: t('Family'),
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19c.6-3 2.6-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
        <circle cx="17" cy="9.5" r="2.3" />
        <path d="M15.6 14.9c2.6.1 4.3 1.4 4.9 3.9" />
      </svg>
    ),
  },
  {
    to: '/lists',
    label: t('Lists'),
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M4 7h2M4 12h2M4 17h2M9 7h11M9 12h11M9 17h7" />
      </svg>
    ),
  },
  {
    to: '/mail',
    label: t('Mail'),
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <rect x="3" y="5.5" width="18" height="13" rx="2" />
        <path d="m4 7.5 8 6 8-6" />
      </svg>
    ),
  },
  {
    to: '/settings',
    label: t('Settings'),
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" />
      </svg>
    ),
  },
];

// The class is already on the document by the time this mounts (lib/theme
// applies it at import, so the pre-login screens are themed too) — the
// hook only mirrors it into state and flips it. Persisting stays here, on
// the explicit toggle: startup must not write a value the person never
// chose, or "follow the system" would silently become sticky.
function useTheme() {
  const [dark, setDark] = useState(initialDark);

  useEffect(() => {
    applyTheme(dark);
  }, [dark]);

  return {
    dark,
    toggle: () => {
      const next = !dark;
      setDark(next);
      persistTheme(next);
    },
  };
}

function ThemeIcon({ dark, className }: { dark: boolean; className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...stroke}>
      {dark ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M22 12h-2M4 12H2M18.4 5.6 17 7M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6" />
        </>
      ) : (
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
      )}
    </svg>
  );
}

/**
 * Sign out is the one destructive-ish action in the shell, so it gets a
 * clearer affordance than plain text: a door-with-arrow glyph and an
 * urgent-toned pill on hover (same pill language as the priority badges).
 */
function SignOutButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-full border border-transparent px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-urgent/40 hover:bg-urgent/10 hover:text-urgent"
    >
      <svg viewBox="0 0 24 24" className="size-4" {...stroke} aria-hidden>
        <path d="M10 20H5V4h5" />
        <path d="m14 8 4 4-4 4" />
        <path d="M18 12H9" />
      </svg>
      {t('Sign out')}
    </button>
  );
}

/**
 * "That did not save" — the shared surface for inline actions that have
 * no dialog to put an error in (#85). Same visual language and position
 * as the update toast below, urgent-toned. It stays until dismissed or
 * replaced: an error that hides itself before it is read said nothing.
 */
function FailureToast() {
  const failure = useFailure();
  if (!failure) return null;
  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 md:right-6 md:bottom-6 md:left-auto md:translate-x-0">
      <div className="flex items-center gap-3 rounded-full border border-urgent/40 bg-surface py-2 pr-2 pl-4 shadow-xl">
        <span className="text-sm text-ink">{failure.message}</span>
        <button
          type="button"
          onClick={clearFailure}
          aria-label={t('Close')}
          className="grid size-7 place-items-center rounded-full text-muted hover:text-ink"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * "The hub was updated" — shown when a new service worker is waiting
 * (see lib/pwa.ts for why long-lived tabs need this at all). Sits above
 * the bottom bar on phones and in the corner on desktop.
 */
function UpdateToast() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    void setupPwa(() => setShow(true));
  }, []);

  if (!show) return null;
  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 md:right-6 md:bottom-6 md:left-auto md:translate-x-0">
      <div className="flex items-center gap-3 rounded-full border border-line bg-surface py-2 pr-2 pl-4 shadow-xl">
        <span className="text-sm whitespace-nowrap text-ink">{t('The hub was updated')}</span>
        <button
          type="button"
          onClick={applyUpdate}
          className="rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          {t('Reload')}
        </button>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { dark, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      className="rounded-full border border-line p-2 text-muted transition-colors hover:text-ink"
      aria-label={dark ? t('Switch to light theme') : t('Switch to dark theme')}
    >
      <ThemeIcon dark={dark} className="size-4" />
    </button>
  );
}

/** Theme row for the mobile More sheet: phones have no sidebar with the
    toggle, and without this row the theme could not be switched at all. */
function ThemeRow() {
  const { dark, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex w-full items-center gap-3 border-b border-line px-5 py-3.5 text-sm text-ink"
    >
      <span className="size-5 text-muted">
        <ThemeIcon dark={dark} className="size-5" />
      </span>
      {dark ? t('Switch to light theme') : t('Switch to dark theme')}
    </button>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  // A task added from anywhere must show up immediately in the open section
  const [refreshKey, setRefreshKey] = useState(0);
  // Search is owned by the shell: on the phone it's opened from the bottom bar,
  // and there is no sidebar there at all.
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const sidebarNav = [...NAV, ...SECONDARY];

  useEffect(() => {
    void api
      .get<Record<string, string>>('/settings')
      .then(setSettings)
      .catch(() => {});
  }, []);

  // The brand defaults to "Neiliro"; a family-chosen name wins verbatim.
  const displayName = homeName(settings);
  useEffect(() => {
    document.title = displayName;
  }, [displayName]);

  return (
    <div className="min-h-dvh md:flex">
      {/* Sidebar navigation: laptop and kiosk.
          Sticky with its own scroll: on a long task list the page
          scrolls while the section panel stays put. */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface px-4 py-6 md:sticky md:top-0 md:flex md:h-dvh md:overflow-y-auto 3xl:w-64">
        {/* The theme toggle lives in the header: next to Sign out a missed
            click cost a whole session — a price out of scale for the button */}
        <div className="mb-8 flex items-center justify-between px-2">
          <span className="font-display text-lg font-bold tracking-tight text-ink">{displayName}</span>
          <ThemeToggle />
        </div>

        <div className="mb-4">
          <SearchTrigger onOpen={() => setSearchOpen(true)} />
        </div>

        <nav className="flex flex-1 flex-col gap-1">
          {sidebarNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                [
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-muted hover:bg-surface-2 hover:text-ink',
                ].join(' ')
              }
            >
              <span className="size-5 shrink-0">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-3 border-t border-line pt-4">
          <div className="flex items-center gap-2.5 px-2">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: user?.color ?? 'var(--c-accent)' }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{user?.name}</span>
          </div>
          <div className="px-2">
            <SignOutButton onClick={() => void logout()} />
          </div>
          {/* The app's footer. Which build is on screen — a stale bundle in
              a long-lived tab looks exactly like a fix that never deployed,
              and this is the cheapest way to tell those apart — and the two
              links worth having within reach. Settings → About repeats it
              for phones, where this sidebar does not exist. */}
          <div className="px-2 text-muted">
            <p
              className="font-mono text-xs"
              title={BUILD_SHA ? `${VERSION} · ${BUILD_SHA}` : VERSION}
            >
              v{VERSION}
              {BUILD_SHA && <span className="ml-1.5 opacity-70">{BUILD_SHA}</span>}
            </p>
            <span className="mt-1.5 flex flex-col items-start gap-1 text-sm">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-line underline-offset-2 hover:text-ink"
              >
                {t('Source code')}
              </a>
              <a
                href={ISSUES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-line underline-offset-2 hover:text-ink"
              >
                {t('Report a bug')}
              </a>
            </span>
          </div>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 pb-20 md:pb-0">
        <ConfirmAddressNotice />
        <Outlet key={refreshKey} />
      </main>

      <QuickAdd onAdded={() => setRefreshKey((k) => k + 1)} />
      <FailureToast />
      <UpdateToast />

      {/* The search modal lives at the shell root: inside the sidebar it
          inherited the sidebar's display:none on phones and never showed */}
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />

      {/* Bottom navigation: phone */}
      <nav className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-6 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              [
                'flex flex-col items-center gap-1 py-2.5 text-[0.6875rem] transition-colors',
                isActive ? 'text-accent' : 'text-muted',
              ].join(' ')
            }
          >
            <span className="size-5">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}

        {/* Sixth item holds everything that didn't fit: search, settings, users */}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className={`flex flex-col items-center gap-1 py-2.5 text-[0.6875rem] ${
            moreOpen ? 'text-accent' : 'text-muted'
          }`}
        >
          <svg viewBox="0 0 24 24" className="size-5" {...stroke}>
            <circle cx="5" cy="12" r="1.2" />
            <circle cx="12" cy="12" r="1.2" />
            <circle cx="19" cy="12" r="1.2" />
          </svg>
          {t('More')}
        </button>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-20 md:hidden">
          <button
            type="button"
            aria-label={t('Close')}
            onClick={() => setMoreOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-card border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false);
                setSearchOpen(true);
              }}
              className="flex w-full items-center gap-3 border-b border-line px-5 py-3.5 text-sm text-ink"
            >
              <svg viewBox="0 0 24 24" className="size-5 text-muted" {...stroke}>
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4 4" />
              </svg>
              {t('Search')}
            </button>

            {SECONDARY.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMoreOpen(false)}
                className="flex w-full items-center gap-3 border-b border-line px-5 py-3.5 text-sm text-ink last:border-0"
              >
                <span className="size-5 text-muted">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}

            <ThemeRow />

            <div className="flex items-center justify-between px-5 py-3.5">
              <span className="text-sm text-muted">{user?.name}</span>
              <SignOutButton onClick={() => void logout()} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/*
  One quiet line asking the person to confirm their login address.

  It is not a modal and not a blocker: everything works without it. What
  does not work is password recovery — an address nobody proved is not
  something a reset may be mailed to — so the ask has to be visible
  somewhere, and the top of the page is the honest place. Hosted only: the
  server sends the flag only where the confirmation means anything.
*/
function ConfirmAddressNotice() {
  const { user } = useAuth();
  const [state, setState] = useState<'idle' | 'sent'>('idle');
  const [dismissed, setDismissed] = useState(false);

  if (!user?.email_verification_pending || dismissed) return null;

  return (
    <div className="mx-4 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line bg-surface-2 px-4 py-2.5 text-sm md:mx-6">
      {state === 'sent' ? (
        <span className="text-muted">
          {t('Sent. Open the link in that mailbox to confirm the address.')}
        </span>
      ) : (
        <>
          <span className="text-ink">
            {t('Confirm {email} so you can reset your password by email if you forget it.', {
              email: user.email,
            })}
          </span>
          <button
            type="button"
            onClick={() => {
              void api.post('/profile/email-verify', {}).then(() => setState('sent'));
            }}
            className="font-medium text-accent underline"
          >
            {t('Send the link')}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-auto text-muted hover:text-ink"
        aria-label={t('Hide')}
      >
        ×
      </button>
    </div>
  );
}
