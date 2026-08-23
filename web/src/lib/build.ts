/*
  Who this build is, and where to go with it.

  The version and commit are baked in by vite.config.ts. They exist for
  one question that has cost real time twice: is the thing in front of me
  actually the thing that was deployed? A long-lived kiosk tab or a phone
  shortcut can serve a bundle from weeks ago, and nothing on screen used
  to say so.

  Both are shown only behind the sign-in screen. The health endpoint
  withholds the version from the public internet on purpose — a footer
  that hands it to every scanner would undo that decision for no gain.
*/
export const VERSION = __APP_VERSION__;

/** Short commit; empty when built from source rather than an image. */
export const BUILD_SHA = __BUILD_SHA__;

/**
 * Upstream, not the running host: a fork's bug reports still belong with
 * the project, and a self-hoster reading these links wants the source
 * they installed from.
 */
export const REPO_URL = 'https://github.com/neiliro/neiliro';
export const ISSUES_URL = `${REPO_URL}/issues`;
