import { randomUUID } from 'node:crypto';
import { db, now, today } from '../db/index.js';
import { hashPassword } from './password.js';
import { type DemoLang, demoStrings } from './demo.strings.js';

/*
  Demo mode (DEMO_MODE=true) — a public "try before installing" sandbox.

  The demo's content lives here: seeding of a plausible family (tasks,
  notes, calendar, money) and the list of restrictions. The lifecycle is
  in sandbox.ts: seeding fills the template database, and every visitor
  gets a fresh copy of it, so other people's garbage never appears in
  the demo by design.

  The restrictions got shorter than with a shared database: a visitor can
  only spoil the content for themselves. What stays closed: password and
  family membership changes (meaningless in a sandbox, and invite links
  mislead) and file uploads — the disk is shared, and a file dump is
  still a file dump.
*/

/** What the demo forbids. Checked in authenticate after login. */
export function demoBlocked(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  if (path.startsWith('/api/users')) return true;
  if (path.startsWith('/api/invites')) return true;
  if (path === '/api/auth/change-password') return true;
  if (path === '/api/auth/password-login') return true;
  // TOTP setup in a throwaway sandbox would only teach visitors to
  // scan QR codes for accounts that stop existing in two hours
  if (path.startsWith('/api/auth/totp')) return true;
  if (path.startsWith('/api/auth/google')) return true;
  // The family archive and self-deletion are meaningless for a throwaway
  // sandbox. Only the POST is caught here — GETs pass through this
  // function, so the export route carries its own demo check.
  if (path.startsWith('/api/family/')) return true;
  // All file uploads: note attachments and transaction receipts
  if (method === 'POST' && path.includes('/attachments')) return true;
  if (method === 'POST' && path.includes('/receipts')) return true;
  // Mail: sandboxes must not talk to real mail servers or send anything.
  // Reading and "make it a task" stay open — that is the showcase.
  if (path.startsWith('/api/mail/account')) return true;
  if (path === '/api/mail/sync') return true;
  if (path.endsWith('/reply') && path.startsWith('/api/mail/')) return true;
  return false;
}

function id(): string {
  return randomUUID();
}

/** ISO date offset from today, local time — as everywhere in the hub. */
/**
 * A birthdate for the seeds: a past year wearing day(offset)'s month and
 * day, so the template database (rebuilt daily) always has a birthday
 * coming up and the age math stays honest.
 */
function birthdate(offset: number, year: number): string {
  return `${year}${day(offset).slice(4)}`;
}

