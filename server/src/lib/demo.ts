import { randomUUID } from 'node:crypto';
import { db, now, today } from '../db/index.js';
import { hashPassword } from './password.js';

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

/** Fills the current context's database with an example family. Expects an empty database. */
export async function seedDemo(): Promise<void> {
  const n = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
  if (n > 0) return;

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
       (?, 'alex@neiliro.example', 'Alex', 'admin', ?, '#2E6F8E', ?),
       (?, 'sam@neiliro.example', 'Sam', 'member', ?, '#B4654A', ?)`,
    ).run(alex, passwordHash, now(), sam, passwordHash, now());

    // ── Projects and tasks ──
    const home = id();
    const trip = id();
    db.prepare(
      `INSERT INTO projects (id, title, description, color, position, created_by) VALUES
       (?, 'Home improvement', 'Everything the house keeps asking for', '#4A7A5A', 1, ?),
       (?, 'Summer trip', 'Two weeks along the coast', '#B4654A', 2, ?)`,
    ).run(home, alex, trip, alex);

    const paint = id();
    // Descriptions on the dated ones: the wide agenda shows a line of
    // the description, and it should have something to show
    db.prepare(
      `INSERT INTO tasks (id, project_id, level, title, description, status, priority, due_date, assignee_id, position, created_by) VALUES
       (?, ?, 0, 'Repaint the hallway', NULL, 'in_progress', 'normal', ?, ?, 1, ?),
       (?, ?, 1, 'Pick the colour together', NULL, 'done', 'normal', NULL, ?, 2, ?),
       (?, ?, 1, 'Buy paint and tape', 'Two cans of Misty Sage and the wide tape', 'todo', 'high', ?, ?, 3, ?),
       (?, ?, 0, 'Fix the dripping tap', 'The kitchen one — the washer kit is in the garage', 'todo', 'urgent', ?, ?, 4, ?),
       (?, ?, 0, 'Book the ferry', 'The evening crossing, the cabin with a window', 'todo', 'high', ?, ?, 5, ?),
       (?, ?, 0, 'Renew passports', NULL, 'backlog', 'normal', NULL, NULL, 6, ?)`,
    ).run(
      paint, home, day(5), alex, alex,
      id(), home, sam, alex,
      id(), home, day(2), alex, alex,
      id(), home, day(0), sam, sam,
      id(), trip, day(12), sam, sam,
      id(), trip, alex,
    );
    // Showcases the expected-finish date (#7): the due date is past, but
    // the repair is known to take a week — the task is not overdue
    db.prepare(
      `INSERT INTO tasks (id, project_id, level, title, status, priority, due_date, expected_date,
                          assignee_id, position, created_by)
       VALUES (?, ?, 0, 'Coffee machine in repair', 'in_progress', 'normal', ?, ?, ?, 7, ?)`,
    ).run(id(), home, day(-3), day(4), alex, alex);
    // Nesting: "buy paint" goes under the repaint story
    db.prepare(
      `UPDATE tasks SET parent_id = ?, level = 1 WHERE title IN ('Pick the colour together', 'Buy paint and tape')`,
    ).run(paint);

    // ── Notes ──
    const recipes = id();
    db.prepare(
      `INSERT INTO folders (id, name, position) VALUES (?, 'Recipes', 1)`,
    ).run(recipes);
    db.prepare(
      `INSERT INTO notes (id, title, body_md, folder_id, owner_id, pinned) VALUES
       (?, 'Shopping list', '- Milk\n- Eggs\n- Coffee beans\n- Paint tape (see [[Repaint the hallway]])\n- Something nice for Friday', NULL, ?, 1),
       (?, 'Pizza dough', '**500 g** flour · 325 ml water · 10 g salt · 3 g yeast\n\nKnead, rest overnight in the fridge, bake as hot as the oven goes.', ?, ?, 0),
       (?, 'House rules for guests', 'Wi-Fi: *neiliro / pizzafriday*\n\nCoffee machine: one scoop, button, patience.', NULL, ?, 0)`,
    ).run(id(), alex, id(), recipes, sam, id(), alex);

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
       (?, ?, 'Movie night', 'The new Miyazaki — tickets are in the mail', 'Odeon', ?, ?, 0, NULL, NULL, ?),
       (?, ?, 'Gym', 'Legs and the sauna after', 'Iron Temple', ?, ?, 0, 'FREQ=WEEKLY;INTERVAL=1', NULL, ?),
       (?, ?, 'Dentist', 'The crown on the left, ask about a night guard', 'Dr. Molar', ?, ?, 0, NULL, 1, ?),
       (?, ?, 'Grandma''s birthday', NULL, NULL, ?, ?, 1, 'FREQ=YEARLY;INTERVAL=1', 7, ?)`,
    ).run(
      movie, shared, `${day(0)}T20:00`, `${day(0)}T22:30`, sam,
      gym, shared, `${day(1)}T18:30`, `${day(1)}T20:00`, alex,
      dentist, shared, `${day(3)}T11:00`, `${day(3)}T11:45`, sam,
      birthday, shared, day(9), day(9), alex,
    );
    db.prepare(
      `INSERT INTO event_participants (event_id, user_id) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)`,
    ).run(gym, alex, gym, sam, dentist, sam, movie, alex, movie, sam);

    // ── Family mail ──
    // A believable paperwork inbox; one message is already a task, so
    // the mail → task link is visible without clicking anything
    const school = id();
    db.prepare(
      `INSERT INTO mail_messages (id, kind, from_address, from_name, to_address, subject,
                                  body_text, sent_at, received_at, read_at) VALUES
       (?, 'in', 'office@riverside-school.example', 'Riverside School', 'family@neiliro.example',
        'Parent-teacher evening on Thursday',
        'Dear parents,' || char(10) || char(10) ||
        'We look forward to seeing you this Thursday at 17:30 in the main hall. Please confirm your attendance by replying to this email.' || char(10) || char(10) ||
        'Riverside School office', ?, ?, NULL),
       (?, 'in', 'no-reply@citypower.example', 'City Power & Light', 'family@neiliro.example',
        'Your electricity bill for July',
        'Your bill for July is ready: 64.20 EUR, due by the 25th.' || char(10) ||
        'The detailed statement is attached as a PDF in the original message.', ?, ?, ?)`,
    ).run(school, day(-1) + ' 09:15', day(-1) + ' 09:15', id(), day(-4) + ' 08:00', day(-4) + ' 08:00', day(-3) + ' 20:11');

    const schoolTask = id();
    db.prepare(
      `INSERT INTO tasks (id, project_id, level, title, description, status, priority, due_date, assignee_id, position, created_by)
       VALUES (?, '00000000-0000-4000-8000-000000000001', 0, 'Confirm parent-teacher evening', 'Reply to the school before Thursday', 'todo', 'normal', ?, ?, 8, ?)`,
    ).run(schoolTask, day(1), sam, alex);
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
       VALUES (?, ?, 'Alex', ?, ?, 1, 'FREQ=YEARLY', ?, ?, ?, ?),
              (?, ?, 'Sam', ?, ?, 1, 'FREQ=YEARLY', ?, ?, ?, ?)`,
    ).run(
      id(), shared, alexBirthday, alexBirthday, 1988, alex, now(), now(),
      id(), shared, samBirthday, samBirthday, 1990, sam, now(), now(),
    );
    db.prepare(
      `INSERT INTO profile_entries (id, user_id, kind, label, value, position) VALUES
       (?, ?, 'preference', 'Shoes', '44', 1),
       (?, ?, 'preference', 'Coffee', 'flat white, no sugar', 2),
       (?, ?, 'preference', 'Shoes', '38', 1),
       (?, ?, 'preference', 'Tea', 'Earl Grey', 2),
       (?, ?, 'preference', 'Flowers', 'tulips, never lilies', 3),
       (?, ?, 'allergy', 'peanuts', NULL, 4)`,
    ).run(id(), alex, id(), alex, id(), sam, id(), sam, id(), sam, id(), sam);
    db.prepare(
      `INSERT INTO wishes (id, user_id, title, url, claimed_by, claimed_by_name, claimed_at, position, created_at) VALUES
       (?, ?, 'A proper espresso tamper', NULL, NULL, NULL, NULL, 1, ?),
       (?, ?, 'Wool hiking socks', NULL, NULL, NULL, NULL, 2, ?),
       (?, ?, 'Weekend at a spa', NULL, NULL, 'Grandma Vera', ?, 1, ?),
       (?, ?, 'A very sharp kitchen knife', NULL, NULL, NULL, NULL, 2, ?)`,
    ).run(
      id(), alex, now(),
      id(), alex, now(),
      id(), sam, now(), now(),
      id(), sam, now(),
    );

    // ── Money ──
    const card = id();
    const cash = id();
    db.prepare(
      `INSERT INTO accounts (id, name, currency, kind, opening_balance, shared, color, position, created_by) VALUES
       (?, 'Joint card', 'EUR', 'card', 250000, 1, '#1F6E8C', 1, ?),
       (?, 'Cash', 'EUR', 'cash', 12000, 1, '#4A7A5A', 2, ?)`,
    ).run(card, alex, cash, alex);

    const groceries = id();
    const eatingOut = id();
    const household = id();
    const salary = id();
    db.prepare(
      `INSERT INTO categories (id, name, kind, color, position) VALUES
       (?, 'Groceries', 'expense', '#4A7A5A', 1),
       (?, 'Eating out', 'expense', '#B4654A', 2),
       (?, 'Household', 'expense', '#5A6A74', 3),
       (?, 'Salary', 'income', '#2E6F8E', 4)`,
    ).run(groceries, eatingOut, household, salary);

    db.prepare(
      `INSERT INTO transactions (id, kind, occurred_on, account_id, amount, to_account_id, to_amount, category_id, note, place, created_by) VALUES
       (?, 'income',  ?, ?, 210000, NULL, NULL, ?, 'Salary', NULL, ?),
       (?, 'expense', ?, ?, 6470,  NULL, NULL, ?, NULL, 'Lidl', ?),
       (?, 'expense', ?, ?, 3890,  NULL, NULL, ?, NULL, 'Market', ?),
       (?, 'expense', ?, ?, 5200,  NULL, NULL, ?, 'Pizza night', 'Napoli', ?),
       (?, 'expense', ?, ?, 2340,  NULL, NULL, ?, 'Paint rollers', 'DIY store', ?),
       (?, 'transfer', ?, ?, 10000, ?, 10000, NULL, 'Pocket cash', NULL, ?)`,
    ).run(
      id(), day(-9), card, salary, alex,
      id(), day(-6), card, groceries, sam,
      id(), day(-3), cash, groceries, alex,
      id(), day(-2), card, eatingOut, sam,
      id(), day(-1), card, household, alex,
      id(), day(-5), card, cash, alex,
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
       (?, 'Rent', 'expense', ?, 'FREQ=MONTHLY;INTERVAL=1', ?, 95000, ?, 1, 1),
       (?, 'Salary', 'income', ?, 'FREQ=MONTHLY;INTERVAL=1', ?, 210000, ?, 0, 1),
       (?, 'Water bill', 'expense', ?, 'FREQ=MONTHLY;INTERVAL=1', ?, 3450, ?, 0, 1),
       (?, 'Internet', 'expense', ?, 'FREQ=MONTHLY;INTERVAL=1', ?, 3000, ?, 0, 1)`,
    ).run(
      id(), day(-40), card, household,
      id(), day(5), card, salary,
      id(), day(-3), card, household,
      id(), day(2), card, household,
    );

    // ── Dashboard ──
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES
       ('goal.title', 'Trip to Japan', ?),
       ('goal.date', ?, ?),
       ('goal.saved_label', 'Saved for the trip', ?),
       ('goal.target', '300000', ?),
       ('goal.saved', '125000', ?),
       ('goal.currency', 'EUR', ?),
       ('money.default_currency', 'EUR', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(now(), day(45), now(), now(), now(), now(), now(), now());
  });

  seed();
}
