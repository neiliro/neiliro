import { registerSW } from 'virtual:pwa-register';
import { serviceState } from './service';

/*
  Service-worker registration and update detection (#9).

  Why this exists at all: a running SPA re-reads index.html only on a
  full navigation, so a kiosk tab that stays open for weeks — and a
  standalone home-screen app between relaunches — keeps running
  whatever bundle it started with. The worker's update lifecycle fixes
  that: a deploy produces a new worker, the browser spots it, and we
  offer a reload instead of waiting for someone to notice by accident.

  Not registered in demo mode: sandboxes are per-visitor while the
  SW cache is per-browser — cached API reads would leak one sandbox's
  content into the next visit.
*/

let updateServiceWorker: ((reload?: boolean) => Promise<void>) | null = null;
let started = false;
let lastInteraction = Date.now();

/** How long a tab must sit untouched before an update applies itself. */
const IDLE_RELOAD_MS = 15 * 60_000;

export async function setupPwa(onNeedRefresh: () => void): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  // The shell remounts on login/logout (and twice under StrictMode) —
  // the worker and its listeners must exist once per page
  if (started) return;
  started = true;

  try {
    // Shares the app's one lookup rather than adding a second (lib/service.ts)
    const state = await serviceState();
    if (state.demo) return;
  } catch {
    // The server is unreachable — the cached shell may still be useful,
    // and a registered worker is exactly what makes that possible
  }

  for (const event of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(event, () => {
      lastInteraction = Date.now();
    });
  }

  updateServiceWorker = registerSW({
    onNeedRefresh() {
      onNeedRefresh();

      // The kiosk case: nobody clicks a wall display, so a waiting
      // update applies itself once the tab has been idle for a while.
      // A recently touched tab keeps the toast and the person decides —
      // an auto-reload mid-edit would eat a form.
      const timer = setInterval(() => {
        if (Date.now() - lastInteraction >= IDLE_RELOAD_MS) {
          clearInterval(timer);
          void updateServiceWorker?.(true);
        }
      }, 60_000);
    },
  });
}

/** The toast button: activate the waiting worker and reload. */
export function applyUpdate(): void {
  void updateServiceWorker?.(true);
}
