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

/** Null until the answer arrives; callers render the neutral case meanwhile. */
export function useServiceState(): ServiceState | null {
  const [state, setState] = useState<ServiceState | null>(null);

  useEffect(() => {
    let alive = true;
    load()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
