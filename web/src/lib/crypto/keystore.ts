/*
  Where the family key lives between page loads (#214).

  A CryptoKey object can be stored in IndexedDB as is — structured clone
  keeps it a key, and the page reads it back without ever seeing bytes. So
  a reload or a PWA relaunch does not demand the password again, and an
  explicit "Lock" deletes the record. That is the whole persistence story;
  the password-derived wrap key is never stored anywhere.

  Storage is behind a small interface so tests (Node has no IndexedDB) and
  a browser that refuses site data (private mode, storage blocked) both
  fall back to memory: the hub then asks for the password on every load,
  which is degraded, not broken.
*/

export interface KeyRecord {
  familyKey: CryptoKey;
  /** Which family this key belongs to, so a key never crosses subdomains in one browser profile. */
  scope: string;
  savedAt: string;
}

export interface KeyBackend {
  get(): Promise<KeyRecord | null>;
  put(record: KeyRecord): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryBackend implements KeyBackend {
  private record: KeyRecord | null = null;
  async get() {
    return this.record;
  }
  async put(record: KeyRecord) {
    this.record = record;
  }
  async clear() {
    this.record = null;
  }
}

const DB_NAME = 'neiliro-keys';
const STORE = 'keys';
const RECORD_ID = 'family';

export class IndexedDbBackend implements KeyBackend {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB refused'));
    });
  }
  private async tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      });
    } finally {
      db.close();
    }
  }
  async get(): Promise<KeyRecord | null> {
    const rec = await this.tx<KeyRecord | undefined>('readonly', (s) => s.get(RECORD_ID));
    return rec ?? null;
  }
  async put(record: KeyRecord): Promise<void> {
    await this.tx('readwrite', (s) => s.put(record, RECORD_ID));
  }
  async clear(): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(RECORD_ID));
  }
}

export class KeyStore {
  constructor(
    private readonly backend: KeyBackend,
    /** The family's identity from the page's point of view: the hostname. */
    private readonly scope: string,
  ) {}

  /** The key if this browser holds one for this family, else null (locked). */
  async load(): Promise<CryptoKey | null> {
    try {
      const rec = await this.backend.get();
      if (!rec || rec.scope !== this.scope) return null;
      return rec.familyKey;
    } catch {
      return null;
    }
  }

  async save(familyKey: CryptoKey): Promise<void> {
    try {
      await this.backend.put({ familyKey, scope: this.scope, savedAt: new Date().toISOString() });
    } catch {
      // Storage refused: the key lives for this page load only. Degraded,
      // and the caller need not know.
    }
  }

  /** "Lock": forget the key on this device. The next load asks for the password. */
  async lock(): Promise<void> {
    try {
      await this.backend.clear();
    } catch {
      // Nothing to forget where nothing could be stored
    }
  }
}

export function defaultKeyStore(): KeyStore {
  const scope = typeof location !== 'undefined' ? location.hostname : 'test';
  const backend: KeyBackend = typeof indexedDB !== 'undefined' ? new IndexedDbBackend() : new MemoryBackend();
  return new KeyStore(backend, scope);
}
