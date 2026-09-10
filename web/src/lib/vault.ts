import { decryptField, encryptField, isEncrypted, type FieldPlace } from './crypto/envelope';
import { isSealed, openSealedField } from './crypto/seal';

/*
  The family key as the codec sees it (ADR 0001, phase 2).

  lib/family-key.tsx owns the key's life — creating, opening, locking. This
  module is the one place outside React that needs to know whether a key is
  at hand: lib/api.ts seals and opens fields on every request, and a fetch
  helper cannot read a React context. So the provider mirrors its state here.

  Three states matter to a write:
    - a key is here          → seal the listed fields
    - the family has no key  → write plaintext, as before the key existed
    - the family has a key, this device does not (locked) → REFUSE. Writing
      plaintext over a family's encrypted note would be the one way to undo
      the whole design from a single unlocked-looking tab.

  Reads never refuse: an encrypted value with no key here becomes a
  placeholder, so a locked hub still shows its structure — dates, folders,
  who wrote what — and never an error page.
*/

let familyKey: CryptoKey | null = null;
let familyHasKey = false;

/*
  Readiness (#249). On a fresh page load the pages ask for their data the
  moment the session is known — in parallel with the provider reading the
  key from IndexedDB. A response decoded in that gap has no key to open it
  with, comes back as placeholders, and nothing re-decodes when the key
  lands a few milliseconds later. So the codec waits, once per load, until
  the provider says it has settled: unlocked, locked or absent — any answer
  but "still looking". A bounded wait: offline, or a provider that never
  reports, must not hang every request forever.
*/
let settled = true;
let waiters: (() => void)[] = [];
const READY_TIMEOUT_MS = 2_500;

export function setVault(state: { key: CryptoKey | null; familyHasKey: boolean; settled?: boolean }): void {
  familyKey = state.key;
  familyHasKey = state.familyHasKey;
  if (state.settled === false) {
    settled = false;
    return;
  }
  settled = true;
  for (const wake of waiters) wake();
  waiters = [];
}

/** Resolves once the provider has settled the key's state, or after a bounded wait. */
export function vaultReady(): Promise<void> {
  if (settled) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, READY_TIMEOUT_MS);
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function vaultKey(): CryptoKey | null {
  return familyKey;
}

/** Whether the family has a key at all — a locked device answers true with no key at hand. */
export function hasFamilyKey(): boolean {
  return familyHasKey;
}

/** What an encrypted value reads as on a device that cannot open it. */
export const LOCKED_TEXT = '••••••';

export class VaultLockedError extends Error {
  constructor() {
    super('This device does not hold the family key — unlock it before editing');
  }
}

type Row = Record<string, unknown>;

/** Seal the listed string fields of `row` in place-copy; null and undefined pass. */
export async function sealFields<T extends Row>(table: string, id: string, row: T, columns: readonly string[]): Promise<T> {
  const out: Row = { ...row };
  for (const column of columns) {
    const value = row[column];
    if (typeof value !== 'string') continue;
    if (isEncrypted(value)) continue; // already an envelope (a value passed through unchanged)
    if (familyKey) {
      out[column] = await encryptField(familyKey, value, { table, column, id });
    } else if (familyHasKey) {
      throw new VaultLockedError();
    }
    // no key anywhere: plaintext, the pre-key behaviour
  }
  return out as T;
}

/** Open the listed fields; legacy plaintext passes through; no key → placeholder. */
export async function openFields<T extends Row>(table: string, id: string, row: T, columns: readonly string[]): Promise<T> {
  const out: Row = { ...row };
  for (const column of columns) {
    const value = row[column];
    if (typeof value !== 'string' || !isEncrypted(value)) continue;
    if (!familyKey) {
      out[column] = LOCKED_TEXT;
      continue;
    }
    try {
      const place = { table, column, id } satisfies FieldPlace;
      // A value the server sealed to the family public key (#223) opens with
      // the private half derived from the same family key
      out[column] = isSealed(value) ? await openSealedField(familyKey, value, place) : await decryptField(familyKey, value, place);
    } catch {
      // A value this key does not open (moved between rows, another family's
      // export): placeholder, not a crash — the row's structure is still real
      out[column] = LOCKED_TEXT;
    }
  }
  return out as T;
}

export async function openRows<T extends Row>(
  table: string,
  rows: T[],
  columns: readonly string[],
  idOf: (row: T) => string = (row) => String(row['id']),
): Promise<T[]> {
  return Promise.all(rows.map((row) => openFields(table, idOf(row), row, columns)));
}
