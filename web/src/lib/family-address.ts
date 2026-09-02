import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * The family's address on the hosted service and whether it can still be
 * changed. Admin-only and hosted-only on the server; callers gate on both
 * before asking, or the request is a guaranteed 403.
 *
 * Fetched once per tab and shared, like the service state: the settings
 * card and the first-sign-in offer both read it, and one question must
 * not become two requests. A rename ends with a navigation to the new
 * origin, so the cached answer never outlives its truth.
 */
export interface FamilyAddress {
  slug: string;
  domain: string;
  /** The service's mail domain, or null when the service sends no mail. */
  mail: string | null;
  rename: {
    /** Whether the one rename is still on offer. */
    available: boolean;
    /** ISO deadline while the offer stands, null otherwise. */
    until: string | null;
    renamed: boolean;
  };
}

let pending: Promise<FamilyAddress> | null = null;

export function loadFamilyAddress(): Promise<FamilyAddress> {
  pending ??= api.get<FamilyAddress>('/family/address').catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}

/** The shared answer, or null until it arrives or when the request failed. */
export function useFamilyAddress(enabled: boolean): FamilyAddress | null {
  const [address, setAddress] = useState<FamilyAddress | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadFamilyAddress()
      .then((a) => {
        if (alive) setAddress(a);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled]);
  return enabled ? address : null;
}

/** The public URL a slug resolves to. */
export function familyUrl(slug: string, domain: string): string {
  return `https://${slug}.${domain}/`;
}
