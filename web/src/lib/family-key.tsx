import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api } from './api';
import { useAuth } from './auth';
import { setVault } from './vault';
import {
  currentWrapKey,
  defaultKeyStore,
  familyPublicKey,
  forgetWrapKey,
  fragmentFor,
  generateFamilyKey,
  generateRecoveryCode,
  handoffWrapKey,
  newHandoffSecret,
  recoveryWrapKey,
  unwrapFamilyKey,
  wrapFamilyKey,
  type KeyStore,
} from './crypto';

/*
  The family key's life in this browser (ADR 0001, #210).

  Four states. `absent` — the family has no key yet (an account from
  before the key existed, signed in from a kid account or without a wrap
  key; an adult with a wrap key never sees this, they create the key).
  `unlocked` — this device holds the key. `locked` — the family has a key
  and this device does not: the member's envelope died with a password
  reset, or the device is new. `loading` — not yet known.

  Three doors into `unlocked`: the member's own password envelope (opened
  with the wrap key sign-in left in memory), a handoff link from another
  member, the recovery code. Whichever opens, the key is saved on the
  device (crypto/keystore.ts) and — when a wrap key is at hand — re-wrapped
  into a fresh password envelope, so the next sign-in needs no door at all.

  Nothing is encrypted yet in phase 1: `locked` shows a notice, never a
  wall. The one screen that does block is the recovery code, once, at the
  moment the key is created — a code nobody wrote down is a family of one
  password away from losing every word.
*/

export type KeyStatus = 'loading' | 'absent' | 'unlocked' | 'locked';

export interface Handoff {
  id: string;
  envelope: string;
  created_at: string;
  created_by_name: string | null;
}

export interface KeysResponse {
  family: { public_key: string; created_at: string } | null;
  password_envelope: string | null;
  recovery_envelope: string | null;
  handoffs: Handoff[];
}

export const RECOVERY_PLACE = { kind: 'recovery', owner: 'family' } as const;
export const passwordPlace = (userId: string) => ({ kind: 'password', owner: userId });
export const handoffPlace = (userId: string) => ({ kind: 'handoff', owner: userId });
/** An invitation's envelope is bound to the invite, not to a member who does not exist yet (#212). */
export const invitePlace = (inviteId: string) => ({ kind: 'invite', owner: inviteId });

export class KeyDoorError extends Error {}

