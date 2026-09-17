import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    /*
      Never the compiled copies under dist/.

      Vitest 5 trimmed its default exclude to node_modules and .git —
      dist/ used to be in it. On any machine that has run a build (the
      release scripts, a Docker build, a developer checking a bundle)
      every suite then ran twice: once from src/, once from the .js
      beside it. Two of them fail outright, because they read the source
      they are about (env.documented.test reads env.ts, the public-surface
      snapshot reads auth.ts) and those are .ts files that never reach
      dist. The rest silently test whatever the last build left behind,
      which may be weeks old.

      CI cannot catch this: it installs and tests without ever building,
      so dist/ does not exist there. It lands on the person who builds.
    */
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
  },
});
