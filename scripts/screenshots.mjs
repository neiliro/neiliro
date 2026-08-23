#!/usr/bin/env node
/*
  Documentation screenshots.

  Shot from a demo sandbox, never from a real hub: the seeded family is
  plausible, the dates are relative to today, and nobody's actual money
  ends up in the README.

  Chrome rather than a bundled browser: playwright-core ships no binaries,
  and a Mac already has one. Set CHROME to point elsewhere.

    DEMO_MODE=true DATA_DIR=~/.family-hub-demo npm run dev   # in one terminal
    npm run screenshots                                      # in another

  BASE_URL points it at any demo, including the deployed one — which is
  what to use after a release, so the images show what actually shipped:

    BASE_URL=https://demo.zgmndv.com npm run screenshots

  Both themes are written when --both is passed; by default only the dark
  one, which is what the README uses.
*/
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/screenshots');
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Retina: the README is read on laptop screens, a 1x shot looks soft. */
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;

/**
 * One entry per image. `prepare` runs after navigation, before the shot —
 * for opening a panel or scrolling a section into view.
 */
const SHOTS = [
  { name: 'dashboard', path: '/' },
  {
    name: 'dashboard-customize',
    path: '/',
    // The board's edit mode: drag handles, width switches, hide buttons —
    // the part prose explains worst. Entering it persists nothing, so the
    // screens shot after this one are unaffected.
    async prepare(page) {
      await page.getByRole('button', { name: /customize/i }).click();
      await page.waitForTimeout(300);
    },
  },
  { name: 'tasks', path: '/tasks' },
  { name: 'calendar', path: '/calendar' },
  { name: 'money', path: '/money' },
  {
    name: 'notes',
    path: '/notes',
    // Same reason as mail below: with no note picked, two thirds of the
    // frame is a "pick a note" pane, and the editor is the point here
    async prepare(page) {
      await page.getByText('Shopping list').first().click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'mail',
    path: '/mail',
    // An empty reading pane sells nothing — open the first letter
    async prepare(page) {
      await page.locator('button', { hasText: 'Riverside School' }).first().click();
      await page.waitForLoadState('networkidle');
    },
  },
  {
    name: 'settings',
    path: '/settings',
    // The mailbox block sits below the fold on a 900px viewport
    async prepare(page) {
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
];

const both = process.argv.includes('--both');

/*
  The phone set. A narrow viewport is not the desktop one squeezed: the
  dashboard grows three quick-action buttons that wide screens never show,
  the sidebar becomes a bottom bar, and the money rows restack. Those are
  the parts worth a picture, so this shoots fewer screens rather than all
  of them at 375px.

  iPhone 12/13/14 metrics, and `isMobile` so the app takes the touch
  branch rather than merely rendering narrow.
*/
const PHONE_SHOTS = [
  { name: 'phone-dashboard', path: '/' },
  { name: 'phone-money', path: '/money' },
  { name: 'phone-tasks', path: '/tasks' },
];

async function shootPhone(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    locale: 'en-GB',
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('hub.theme', 'dark');
    localStorage.setItem('hub-lang', 'en');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /try the demo/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });

  for (const shot of PHONE_SHOTS) {
    await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `${shot.name}.png`) });
    console.log(`  phone ${shot.name}.png`);
  }
  await context.close();
}

/**
 * The setup screen an empty hub shows — the one both install guides
 * describe. It only exists before the first account, so it needs a hub
 * with no users rather than the demo:
 *
 *   rm -rf ~/.family-hub-qa
 *   DATA_DIR=~/.family-hub-qa npm run dev
 *   node scripts/screenshots.mjs --first-run
 */
async function shootFirstRun(browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: 'dark',
    locale: 'en-GB',
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('hub.theme', 'dark');
    localStorage.setItem('hub-lang', 'en');
  });
  await page.reload({ waitUntil: 'networkidle' });
  const heading = page.getByText(/first run/i);
  if ((await heading.count()) === 0) {
    throw new Error('This hub already has an account — point BASE_URL at an empty one');
  }
  await page.screenshot({ path: join(OUT, 'first-run.png') });
  console.log('  dark  first-run.png');
  await context.close();
}

async function shoot(browser, theme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: theme,
    // The seeded family speaks English; the screenshots in the docs do too
    locale: 'en-GB',
  });
  const page = await context.newPage();

  // The demo hands out a sandbox for a button press — no credentials to type
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate((t) => {
    localStorage.setItem('hub.theme', t);
    localStorage.setItem('hub-lang', 'en');
  }, theme);
  await page.reload({ waitUntil: 'networkidle' });

  const demoButton = page.getByRole('button', { name: /try the demo/i });
  await demoButton.click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });
  await page.waitForLoadState('networkidle');

  for (const shot of SHOTS) {
    await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle' });
    if (shot.prepare) await shot.prepare(page);
    // Charts and avatars animate in; a beat avoids catching a half-drawn donut
    await page.waitForTimeout(600);
    const suffix = both && theme === 'light' ? '-light' : '';
    const file = join(OUT, `${shot.name}${suffix}.png`);
    await page.screenshot({ path: file });
    console.log(`  ${theme.padEnd(5)} ${shot.name}${suffix}.png`);
  }

  await context.close();
}

const browser = await chromium.launch({ executablePath: CHROME });
try {
  await mkdir(OUT, { recursive: true });
  console.log(`Shooting ${BASE} → docs/screenshots`);
  if (process.argv.includes('--first-run')) {
    await shootFirstRun(browser);
  } else if (process.argv.includes('--phone')) {
    await shootPhone(browser);
  } else {
    await shoot(browser, 'dark');
    if (both) await shoot(browser, 'light');
    await shootPhone(browser);
  }
} finally {
  await browser.close();
}