/** What to show a person when a door did not open. Door errors are dictionary keys; anything else is shown as is. */
export function doorMessage(err: unknown, fallback: string): string {
  if (err instanceof KeyDoorError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

interface KeysState {
  status: KeyStatus;
  familyKey: CryptoKey | null;
  /** A code just minted — shown once, acknowledged, then gone from memory. */
  freshRecoveryCode: string | null;
  acknowledgeRecoveryCode: () => void;
  /** Handoff links waiting for this member, to be opened on this device. */
  pendingHandoffs: Handoff[];
  unlockWithRecoveryCode: (code: string) => Promise<void>;
  unlockWithHandoff: (handoffId: string, secret: string) => Promise<void>;
  /** A re-admission link for another member: the key wrapped under a secret only the link carries. */
  handoffLinkFor: (userId: string) => Promise<string>;
  /** Mint a new recovery code; the old one stops working. Returned once. */
  newRecoveryCode: () => Promise<string>;
  /** Forget the key on this device — the next sign-in derives its way back in. */
  lock: () => Promise<void>;
  refresh: () => Promise<void>;
}

const KeysContext = createContext<KeysState | null>(null);

export function KeyProvider({ children, store }: { children: ReactNode; store?: KeyStore }) {
  const { user } = useAuth();
  const keystore = useMemo(() => store ?? defaultKeyStore(), [store]);
  const [status, setStatus] = useState<KeyStatus>('loading');
  const [familyKey, setFamilyKey] = useState<CryptoKey | null>(null);
  const [freshRecoveryCode, setFreshRecoveryCode] = useState<string | null>(null);
  const [pendingHandoffs, setPendingHandoffs] = useState<Handoff[]>([]);
  // A key created in one run of sync must not be created twice by a re-render racing it
  const creating = useRef(false);

  const userId = user?.id ?? null;
  const role = user?.role ?? null;
  const mustChange = Boolean(user?.must_change_password);

  const hold = useCallback(
    async (key: CryptoKey) => {
      await keystore.save(key);
      setFamilyKey(key);
      setStatus('unlocked');
    },
    [keystore],
  );

  /** Wrap the held key under the wrap key sign-in left behind, if any, and store it as this member's envelope. */
  const writeOwnEnvelope = useCallback(
    async (key: CryptoKey) => {
      const wrap = currentWrapKey();
      if (!wrap || !userId) return;
      await api.put('/keys/envelope', { envelope: await wrapFamilyKey(key, wrap, passwordPlace(userId)) });
    },
    [userId],
  );

  /** Create the family key. False when another browser beat this one to it. */
  const create = useCallback(
    async (wrap: CryptoKey): Promise<boolean> => {
      if (creating.current || !userId) return false;
      creating.current = true;
      try {
        const key = await generateFamilyKey();
        const code = generateRecoveryCode();
        try {
          await api.post('/keys', {
            public_key: await familyPublicKey(key),
            envelope: await wrapFamilyKey(key, wrap, passwordPlace(userId)),
            recovery_envelope: await wrapFamilyKey(key, await recoveryWrapKey(code), RECOVERY_PLACE),
          });
        } catch (err) {
          // Somebody else's browser got there first: their key is the family's
          if (err instanceof ApiError && err.status === 409) return false;
          throw err;
        }
        await hold(key);
        setFreshRecoveryCode(code);
        return true;
      } finally {
        creating.current = false;
      }
    },
    [hold, userId],
  );

  const sync = useCallback(async () => {
    if (!userId || mustChange) {
      setStatus('loading');
      return;
    }
    const stored = await keystore.load();
    let keys: KeysResponse;
    try {
      keys = await api.get<KeysResponse>('/keys');
    } catch {
      // Offline or a server that predates the key: what the device holds is the truth for now
      if (stored) {
        setFamilyKey(stored);
        setStatus('unlocked');
      } else {
        setStatus('loading');
      }
      return;
    }
    setPendingHandoffs(keys.handoffs);
    const wrap = currentWrapKey();

    if (!keys.family) {
      if (!wrap || role === 'kid') {
        setFamilyKey(null);
        setStatus('absent');
        return;
      }
      if (await create(wrap)) return;
      // Another browser created it between the two requests: read again, the
      // envelopes below now exist
      keys = await api.get<KeysResponse>('/keys');
    }

    if (stored) {
      setFamilyKey(stored);
      setStatus('unlocked');
      // A reset elsewhere killed the envelope while this device kept the key:
      // the password just typed can wrap it again, no door needed
      if (!keys.password_envelope && wrap) await writeOwnEnvelope(stored);
      return;
    }

    if (keys.password_envelope && wrap) {
      try {
        await hold(await unwrapFamilyKey(keys.password_envelope, wrap, passwordPlace(userId)));
        return;
      } catch {
        // An envelope this password does not open: treated as no envelope
      }
    }
    setFamilyKey(null);
    setStatus('locked');
  }, [create, hold, keystore, mustChange, role, userId, writeOwnEnvelope]);

  useEffect(() => {
    void sync();
  }, [sync]);

  // The codec (lib/api.ts → lib/codec.ts) cannot read a React context, so
  // the key's state is mirrored into lib/vault.ts. "The family has a key"
  // is true for every state but `absent` — while the answer is still
  // loading a write must refuse rather than fall through to plaintext.
  useEffect(() => {
    setVault({ key: familyKey, familyHasKey: status !== 'absent' });
  }, [familyKey, status]);

  const unlockWithRecoveryCode = useCallback(
    async (code: string) => {
      const keys = await api.get<KeysResponse>('/keys');
      if (!keys.recovery_envelope) throw new KeyDoorError('The family has no recovery code');
      let key: CryptoKey;
      try {
        key = await unwrapFamilyKey(keys.recovery_envelope, await recoveryWrapKey(code), RECOVERY_PLACE);
      } catch {
        throw new KeyDoorError('That is not the recovery code');
      }
      await hold(key);
      await writeOwnEnvelope(key);
    },
    [hold, writeOwnEnvelope],
  );

  const unlockWithHandoff = useCallback(
    async (handoffId: string, secret: string) => {
      if (!userId) throw new KeyDoorError('Sign in first');
      const keys = await api.get<KeysResponse>('/keys');
      const handoff = keys.handoffs.find((h) => h.id === handoffId);
      if (!handoff) throw new KeyDoorError('This link has been used or revoked — ask for a new one');
      let key: CryptoKey;
      try {
        key = await unwrapFamilyKey(handoff.envelope, await handoffWrapKey(secret), handoffPlace(userId));
      } catch {
        throw new KeyDoorError('This link does not open the key — ask for a new one');
      }
      await hold(key);
      await writeOwnEnvelope(key);
      // The handoff has done its job. Writing the envelope retires it too,
      // but a browser without a wrap key (a reload, Google-only) writes none
      await api.delete(`/keys/handoff/${handoffId}`).catch(() => {});
      setPendingHandoffs([]);
    },
    [hold, userId, writeOwnEnvelope],
  );

  const handoffLinkFor = useCallback(
    async (targetId: string) => {
      if (!familyKey) throw new KeyDoorError('This device does not hold the key');
      const secret = newHandoffSecret();
      const envelope = await wrapFamilyKey(familyKey, await handoffWrapKey(secret), handoffPlace(targetId));
      const { id } = await api.post<{ id: string }>('/keys/handoff', { user_id: targetId, envelope });
      return `${window.location.origin}/readmit?handoff=${id}${fragmentFor(secret)}`;
    },
    [familyKey],
  );

  const newRecoveryCode = useCallback(async () => {
    if (!familyKey) throw new KeyDoorError('This device does not hold the key');
    const code = generateRecoveryCode();
    await api.post('/keys/recovery', {
      recovery_envelope: await wrapFamilyKey(familyKey, await recoveryWrapKey(code), RECOVERY_PLACE),
    });
    return code;
  }, [familyKey]);

  // Signing out forgets the key on this device (lib/auth.tsx, logout) — not
  // an unmount effect here: in development React mounts effects twice, and
  // a cleanup that forgets the wrap key would run right after sign-in.
  const lock = useCallback(async () => {
    await keystore.lock();
    forgetWrapKey();
    setFamilyKey(null);
    setStatus((s) => (s === 'absent' ? s : 'locked'));
  }, [keystore]);

  const acknowledgeRecoveryCode = useCallback(() => setFreshRecoveryCode(null), []);

  const value = useMemo<KeysState>(
    () => ({
      status,
      familyKey,
      freshRecoveryCode,
      acknowledgeRecoveryCode,
      pendingHandoffs,
      unlockWithRecoveryCode,
      unlockWithHandoff,
      handoffLinkFor,
      newRecoveryCode,
      lock,
      refresh: sync,
    }),
    [
      status,
      familyKey,
      freshRecoveryCode,
      acknowledgeRecoveryCode,
      pendingHandoffs,
      unlockWithRecoveryCode,
      unlockWithHandoff,
      handoffLinkFor,
      newRecoveryCode,
      lock,
      sync,
    ],
  );

  return <KeysContext.Provider value={value}>{children}</KeysContext.Provider>;
}

export function useKeys(): KeysState {
  const ctx = useContext(KeysContext);
  if (!ctx) throw new Error('useKeys called outside KeyProvider');
  return ctx;
}
