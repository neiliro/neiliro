import { useEffect, useState } from 'react';
import { api } from './api';
import { lang } from './i18n';

/**
 * The family's plan on the hosted service (#265): writable or read-only,
 * until when, and where to subscribe. Any member may ask; the server
 * derives the answer from the registry on every request, so the tab's
 * copy is only a snapshot — a write that comes back 402 is the truth.
 *
 * Fetched once per tab and shared, like the family address: the banner in
 * the shell and the Settings card both read it. `refreshPlan()` drops the
 * snapshot after a subscription so the next reader asks again.
 */
export interface FamilyPlan {
  state: 'trial' | 'active' | 'grace' | 'canceling' | 'legacy_free' | 'read_only';
  read_only: boolean;
  /** ISO: when the current writable state ends, or when read-only began. */
  until: string | null;
  /** ISO: when the data is removed, once read-only. */
  delete_at: string | null;
  subscribed: boolean;
  /** Free days earned through referrals and counted into `until` (#336). */
  bonus_days: number;
  /** The checkout page on the apex, already naming this family. */
  checkout_url: string;
  /** Whether a customer-portal link can be minted. */
  portal: boolean;
}

let pending: Promise<FamilyPlan> | null = null;

export function loadPlan(): Promise<FamilyPlan> {
  pending ??= api.get<FamilyPlan>(`/family/plan${lang === 'ru' ? '?lang=ru' : ''}`).catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}

export function refreshPlan(): void {
  pending = null;
}

/** The shared answer, or null until it arrives, when disabled, or when the request failed. */
export function usePlan(enabled: boolean): FamilyPlan | null {
  const [plan, setPlan] = useState<FamilyPlan | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadPlan()
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled]);
  return enabled ? plan : null;
}

/** A plan's date for a sentence: the day only. */
export function planDay(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