function day(offset: number): string {
  const base = new Date(`${today()}T00:00:00`);
  base.setDate(base.getDate() + offset);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const d = String(base.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Fills the current context's database with an example family, in `lang`.
 * Expects an empty database.
 *
 * Every human-readable string comes from demo.strings.ts rather than from
 * the SQL below: sandbox.ts builds one template per language, and a visitor
 * gets the copy that matches theirs. Nothing here may be an inline literal,
 * or that language quietly keeps a word of English.
 */
export async function seedDemo(lang: DemoLang): Promise<void> {
  const n = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
  if (n > 0) return;

  const S = demoStrings(lang);

  // Demo login is automatic (POST /api/auth/demo), the password is never
  // told to anyone — hence random. The hardcoded demo1234 was shorter
  // than the hub's own minimum and lived in two places in the code.
  const passwordHash = await hashPassword(randomUUID());
  const alex = id();
  const sam = id();

  const seed = db.transaction(() => {
    // ── Family ──
    db.prepare(
      `INSERT INTO users (id, email, name, role, password_hash, color, created_at) VALUES
       (?, 'alex@neiliro.example', ?, 'admin', ?, '#2E6F8E', ?),
       (?, 'sam@neiliro.example', ?, 'member', ?, '#B4654A', ?)`,
    ).run(alex, S.users.alex, passwordHash, now(), sam, S.users.sam, passwordHash, now());

    // ── Projects and tasks ──
    const home = id();
    const trip = id();
    db.prepare(
      `INSERT INTO projects (id, title, description, color, position, created_by) VALUES
       (?, ?, ?, '#4A7A5A', 1, ?),
       (?, ?, ?, '#B4654A', 2, ?)`,
    ).run(
      home, S.projects.home.title, S.projects.home.description, alex,
      trip, S.projects.trip.title, S.projects.trip.description, alex,
    );

    // Nesting is set here, by id. It used to be a second statement matching
    // WHERE title IN (...), which quietly tied the shape of the demo to the
    // English wording — the ids were always available, just thrown away.
    const paint = id();
    const pickColour = id();
    const buyPaint = id();
    // Descriptions on the dated ones: the wide agenda shows a line of
    // the description, and it should have something to show
    db.prepare(
      `INSERT INTO tasks (id, project_id, parent_id, level, title, description, status, priority, due_date, assignee_id, position, created_by) VALUES
       (?, ?, NULL, 0, ?, NULL, 'in_progress', 'normal', ?, ?, 1, ?),
       (?, ?, ?,    1, ?, NULL, 'done', 'normal', NULL, ?, 2, ?),
       (?, ?, ?,    1, ?, ?,    'todo', 'high', ?, ?, 3, ?),
       (?, ?, NULL, 0, ?, ?,    'todo', 'urgent', ?, ?, 4, ?),
       (?, ?, NULL, 0, ?, ?,    'todo', 'high', ?, ?, 5, ?),
       (?, ?, NULL, 0, ?, NULL, 'backlog', 'normal', NULL, NULL, 6, ?)`,
    ).run(
      paint, home, S.tasks.repaint, day(5), alex, alex,
      pickColour, home, paint, S.tasks.pickColour, sam, alex,
      buyPaint, home, paint, S.tasks.buyPaint.title, S.tasks.buyPaint.description, day(2), alex, alex,
      id(), home, S.tasks.tap.title, S.tasks.tap.description, day(0), sam, sam,
      id(), trip, S.tasks.ferry.title, S.tasks.ferry.description, day(12), sam, sam,
      id(), trip, S.tasks.passports, alex,
    );
    // Showcases the expected-finish date (#7): the due date is past, but
    // the repair is known to take a week — the task is not overdue
    db.prepare(
      `INSERT INTO tasks (id, project_id, level, title, status, priority, due_date, expected_date,
                          assignee_id, position, created_by)
       VALUES (?, ?, 0, ?, 'in_progress', 'normal', ?, ?, ?, 7, ?)`,
    ).run(id(), home, S.tasks.coffeeMachine, day(-3), day(4), alex, alex);

    // ── Notes ──
    const recipes = id();
    db.prepare(`INSERT INTO folders (id, name, position) VALUES (?, ?, 1)`).run(
      recipes,
      S.notes.folder,
    );
    db.prepare(
      `INSERT INTO notes (id, title, body_md, folder_id, owner_id, pinned) VALUES
       (?, ?, ?, NULL, ?, 1),
       (?, ?, ?, ?, ?, 0),
       (?, ?, ?, NULL, ?, 0)`,
    ).run(
      // The shopping list links to the repaint task: same language, or the
      // wiki-link points at a title that exists in no database
      id(), S.notes.shopping.title, S.notes.shopping.body(S.tasks.repaint), alex,
      id(), S.notes.dough.title, S.notes.dough.body, recipes, sam,
      id(), S.notes.guests.title, S.notes.guests.body, alex,
    );

    // ── Calendar ──
    const shared = '00000000-0000-4000-8000-000000000201'; // the seeded shared calendar from the migration
    const gym = id();
    const dentist = id();
    const birthday = id();
    const movie = id();
    // The movie lands on "today": the wide agenda unfolds today's rows
    // (description, calendar), and the template must always have one
    // event there to unfold
    db.prepare(
      `INSERT INTO events (id, calendar_id, title, description, location, starts_at, ends_at, all_day, recurrence_rule, remind_days_before, created_by) VALUES
       (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?),
       (?, ?, ?, ?, ?, ?, ?, 0, 'FREQ=WEEKLY;INTERVAL=1', NULL, ?),
       (?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?),
       (?, ?, ?, NULL, NULL, ?, ?, 1, 'FREQ=YEARLY;INTERVAL=1', 7, ?)`,
    ).run(
      movie, shared, S.events.movie.title, S.events.movie.description, S.events.movie.location,
      `${day(0)}T20:00`, `${day(0)}T22:30`, sam,
      gym, shared, S.events.gym.title, S.events.gym.description, S.events.gym.location,
      `${day(1)}T18:30`, `${day(1)}T20:00`, alex,
      dentist, shared, S.events.dentist.title, S.events.dentist.description, S.events.dentist.location,
      `${day(3)}T11:00`, `${day(3)}T11:45`, sam,
      birthday, shared, S.events.grandmaBirthday, day(9), day(9), alex,
    );
    db.prepare(
      `INSERT INTO event_participants (event_id, user_id) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)`,
    ).run(gym, alex, gym, sam, dentist, sam, movie, alex, movie, sam);

    // Every event above sits within two weeks of today, which is fine for
    // the week and the agenda but leaves the month view as a grid of empty
    // cells — the demo's calendar looked like a family that does nothing.
    // A household's month is mostly rhythms and errands, so: two weekly
    // rhythms anchored in the PAST (recurrences only expand forward from
    // their anchor, so a rhythm starting tomorrow leaves every earlier
    // week blank), errands behind us, and something to look forward to.
    // The anchors use different offsets mod 7 so the two rhythms land in
    // different columns whatever weekday the template is built on.
    const swim = id();
    const market = id();
    const lake = id();
    const dinner = id();
    const boiler = id();
    const vet = id();
    db.prepare(
      `INSERT INTO events (id, calendar_id, title, description, location, starts_at, ends_at, all_day, recurrence_rule, remind_days_before, created_by) VALUES
       (?, ?, ?, NULL, ?, ?, ?, 0, 'FREQ=WEEKLY;INTERVAL=1', NULL, ?),
       (?, ?, ?, ?, NULL, ?, ?, 0, 'FREQ=WEEKLY;INTERVAL=1', NULL, ?),
       (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?),
       (?, ?, ?, NULL, NULL, ?, ?, 0, NULL, NULL, ?),
       (?, ?, ?, ?, NULL, ?, ?, 0, NULL, 1, ?),
       (?, ?, ?, NULL, ?, ?, ?, 0, NULL, 1, ?),
       (?, ?, ?, ?, NULL, ?, ?, 1, NULL, 3, ?)`,
    ).run(
      swim, shared, S.events.swim.title, S.events.swim.location,
      `${day(-19)}T16:30`, `${day(-19)}T17:15`, sam,
      market, shared, S.events.market.title, S.events.market.description,
      `${day(-16)}T10:00`, `${day(-16)}T11:00`, alex,
      id(), shared, S.events.carService.title, S.events.carService.description, S.events.carService.location,
      `${day(-13)}T09:00`, `${day(-13)}T10:30`, alex,
      dinner, shared, S.events.dinner, `${day(-8)}T18:30`, `${day(-8)}T21:00`, sam,
      boiler, shared, S.events.boiler.title, S.events.boiler.description,
      `${day(7)}T10:00`, `${day(7)}T12:00`, alex,
      vet, shared, S.events.vet.title, S.events.vet.location,
      `${day(24)}T15:30`, `${day(24)}T16:00`, sam,
      lake, shared, S.events.lake.title, S.events.lake.description, day(18), day(19), alex,
    );
    db.prepare(
      `INSERT INTO event_participants (event_id, user_id) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)`,
    ).run(
      swim, sam, market, alex, market, sam, dinner, alex, dinner, sam,
      lake, alex, lake, sam, vet, sam,
    );

    // ── Family mail ──
    // A believable paperwork inbox; one message is already a task, so
    // the mail → task link is visible without clicking anything
    const school = id();
    db.prepare(
      `INSERT INTO mail_messages (id, kind, from_address, from_name, to_address, subject,
                                  body_text, sent_at, received_at, read_at) VALUES
       (?, 'in', 'office@riverside-school.example', ?, 'family@neiliro.example', ?, ?, ?, ?, NULL),
       (?, 'in', 'no-reply@citypower.example', ?, 'family@neiliro.example', ?, ?, ?, ?, ?)`,
    ).run(
      school, S.mail.school.fromName, S.mail.school.subject, S.mail.school.body,
      `${day(-1)} 09:15`, `${day(-1)} 09:15`,
      id(), S.mail.power.fromName, S.mail.power.subject, S.mail.power.body,
      `${day(-4)} 08:00`, `${day(-4)} 08:00`, `${day(-3)} 20:11`,
    );

    const schoolTask = id();
    db.prepare(
      `INSERT INTO tasks (id, project_id, level, title, description, status, priority, due_date, assignee_id, position, created_by)
       VALUES (?, '00000000-0000-4000-8000-000000000001', 0, ?, ?, 'todo', 'normal', ?, ?, 8, ?)`,
    ).run(
      schoolTask,
      S.tasks.confirmSchool.title,
      S.tasks.confirmSchool.description,
      day(1),
      sam,
      alex,
    );
    db.prepare('UPDATE mail_messages SET task_id = ? WHERE id = ?').run(schoolTask, school);

    // ── Family profiles ──
    // The visitor signs in as Alex, so the seeds are arranged to show
    // both sides of the wishlist rule at once: Sam's list demonstrates
    // reserving (one wish already taken by a guest through the public
    // link — claimed_by_name with no account), while Alex's own list
    // shows the owner's view, where the server hides every claim.
    const alexBirthday = birthdate(6, 1988);
    const samBirthday = birthdate(45, 1990);
    db.prepare(
      `INSERT INTO profiles (user_id, birthday, family_role) VALUES
       (?, ?, 'father'),
       (?, ?, 'mother')`,
    ).run(alex, alexBirthday, sam, samBirthday);
    // The derived birthday events, exactly as PATCH /api/profiles writes
    // them (profiles.ts syncBirthdayEvent): profile_user_id is how the
    // route finds them again when a visitor edits the date
    db.prepare(
      `INSERT INTO events (id, calendar_id, title, starts_at, ends_at, all_day,
                           recurrence_rule, birth_year, profile_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'FREQ=YEARLY', ?, ?, ?, ?),
              (?, ?, ?, ?, ?, 1, 'FREQ=YEARLY', ?, ?, ?, ?)`,
    ).run(
      id(), shared, S.users.alex, alexBirthday, alexBirthday, 1988, alex, now(), now(),
      id(), shared, S.users.sam, samBirthday, samBirthday, 1990, sam, now(), now(),
    );
    db.prepare(
      `INSERT INTO profile_entries (id, user_id, kind, label, value, position) VALUES
       (?, ?, 'preference', ?, '44', 1),
       (?, ?, 'preference', ?, ?, 2),
       (?, ?, 'preference', ?, '38', 1),
       (?, ?, 'preference', ?, ?, 2),
       (?, ?, 'preference', ?, ?, 3),
       (?, ?, 'allergy', ?, NULL, 4)`,
    ).run(
      id(), alex, S.profile.shoes,
      id(), alex, S.profile.coffee.label, S.profile.coffee.value,
      id(), sam, S.profile.shoes,
      id(), sam, S.profile.tea.label, S.profile.tea.value,
      id(), sam, S.profile.flowers.label, S.profile.flowers.value,
      id(), sam, S.profile.peanuts,
    );
    db.prepare(
      `INSERT INTO wishes (id, user_id, title, url, claimed_by, claimed_by_name, claimed_at, position, created_at) VALUES
       (?, ?, ?, NULL, NULL, NULL, NULL, 1, ?),
       (?, ?, ?, NULL, NULL, NULL, NULL, 2, ?),
       (?, ?, ?, NULL, NULL, ?, ?, 1, ?),
       (?, ?, ?, NULL, NULL, NULL, NULL, 2, ?)`,
    ).run(
      id(), alex, S.wishes.tamper, now(),
      id(), alex, S.wishes.socks, now(),
      id(), sam, S.wishes.spa, S.wishes.claimedBy, now(), now(),
      id(), sam, S.wishes.knife, now(),
    );

    // ── Money ──
    const card = id();
    const cash = id();
    db.prepare(
      `INSERT INTO accounts (id, name, currency, kind, opening_balance, shared, color, position, created_by) VALUES
       (?, ?, 'EUR', 'card', 250000, 1, '#1F6E8C', 1, ?),
       (?, ?, 'EUR', 'cash', 12000, 1, '#4A7A5A', 2, ?)`,
    ).run(card, S.money.accounts.card, alex, cash, S.money.accounts.cash, alex);

    const groceries = id();
    const eatingOut = id();
    const household = id();
    const salary = id();
    db.prepare(
      `INSERT INTO categories (id, name, kind, color, position) VALUES
       (?, ?, 'expense', '#4A7A5A', 1),
       (?, ?, 'expense', '#B4654A', 2),
       (?, ?, 'expense', '#5A6A74', 3),
       (?, ?, 'income', '#2E6F8E', 4)`,
    ).run(
      groceries, S.money.categories.groceries,
      eatingOut, S.money.categories.eatingOut,
      household, S.money.categories.household,
      salary, S.money.categories.salary,
    );

    db.prepare(
      `INSERT INTO transactions (id, kind, occurred_on, account_id, amount, to_account_id, to_amount, category_id, note, place, created_by) VALUES
       (?, 'income',  ?, ?, 210000, NULL, NULL, ?, ?, NULL, ?),
       (?, 'expense', ?, ?, 6470,  NULL, NULL, ?, NULL, ?, ?),
       (?, 'expense', ?, ?, 3890,  NULL, NULL, ?, NULL, ?, ?),
       (?, 'expense', ?, ?, 5200,  NULL, NULL, ?, ?, ?, ?),
       (?, 'expense', ?, ?, 2340,  NULL, NULL, ?, ?, ?, ?),
       (?, 'transfer', ?, ?, 10000, ?, 10000, NULL, ?, NULL, ?)`,
    ).run(
      id(), day(-9), card, salary, S.money.notes.salary, alex,
      id(), day(-6), card, groceries, S.money.places.lidl, sam,
      id(), day(-3), cash, groceries, S.money.places.market, alex,
      id(), day(-2), card, eatingOut, S.money.notes.pizza, S.money.places.pizzeria, sam,
      id(), day(-1), card, household, S.money.notes.rollers, S.money.places.diy, alex,
      id(), day(-5), card, cash, S.money.notes.pocketCash, alex,
    );

    db.prepare(
      `INSERT INTO budgets (id, category_id, currency, month, amount) VALUES
       (?, ?, 'EUR', NULL, 40000),
       (?, ?, 'EUR', NULL, 15000)`,
    ).run(id(), groceries, id(), eatingOut);

    /*
      The recurring rules are also what the balance widget lives on, so
      the sample family has one of each case it can show: money arriving
      soon, a bill already due and waiting to be confirmed (the one the
      widget lets a visitor tick off), and a bill still ahead.

      The salary rule starts in the future on purpose. Anchored in the
      past it would leave months of unconfirmed pay days behind it — the
      sandbox is rebuilt daily and nobody ever confirms them — and the
      demo would open on stale bookkeeping instead of on next week.
    */
    db.prepare(
      `INSERT INTO recurring_transactions (id, title, kind, start_on, recurrence_rule, account_id, amount, category_id, auto_create, active) VALUES
       (?, ?, 'expense', ?, 'FREQ=MONTHLY;INTERVAL=1', ?, 95000, ?, 1, 1),
       (?, ?, 'income', ?, 'FREQ=MONTHLY;INTERVAL=1', ?, 210000, ?, 0, 1),
       (?, ?, 'expense', ?, 'FREQ=MONTHLY;INTERVAL=1', ?, 3450, ?, 0, 1),
       (?, ?, 'expense', ?, 'FREQ=MONTHLY;INTERVAL=1', ?, 3000, ?, 0, 1)`,
    ).run(
      id(), S.money.recurring.rent, day(-40), card, household,
      id(), S.money.recurring.salary, day(5), card, salary,
      id(), S.money.recurring.water, day(-3), card, household,
      id(), S.money.recurring.internet, day(2), card, household,
    );

    // ── Dashboard ──
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES
       ('goal.title', ?, ?),
       ('goal.date', ?, ?),
       ('goal.saved_label', ?, ?),
       ('goal.target', '300000', ?),
       ('goal.saved', '125000', ?),
       ('goal.currency', 'EUR', ?),
       ('money.default_currency', 'EUR', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(
      S.dashboard.goalTitle, now(),
      day(45), now(),
      S.dashboard.goalSavedLabel, now(),
      now(), now(), now(), now(),
    );
  });

  seed();
}
