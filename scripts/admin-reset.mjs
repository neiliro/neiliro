#!/usr/bin/env node
/**
 * Issue a new password to the admin.
 *
 * The password is stored as a hash and can't be recovered — only replaced.
 * Before this script, the only way into the system with a lost password
 * was deleting the database, i.e. losing everything.
 *
 * Usage: npm run admin:reset
 *        npm run admin:reset -- denis@hub.local
 * In Docker: docker compose exec app node scripts/admin-reset.mjs
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '..', 'server', 'dist', 'lib', 'password.js');
if (!existsSync(dist)) {
  console.error('The server is not built. First: npm run build');
  process.exit(1);
}
const { generatePassword, hashPassword } = await import(dist);
// The browser sends a key derived from the password, not the password
// (ADR 0001); a password picked here is stored as the hash of that key.
const { deriveAuthKey, newKdfSalt } = await import(resolve(import.meta.dirname, '..', 'server', 'dist', 'lib', 'kdf.js'));

const dataDir = resolve(process.env.DATA_DIR ?? join(homedir(), '.family-hub'));
const dbPath = join(dataDir, 'hub.db');

if (!existsSync(dbPath)) {
  console.error(`No database at: ${dbPath}`);
  console.error('Run the app at least once — it will create the database and print the password itself.');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const wanted = process.argv[2];
const user = wanted
  ? db.prepare('SELECT id, email, name, role, kdf_salt FROM users WHERE lower(email) = ?').get(wanted.toLowerCase())
  : db.prepare("SELECT id, email, name, role, kdf_salt FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();

if (!user) {
  const all = db.prepare('SELECT email, role FROM users ORDER BY role, email').all();
  console.error(wanted ? `No account ${wanted}.` : 'No admin in the database.');
  if (all.length > 0) {
    console.error('These accounts exist:');
    for (const u of all) console.error(`  ${u.email} · ${u.role}`);
  } else {
    console.error('The database has no users at all — delete hub.db and start the app again.');
  }
  process.exit(1);
}

const password = generatePassword();
// An account without a salt (never signed in since the split) gets one now
const salt = user.kdf_salt ?? newKdfSalt();
const hash = await hashPassword(await deriveAuthKey(password, salt));

// TOTP is cleared too: this script is the lockout escape hatch, and a
// lost authenticator is exactly the lockout it exists to escape.
db.prepare(
  `UPDATE users SET password_hash = ?, kdf_version = 1, kdf_salt = ?, must_change_password = 1, disabled_at = NULL,
                    totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL
    WHERE id = ?`,
).run(hash, salt, user.id);

// The key envelope wrapped under the old password is dead to the new one
// (ADR 0001, #210): this script restores access, not the family key. The
// member gets the key back from another member (re-admission link in
// Settings → People) or with the recovery code. Older databases have no
// such table yet — migrations run when the app starts.
let keyLost = false;
try {
  keyLost =
    db
      .prepare(
        `UPDATE key_envelopes SET retired_at = ? WHERE user_id = ? AND kind = 'password' AND retired_at IS NULL`,
      )
      .run(new Date().toISOString(), user.id).changes > 0;
} catch {
  // no key_envelopes table: a database from before the family key existed
}

// Close previous sessions: if the password is being reset, they can't be trusted
const closed = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id).changes;
db.close();

const line = '─'.repeat(64);
const out = [
  '',
  line,
  `  New password for ${user.name} (${user.email})`,
  '',
  `    Login:    ${user.email}`,
  `    Password: ${password}`,
  '',
  '  The password is shown once and must be changed on first login.',
];
if (closed > 0) {
  out.push(`  Previous sessions closed: ${closed} — you will have to sign in again everywhere.`);
}
if (keyLost) {
  out.push(
    '',
    '  This restores access, not the family key: the new password cannot open',
    '  the key envelope the old one protected. After signing in, get the key',
    '  back from another member (Settings → People → Re-admit) or enter the',
    "  family's recovery code. Encrypted content stays unreadable until then.",
  );
}
out.push(line, '');
console.log(out.join('\n'));
