import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * What kind of install this is — hosted or not, which sign-in doors exist.
 *
 * These are properties of the process, not of the session: they cannot
 * change while the tab is open, so the answer is fetched once and shared.
 * Two components asking the same question must not cost two requests —
 * that is how a footer link turns into a poll.
 */
export interface ServiceState {
  initialized: boolean;
  google: boolean;
  demo: boolean;
  hosted: boolean;
  password_reset: boolean;
}

let pending: Promise<ServiceState> | null = null;

function load(): Promise<ServiceState> {
  // A failed answer is not cached: the next mount should ask again rather
  // than inherit one bad moment for the life of the tab.
  pending ??= api.get<ServiceState>('/auth/state').catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}

export interface ServiceAnswer {
  /** What the process says about itself — null while that is still unknown. */
  state: ServiceState | null;
  /**
   * False only while the request is in flight; true once it has succeeded
   * *or* failed. A caller that must pick a safe default on failure needs to
   * tell "not yet" from "never" — `state` alone cannot say which.
   */
  settled: boolean;
}

/**
 * The shared answer. `state` is null until it arrives, so a caller renders
 * nothing rather than guessing — guessing is how a footer link points at
 * the wrong door for a round trip.
 */
export function useServiceState(): ServiceAnswer {
  const [answer, setAnswer] = useState<ServiceAnswer>({ state: null, settled: false });

  useEffect(() => {
    let alive = true;
    load()
      .then((s) => {
        if (alive) setAnswer({ state: s, settled: true });
      })
      .catch(() => {
        if (alive) setAnswer({ state: null, settled: true });
      });
    return () => {
      alive = false;
    };
  }, []);

  return answer;
}

/**
 * The same answer outside React, sharing the same request. Callers that
 * only need one flag still must not add a second round trip for it.
 */
export function serviceState(): Promise<ServiceState> {
  return load();
}
