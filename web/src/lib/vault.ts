import { decryptField, encryptField, isEncrypted, type FieldPlace } from './crypto/envelope';

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

export function setVault(state: { key: CryptoKey | null; familyHasKey: boolean }): void {
  familyKey = state.key;
  familyHasKey = state.familyHasKey;
}

export function vaultKey(): CryptoKey | null {
  return familyKey;
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
      out[column] = await decryptField(familyKey, value, { table, column, id } satisfies FieldPlace);
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
